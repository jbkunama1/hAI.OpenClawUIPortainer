const crypto = require('crypto');
const fetch = require('node-fetch');

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_CHUNK = 3000;
const HISTORY_LIMIT = 20;
const SYSTEM_PROMPT =
  'Du bist OpenClaw, ein hilfreicher Assistent im Telegram-Chat. Antworte knapp und auf Deutsch. ' +
  'Formatiere sparsam: **fett**, `code` und Codebloecke sind erlaubt, keine Tabellen.';

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripTags(html) {
  return String(html)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function inlineToHtml(text) {
  return text
    .split(/(`[^`\n]+`)/)
    .map(segment => {
      if (segment.length > 2 && segment.startsWith('`') && segment.endsWith('`')) {
        return `<code>${escapeHtml(segment.slice(1, -1))}</code>`;
      }
      return escapeHtml(segment)
        .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
        .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    })
    .join('');
}

function markdownToHtml(markdown) {
  const fence = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g;
  let out = '';
  let last = 0;
  let match;
  while ((match = fence.exec(markdown)) !== null) {
    out += inlineToHtml(markdown.slice(last, match.index));
    out += `<pre>${escapeHtml(match[1].replace(/\n$/, ''))}</pre>`;
    last = fence.lastIndex;
  }
  return out + inlineToHtml(markdown.slice(last));
}

function splitText(text, max = MAX_CHUNK) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function prettyArgs(raw) {
  let text = raw;
  try {
    text = JSON.stringify(typeof raw === 'string' ? JSON.parse(raw || '{}') : raw, null, 2);
  } catch (error) {
    text = String(raw);
  }
  return text.length > 900 ? `${text.slice(0, 900)}\n...` : text;
}

class TelegramBot {
  constructor({ token, allowedUsers = [], agent, resolveModel, getHealth, approvalTimeoutS = 120, debug = false, apiBase = TELEGRAM_API }) {
    this.token = token;
    this.allowed = new Set(allowedUsers.map(s => String(s).trim().toLowerCase().replace(/^@/, '')).filter(Boolean));
    this.agent = agent;
    this.resolveModel = resolveModel;
    this.getHealth = getHealth;
    this.approvalMs = Math.max(10, approvalTimeoutS) * 1000;
    this.debug = debug;
    this.apiBase = apiBase;
    this.running = false;
    this.active = false;
    this.offset = 0;
    this.sessions = new Map();
    this.queues = new Map();
    this.pending = new Map();
  }

  log(...args) {
    if (this.debug) console.log('[telegram]', ...args);
  }

  async api(method, body = {}) {
    const res = await fetch(`${this.apiBase}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({ ok: false, description: 'Ungueltige Server-Antwort' }));
    if (!data.ok) {
      throw new Error(`Telegram ${method}: ${data.description || res.status}`);
    }
    return data.result;
  }

  isAuthorized(from) {
    if (!from) return false;
    if (this.allowed.has(String(from.id))) return true;
    return Boolean(from.username && this.allowed.has(from.username.toLowerCase()));
  }

  defaultChatId() {
    for (const entry of this.allowed) {
      if (/^\d+$/.test(entry)) return entry;
    }
    return null;
  }

  mainMenu() {
    return [
      [
        { text: '\u{1F4CA} Status', callback_data: 'm:status', style: 'primary' },
        { text: '\u{1F6E0} Tools', callback_data: 'm:tools', style: 'primary' }
      ],
      [
        { text: '\u{1F195} Neuer Chat', callback_data: 'm:reset', style: 'success' },
        { text: '\u2753 Hilfe', callback_data: 'm:help', style: 'primary' }
      ]
    ];
  }

  async sendHtml(chatId, html, buttons) {
    const body = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
    if (buttons && buttons.length > 0) body.reply_markup = { inline_keyboard: buttons };
    try {
      return await this.api('sendMessage', body);
    } catch (error) {
      if (!/parse|entities/i.test(error.message)) throw error;
      const plain = { chat_id: chatId, text: stripTags(html).slice(0, 4000), disable_web_page_preview: true };
      if (body.reply_markup) plain.reply_markup = body.reply_markup;
      return this.api('sendMessage', plain);
    }
  }

  async sendMarkdown(chatId, markdown, buttons) {
    const chunks = splitText(markdown || '');
    if (chunks.length === 0) chunks.push('(leer)');
    let last;
    for (let i = 0; i < chunks.length; i += 1) {
      const isLast = i === chunks.length - 1;
      const html = markdownToHtml(chunks[i]);
      if (html.length > 4000) {
        const plain = { chat_id: chatId, text: chunks[i].slice(0, 4000) };
        if (isLast && buttons) plain.reply_markup = { inline_keyboard: buttons };
        last = await this.api('sendMessage', plain);
      } else {
        last = await this.sendHtml(chatId, html, isLast ? buttons : null);
      }
    }
    return last;
  }

  send(chatId, text, buttons) {
    return this.sendMarkdown(chatId, text, buttons);
  }

  async editHtml(chatId, messageId, html) {
    return this.api('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML'
    }).catch(() => {});
  }

  async answerCallback(id, text) {
    return this.api('answerCallbackQuery', { callback_query_id: id, text: text || undefined }).catch(() => {});
  }

  startTyping(chatId) {
    const ping = () => this.api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
    ping();
    const timer = setInterval(ping, 4000);
    return () => clearInterval(timer);
  }

  helpText() {
    return [
      '\u2753 <b>Hilfe</b>',
      '',
      'Schreib mir einfach eine Frage. Ich nutze bei Bedarf deine MCP-Tools.',
      '',
      '/menu \u2013 Menue anzeigen',
      '/status \u2013 Systemstatus',
      '/tools \u2013 verfuegbare Tools',
      '/reset \u2013 neuer Chat',
      '',
      '\u26A0\uFE0F Schreibende Tools (z. B. Schalten, SSH, Deploy) brauchen deine Freigabe per Button.'
    ].join('\n');
  }

  async showStatus(chatId) {
    try {
      const h = this.getHealth();
      const html = [
        '\u{1F4CA} <b>OpenClaw Status</b>',
        `\u2022 Service: <code>${escapeHtml(h.service)}</code> v${escapeHtml(h.version)}`,
        `\u2022 MCP-Server: <b>${h.mcpConnected} / ${h.mcpServers}</b> verbunden`,
        `\u2022 Tools aktiv: <b>${h.agentTools}</b>`,
        `\u2022 Stand: <code>${new Date().toLocaleTimeString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' })}</code>`
      ].join('\n');
      return await this.sendHtml(chatId, html, this.mainMenu());
    } catch (error) {
      return this.sendHtml(chatId, `\u274C Status nicht abrufbar: <code>${escapeHtml(error.message)}</code>`, this.mainMenu());
    }
  }

  async showTools(chatId) {
    const names = this.agent.tools().map(t => t.function.name);
    const list = names.slice(0, 15).map(n => `\u2022 <code>${escapeHtml(n)}</code>${this.agent.needsConfirm(n) ? ' \u26A0\uFE0F' : ''}`).join('\n');
    const more = names.length > 15 ? `\n<i>... und ${names.length - 15} weitere</i>` : '';
    const html = `\u{1F6E0} <b>Tools (${names.length})</b>\n\n${list || 'Keine Tools aktiv'}${more}\n\n\u26A0\uFE0F = Freigabe per Button noetig`;
    return this.sendHtml(chatId, html, this.mainMenu());
  }

  async requestApproval(chatId, call) {
    const id = crypto.randomBytes(4).toString('hex');
    const name = call.function.name;
    const seconds = Math.round(this.approvalMs / 1000);
    const html = [
      '\u26A0\uFE0F <b>Freigabe erforderlich</b>',
      '',
      `Tool: <code>${escapeHtml(name)}</code>`,
      `<pre>${escapeHtml(prettyArgs(call.function.arguments))}</pre>`,
      `<i>Verfaellt nach ${seconds} s ohne Antwort.</i>`
    ].join('\n');
    const buttons = [[
      { text: '\u2705 Ausfuehren', callback_data: `a:${id}:y`, style: 'success' },
      { text: '\u274C Abbrechen', callback_data: `a:${id}:n`, style: 'danger' }
    ]];
    const msg = await this.sendHtml(chatId, html, buttons);

    return new Promise(resolve => {
      const finish = (approved, label) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(id);
        this.editHtml(chatId, msg.message_id, `${label} <code>${escapeHtml(name)}</code>`);
        resolve(approved);
      };
      const timer = setTimeout(() => finish(false, '\u231B Verfallen:'), this.approvalMs);
      this.pending.set(id, { chatId, name, timer, finish });
    });
  }

  async handleCallback(cb) {
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const data = cb.data || '';

    if (!this.isAuthorized(cb.from)) {
      return this.answerCallback(cb.id, 'Nicht autorisiert');
    }

    if (data.startsWith('a:')) {
      const [, id, decision] = data.split(':');
      const entry = this.pending.get(id);
      if (!entry || entry.chatId !== chatId) {
        return this.answerCallback(cb.id, 'Abgelaufen');
      }
      await this.answerCallback(cb.id, decision === 'y' ? 'Freigegeben' : 'Abgebrochen');
      return entry.finish(decision === 'y', decision === 'y' ? '\u2705 Freigegeben:' : '\u274C Abgebrochen:');
    }

    await this.answerCallback(cb.id);
    if (data === 'm:status') return this.showStatus(chatId);
    if (data === 'm:tools') return this.showTools(chatId);
    if (data === 'm:help') return this.sendHtml(chatId, this.helpText(), this.mainMenu());
    if (data === 'm:reset') return this.resetChat(chatId);
  }

  resetChat(chatId) {
    this.sessions.delete(chatId);
    return this.sendHtml(chatId, '\u{1F195} <b>Neuer Chat.</b> Der Verlauf ist geleert.', this.mainMenu());
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (this.allowed.size === 0) {
      return this.sendHtml(
        chatId,
        `\u{1F512} <b>Einrichtung</b>\n\nDeine Telegram-ID: <code>${from ? from.id : '?'}</code>\n` +
          'Trage sie in <code>TELEGRAM_ALLOWED_USERS</code> ein und starte den Stack neu.'
      );
    }

    if (!this.isAuthorized(from)) {
      this.log(`Zugriff verweigert fuer ${from ? from.id : 'unbekannt'}`);
      return this.sendHtml(chatId, '\u26D4\uFE0F <b>Zugriff verweigert.</b>');
    }

    const text = (msg.text || '').trim();
    if (!text) return null;

    if (text === '/start' || text === '/menu') {
      return this.sendHtml(
        chatId,
        '\u{1F916} <b>OpenClaw Lab</b>\n\nStell mir eine Frage \u2013 ich nutze bei Bedarf deine MCP-Tools.',
        this.mainMenu()
      );
    }
    if (text === '/status') return this.showStatus(chatId);
    if (text === '/tools') return this.showTools(chatId);
    if (text === '/help') return this.sendHtml(chatId, this.helpText(), this.mainMenu());
    if (text === '/reset') return this.resetChat(chatId);

    return this.processAgentMessage(chatId, text);
  }

  async processAgentMessage(chatId, userText) {
    let history = this.sessions.get(chatId) || [];
    history.push({ role: 'user', content: userText });
    history = history.slice(-HISTORY_LIMIT);

    const stopTyping = this.startTyping(chatId);
    const wait = await this.sendHtml(chatId, '\u23F3 <i>Agent arbeitet ...</i>');

    try {
      const model = await this.resolveModel();
      const data = await this.agent.run(
        { model, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history] },
        null,
        {
          approve: call => this.requestApproval(chatId, call),
          onToolCall: call =>
            this.editHtml(chatId, wait.message_id, `\u23F3 <i>Nutze</i> <code>${escapeHtml(call.function.name)}</code> ...`)
        }
      );
      const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
      const answer = message.content || '(Keine Antwort erhalten)';

      history.push({ role: 'assistant', content: answer });
      this.sessions.set(chatId, history.slice(-HISTORY_LIMIT));

      await this.api('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      return await this.sendMarkdown(chatId, answer, this.mainMenu());
    } catch (error) {
      await this.api('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      return this.sendHtml(
        chatId,
        `\u274C <b>Fehler im Agentenlauf</b>\n<code>${escapeHtml(error.message)}</code>`,
        this.mainMenu()
      );
    } finally {
      stopTyping();
    }
  }

  dispatch(update) {
    const report = error => console.error('[telegram] Update fehlgeschlagen:', error.message);

    if (update.callback_query) {
      this.handleCallback(update.callback_query).catch(report);
      return;
    }
    if (update.message) {
      const chatId = update.message.chat.id;
      const previous = this.queues.get(chatId) || Promise.resolve();
      const next = previous.then(() => this.handleMessage(update.message)).catch(report);
      this.queues.set(chatId, next);
      next.then(() => {
        if (this.queues.get(chatId) === next) this.queues.delete(chatId);
      });
    }
  }

  async start() {
    if (!this.token) {
      console.log('[telegram] TELEGRAM_BOT_TOKEN nicht gesetzt - Bot inaktiv.');
      return;
    }
    try {
      const me = await this.api('getMe');
      await this.api('deleteWebhook', { drop_pending_updates: false });
      await this.api('setMyCommands', {
        commands: [
          { command: 'menu', description: 'Menue anzeigen' },
          { command: 'status', description: 'Systemstatus' },
          { command: 'tools', description: 'Verfuegbare Tools' },
          { command: 'reset', description: 'Neuer Chat' },
          { command: 'help', description: 'Hilfe' }
        ]
      }).catch(() => {});
      console.log(`[telegram] Bot @${me.username} gestartet (Long-Polling)`);
    } catch (error) {
      console.error('[telegram] Start fehlgeschlagen:', error.message);
      return;
    }
    if (this.allowed.size === 0) {
      console.warn('[telegram] TELEGRAM_ALLOWED_USERS ist leer - Bot antwortet nur mit der Telegram-ID (Einrichtungsmodus).');
    }
    this.active = true;
    this.running = true;
    this.pollLoop().catch(error => console.error('[telegram] Polling beendet:', error.message));
  }

  async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query']
        });
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          this.dispatch(update);
        }
      } catch (error) {
        if (!this.running) break;
        this.log('Polling unterbrochen, neuer Versuch in 3 s:', error.message);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  stop() {
    this.running = false;
    this.active = false;
    for (const entry of this.pending.values()) entry.finish(false, '\u231B Verfallen:');
  }
}

module.exports = { TelegramBot, markdownToHtml, splitText };
