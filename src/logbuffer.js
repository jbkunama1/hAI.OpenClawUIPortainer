const util = require('util');

const MAX_ENTRIES = 300;
const SECRET_ENV_NAMES = [
  'TELEGRAM_BOT_TOKEN',
  'GATEWAY_TOKEN',
  'LLM_API_KEY',
  'HAI_MCP_TOKEN',
  'WEBUI_SECRET_KEY'
];

const entries = [];
let secrets = [];
let installed = false;

function redact(text) {
  let out = String(text);
  for (const secret of secrets) out = out.split(secret).join('***');
  return out
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, 'Bearer ***');
}

function push(level, args) {
  entries.push({ time: Date.now(), level, message: redact(util.format(...args)) });
  if (entries.length > MAX_ENTRIES) entries.shift();
}

function install() {
  if (installed) return;
  installed = true;
  secrets = SECRET_ENV_NAMES.map(name => process.env[name]).filter(value => value && value.length >= 8);

  const levels = { log: 'info', info: 'info', warn: 'warn', error: 'error' };
  for (const [method, level] of Object.entries(levels)) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      try {
        push(level, args);
      } catch (error) {
        // Logging darf nie die Anwendung stoeren
      }
      original(...args);
    };
  }
}

function recent({ levels = ['error', 'warn'], limit = 15 } = {}) {
  return entries.filter(entry => levels.includes(entry.level)).slice(-limit);
}

function count(levels = ['error', 'warn']) {
  return entries.filter(entry => levels.includes(entry.level)).length;
}

function clear() {
  entries.length = 0;
}

module.exports = { install, recent, count, clear, redact };
