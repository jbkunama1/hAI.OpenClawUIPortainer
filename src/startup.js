function escapeHtml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function describeServer(server) {
  const name = `<code>${escapeHtml(server.name)}</code>`;
  if (server.state === 'connected') return `\u2705 ${name} \u2013 ${server.tools} Tools`;
  if (server.state === 'disabled') return `\u23F8 ${name} \u2013 deaktiviert`;
  return `\u274C ${name} \u2013 Fehler`;
}

async function announceStart({ bot, agent, mcp, version, resolveModel }) {
  if (!bot.active) return;

  const targets = [...bot.allowed].filter(id => /^\d+$/.test(id));
  if (targets.length === 0) {
    console.warn('[telegram] Startmeldung uebersprungen: TELEGRAM_ALLOWED_USERS enthaelt keine numerische ID.');
    return;
  }

  const servers = mcp.status();
  const toolNames = agent.tools().map(t => t.function.name);
  const confirmCount = toolNames.filter(name => agent.needsConfirm(name)).length;
  const healthy = servers.every(s => s.state === 'connected' || s.state === 'disabled');

  let modelOk = true;
  let modelLine;
  try {
    modelLine = `\u2022 Modell: <code>${escapeHtml(await resolveModel())}</code>`;
  } catch (error) {
    modelOk = false;
    modelLine = '\u2022 Modell: \u26A0\uFE0F <code>TELEGRAM_MODEL</code> fehlt';
  }

  const hasProblems = typeof bot.hasProblems === 'function' ? bot.hasProblems() : !healthy;
  const serverLines = servers.length > 0 ? servers.map(describeServer) : ['\u2022 keine MCP-Server konfiguriert'];
  const time = new Date().toLocaleString('de-DE', { timeZone: process.env.TZ || 'Europe/Berlin' });
  const ok = healthy && modelOk && !hasProblems;

  const lines = [
    `${ok ? '\u{1F7E2}' : '\u{1F7E1}'} <b>OpenClaw gestartet</b>`,
    '',
    `\u2022 Version: <code>${escapeHtml(version)}</code>`,
    `\u2022 Zeit: <code>${escapeHtml(time)}</code>`,
    modelLine,
    `\u2022 Tools: <b>${toolNames.length}</b> aktiv, davon <b>${confirmCount}</b> mit Freigabe`,
    '',
    '<b>MCP-Server</b>',
    ...serverLines
  ];
  if (hasProblems || !healthy) {
    lines.push('', '\u26A0\uFE0F <b>Es gibt Fehler</b> \u2013 Details mit /logs');
  }

  const html = lines.join('\n');
  for (const id of targets) {
    await bot.sendHtml(id, html, bot.mainMenu()).catch(error =>
      console.error(`[telegram] Startmeldung an ${id} fehlgeschlagen: ${error.message}`)
    );
  }
}

module.exports = { announceStart };
