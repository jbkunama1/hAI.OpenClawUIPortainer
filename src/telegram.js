const fetch = require('node-fetch');

const TELEGRAM_API = 'https://api.telegram.org';

class TelegramBot {
  constructor({ token, allowedUsers = [], gatewayToken, port = 3000, debug = false }) {
    this.token = token;
    this.allowedUsers = new Set(allowedUsers.map(s => String(s).trim().toLowerCase()).filter(Boolean));
    this.gatewayToken = gatewayToken;
    this.gatewayUrl = `http://127.0.0.1:${port}`;
    this.debug = debug;
    this.running = false;
    this.offset = 0;
    this.userSessions = new Map();
  }

  log(...args) {
    if (this.debug) console.log('[telegram]', ...args);
  }

  async api(method, body = {}) {
    const res = await fetch(`${TELEGRAM_API}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json().catch(() => ({ ok: false, description: 'Ungueltige Server-Antwort' }));
    if (!data.ok) {
      throw new Error(`Telegram API ${method}: ${data.description || res.status}`);
    }
    return data.result;
  }

  isAuthorized(from) {
    if (this.allowedUsers.size === 0) return true;
    if (!from) return false;
    const id = String(from.id);
    const username = from.username ? from.username.toLowerCase() : '';
    return this.allowedUsers.has(id) || (username && this.allowedUsers.has(username));
  }

  mainMenu() {
    return [
      [
        { text: '📊 Status', callback_data: 'm:status', style: 'primary' },
        { text: '🛠 Tools', callback_data: 'm:tools', style: 'primary' }
      ],
      [
        { text: '🔄 Neu starten', callback_data: 'm:reset', style: 'success' },
        { text: '⛔️ Chat leeren', callback_data: 'm:clear', style: 'danger' }
      ]
    ];
  }

  async send(chatId, text, buttons = null) {
    const body = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    };
    if (buttons && Array.isArray(buttons) && buttons.length > 0) {
      body.reply_markup = { inline_keyboard: buttons };
    }
    return this.api('sendMessage', body);
  }

  async answerCallback(id, text = null) {
    return this.api('answerCallbackQuery', {
      callback_query_id: id,
      text: text || undefined
    }).catch(() => {});
  }

  async handleUpdate(up) {
    if (up.message) return this.handleMessage(up.message);
    if (up.callback_query) return this.handleCallback(up.callback_query);
  }

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;

    if (!this.isAuthorized(from)) {
      this.log(`Unautorisierter Zugriff von ${from ? from.id : 'unbekannt'}`);
      return this.send(chatId, '⛔️ <b>Zugriff verweigert.</b> Deine Telegram-ID ist nicht autorisiert.');
    }

    const text = (msg.text || '').trim();
    if (!text) return;

    if (text === '/start' || text === '/menu') {
      return this.send(
        chatId,
        '🤖 <b>OpenClaw Lab Agent Gateway</b>\n\nStelle eine beliebige Frage – der Agent befragt deine MCP-Tools und antwortet direkt.',
        this.mainMenu()
      );
    }

    if (text === '/status') return this.showStatus(chatId);
    if (text === '/tools') return this.showTools(chatId);
    if (text === '/reset') {
      this.userSessions.delete(chatId);
      return this.send(chatId, '🔄 <b>Kontext geleert.</b> Neue Unterhaltung gestartet.', this.mainMenu());
    }

    return this.processAgentMessage(chatId, text);
  }

  async showStatus(chatId) {
    try {
      const res = await fetch(`${this.gatewayUrl}/health`);
      const h = await res.json();
      const txt = [
        '📊 <b>OpenClaw Gateway Status</b>',
        `• Service: <code>${h.service || 'openclaw'}</code> (v${h.version || '?'})`,
        `• MCP-Server: <b>${h.mcpConnected || 0} / ${h.mcpServers || 0}</b> verbunden`,
        `• MCP-Tools aktiv: <b>${h.agentTools || 0}</b>`,
        `• Stand: <code>${new Date().toLocaleTimeString('de-DE')}</code>`
      ].join('\n');
      return this.send(chatId, txt, this.mainMenu());
    } catch (e) {
      return this.send(chatId, `❌ Fehler beim Abfragen des Status: ${e.message}`, this.mainMenu());
    }
  }

  async showTools(chatId) {
    try {
      const res = await fetch(`${this.gatewayUrl}/api/mcp/tools`, {
        headers: { Authorization: `Bearer ${this.gatewayToken}` }
      });
      const data = await res.json();
      const tools = data.tools || [];
      const list = tools.slice(0, 15).map(t => `• <code>${t.function.name}</code>`).join('\n');
      const more = tools.length > 15 ? `\n<i>...und ${tools.length - 15} weitere</i>` : '';
      const txt = `🛠 <b>Verfuegbare MCP-Tools (${tools.length})</b>\n\n${list || 'Keine Tools aktiv'}${more}`;
      return this.send(chatId, txt, this.mainMenu());
    } catch (e) {
      return this.send(chatId, `❌ Fehler beim Laden der Tools: ${e.message}`, this.mainMenu());
    }
  }

  async processAgentMessage(chatId, userText) {
    let history = this.userSessions.get(chatId) || [];
    history.push({ role: 'user', content: userText });
    if (history.length > 20) history = history.slice(-20);

    const wait = await this.send(chatId, '⏳ <i>Agent arbeitet & befragt Tools...</i>');

    try {
      const res = await fetch(`${this.gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.gatewayToken}`
        },
        body: JSON.stringify({
          model: 'default',
          messages: history,
          stream: false
        })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error((data.error && data.error.message) || `HTTP ${res.status}`);
      }

      const answer = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(Keine Antwort erhalten)';
      history.push({ role: 'assistant', content: answer });
      this.userSessions.set(chatId, history);

      await this.api('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      return this.send(chatId, answer, this.mainMenu());
    } catch (e) {
      await this.api('deleteMessage', { chat_id: chatId, message_id: wait.message_id }).catch(() => {});
      return this.send(chatId, `❌ <b>Fehler im Agentenlauf:</b>\n<code>${e.message}</code>`, this.mainMenu());
    }
  }

  async handleCallback(cb) {
    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    const from = cb.from;
    const data = cb.data;

    await this.answerCallback(cb.id);

    if (!this.isAuthorized(from)) {
      return this.send(chatId, '⛔️ <b>Zugriff verweigert.</b>');
    }

    if (data === 'm:status') return this.showStatus(chatId);
    if (data === 'm:tools') return this.showTools(chatId);
    if (data === 'm:reset' || data === 'm:clear') {
      this.userSessions.delete(chatId);
      return this.send(chatId, '🔄 <b>Chat-Verlauf geleert.</b> Neue Unterhaltung gestartet.', this.mainMenu());
    }
  }

  async start() {
    if (!this.token) {
      console.log('[telegram] TELEGRAM_BOT_TOKEN nicht konfiguriert – Telegram-Bot inaktiv.');
      return;
    }
    this.running = true;
    console.log('[telegram] Telegram-Bot gestartet (Long-Polling aktiv)');
    this.pollLoop().catch(e => console.error('[telegram] Polling-Fehler:', e.message));
  }

  async pollLoop() {
    while (this.running) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message', 'callback_query']
        });
        for (const up of updates) {
          this.offset = Math.max(this.offset, up.update_id + 1);
          await this.handleUpdate(up).catch(e => console.error('[telegram] Update-Verarbeitung fehlgeschlagen:', e.message));
        }
      } catch (e) {
        if (!this.running) break;
        this.log('Polling-Verbindung unterbrochen, Retry in 3s:', e.message);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}

module.exports = { TelegramBot };
