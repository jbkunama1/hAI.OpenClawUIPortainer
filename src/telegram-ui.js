const { TelegramBot } = require('./telegram');
const logBuffer = require('./logbuffer');

const MAX_LOG_CHARS = 3300;

function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

class OpenClawBot extends TelegramBot {
  constructor(options) {
    super(options);
    this.mcp = options.mcp;
  }

  problemCount() {
    return logBuffer.count(['error', 'warn']);
  }

  hasProblems() {
    const serverError = this.mcp ? this.mcp.status().some(server => server.state === 'error') : false;
    return this.problemCount() > 0 || serverError;
  }

  mainMenu() {
    const count = this.problemCount();
    const problems = this.hasProblems();
    const label = problems ? `\u{1F4DC} Logs${count > 0 ? ` (${count})` : ' \u26A0\uFE0F'}` : '\u{1F4DC} Logs';
    const rows = super.mainMenu();
    rows.push([{ text: label, callback_data: 'l:err', style: problems ? 'danger' : 'primary' }]);
    return rows;
  }

  helpText() {
    return `${super.helpText()}\n\n/logs \u2013 Fehler und Warnungen anzeigen`;
  }

  async start() {
    await super.start();
    if (!this.active) return;
    await this.api('setMyCommands', {
      commands: [
        { command: 'menu', description: 'Menue anzeigen' },
        { command: 'status', description: 'Systemstatus' },
        { command: 'tools', description: 'Verfuegbare Tools' },
        { command: 'logs', description: 'Fehler und Warnungen' },
        { command: 'reset', description: 'Neuer Chat' },
        { command: 'help', description: 'Hilfe' }
      ]
    }).catch(() => {});
  }

  async showStatus(chatId) {
    try {
      const h = this.getHealth();
      const html = [
        '\u{1F4CA} <b>OpenClaw Status</b>',
        `\u2022 Service: <code>${escapeHtml(h.service)}</code> v${escapeHtml(h.version)}`,
        `\u2022 MCP-Server: <b>${h.mcpConnected} / ${h.mcpServers}</b> verbunden`,
        `\u2022 Tools aktiv: <b>${h.agentTools}</b>`,
        `\u2022 Stand: <code>${new Date().toLocaleTimeString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' })}</code>`,
        '',
        this.hasProblems() ? '\u26A0\uFE0F <b>Es gibt Fehler</b> \u2013 Details mit /logs' : '\u2705 Keine Fehler'
      ].join('\n');
      return await this.sendHtml(chatId, html, this.mainMenu());
    } catch (error) {
      return this.sendHtml(chatId, `\u274C Status nicht abrufbar: <code>${escapeHtml(error.message)}</code>`, this.mainMenu());
    }
  }

  formatLogs(entries) {
    const timeZone = process.env.TZ || 'Europe/Berlin';
    const labels = { error: 'ERR ', warn: 'WARN', info: 'INFO' };
    const lines = entries.map(entry => {
      const time = new Date(entry.time).toLocaleTimeString('de-DE', { timeZone });
      const message = entry.message.length > 300 ? `${entry.message.slice(0, 300)} ...` : entry.message;
      return `${time} ${labels[entry.level] || entry.level} ${message}`;
    });

    const picked = [];
    let size = 0;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (size + lines[i].length + 1 > MAX_LOG_CHARS) break;
      picked.unshift(lines[i]);
      size += lines[i].length + 1;
    }
    return picked.join('\n');
  }

  async showLogs(chatId, all) {
    const levels = all ? ['error', 'warn', 'info'] : ['error', 'warn'];
    const entries = logBuffer.recent({ levels, limit: all ? 25 : 15 });
    const title = all ? 'Alle Meldungen' : 'Fehler und Warnungen';

    const html = entries.length > 0
      ? `\u{1F4DC} <b>${title}</b> (${entries.length})\n<pre>${escapeHtml(this.formatLogs(entries))}</pre>`
      : `\u2705 <b>${title}</b>\n\nKeine Eintraege vorhanden.`;

    const buttons = [
      [
        { text: '\u{1F504} Aktualisieren', callback_data: all ? 'l:all' : 'l:err', style: 'primary' },
        { text: all ? '\u26A0\uFE0F Nur Fehler' : '\u{1F4CB} Alle Meldungen', callback_data: all ? 'l:err' : 'l:all', style: 'primary' }
      ],
      [{ text: '\u{1F9F9} Leeren', callback_data: 'l:clear', style: 'danger' }]
    ];
    return this.sendHtml(chatId, html, buttons);
  }

  async handleCallback(cb) {
    const data = cb.data || '';
    if (!data.startsWith('l:')) return super.handleCallback(cb);

    if (!this.isAuthorized(cb.from)) {
      return this.answerCallback(cb.id, 'Nicht autorisiert');
    }
    await this.answerCallback(cb.id);

    const chatId = cb.message && cb.message.chat && cb.message.chat.id;
    if (data === 'l:clear') {
      logBuffer.clear();
      return this.sendHtml(chatId, '\u{1F9F9} <b>Logs geleert.</b>', this.mainMenu());
    }
    return this.showLogs(chatId, data === 'l:all');
  }

  async handleMessage(msg) {
    const text = (msg.text || '').trim();
    if (text === '/logs' && this.allowed.size > 0 && this.isAuthorized(msg.from)) {
      return this.showLogs(msg.chat.id, false);
    }
    return super.handleMessage(msg);
  }
}

module.exports = { OpenClawBot };
