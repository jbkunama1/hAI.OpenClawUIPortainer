const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();
const { McpManager } = require('./mcp');
const { createAgent } = require('./agent');
const { TelegramBot } = require('./telegram');
const { announceStart } = require('./startup');

const app = express();

const PORT = process.env.PORT || 3000;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const VERSION = '1.5.1';

let mcpConfig = [];

try {
  mcpConfig = JSON.parse(process.env.MCP_SERVERS_JSON || '[]');
} catch (error) {
  console.error('Invalid MCP_SERVERS_JSON:', error.message);
  mcpConfig = [];
}

const mcp = new McpManager(mcpConfig);

const agent = createAgent({
  mcp,
  baseUrl: LLM_BASE_URL,
  apiKey: LLM_API_KEY,
  enabled: process.env.AGENT_ENABLED !== 'false',
  maxSteps: Math.max(1, parseInt(process.env.AGENT_MAX_STEPS || '8', 10) || 8),
  allow: process.env.MCP_TOOL_ALLOW || '',
  showCalls: process.env.SHOW_TOOL_CALLS !== 'false',
  confirm: process.env.MCP_TOOL_CONFIRM || ''
});

function healthInfo() {
  return {
    status: 'ok',
    service: 'openclaw-backend',
    version: VERSION,
    mcpServers: mcp.servers.length,
    mcpConnected: mcp.connectedCount(),
    agentTools: agent.tools().length
  };
}

async function resolveTelegramModel() {
  const model = (process.env.TELEGRAM_MODEL || '').trim();
  if (!model) {
    throw new Error('TELEGRAM_MODEL ist nicht gesetzt (Modellname deines Anbieters eintragen)');
  }
  return model;
}

const telegram = new TelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN || '',
  allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map(s => s.trim()).filter(Boolean),
  agent,
  resolveModel: resolveTelegramModel,
  getHealth: healthInfo,
  approvalTimeoutS: parseInt(process.env.TELEGRAM_APPROVAL_TIMEOUT_S || '120', 10) || 120,
  debug: process.env.TELEGRAM_DEBUG === 'true'
});

app.use(cors());
app.use(express.json({ limit: '10mb' }));

function requireGatewayToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');

  if (!GATEWAY_TOKEN || token !== GATEWAY_TOKEN) {
    return res.status(401).json({
      error: {
        message: 'Invalid or missing gateway token',
        type: 'authentication_error'
      }
    });
  }

  next();
}

function sseChunk(res, id, model, delta, finishReason) {
  const chunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason || null }]
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

async function handleAgentStream(req, res) {
  const id = `chatcmpl-${Date.now().toString(36)}`;
  const model = req.body.model;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseChunk(res, id, model, { role: 'assistant', content: '' });
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15000);

  try {
    const data = await agent.run(req.body, text => sseChunk(res, id, model, { content: text }));
    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const calls = message.tool_calls || [];

    if (message.content) {
      sseChunk(res, id, model, { content: message.content });
    }
    if (calls.length > 0) {
      sseChunk(res, id, model, {
        tool_calls: calls.map((call, index) => ({
          index,
          id: call.id,
          type: 'function',
          function: { name: call.function.name, arguments: call.function.arguments }
        }))
      });
    }
    sseChunk(res, id, model, {}, calls.length > 0 ? 'tool_calls' : 'stop');
  } catch (error) {
    sseChunk(res, id, model, { content: `\n\nError: ${error.message}` });
    sseChunk(res, id, model, {}, 'stop');
  } finally {
    clearInterval(keepAlive);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

app.get('/health', (req, res) => {
  res.json({
    ...healthInfo(),
    telegramBot: telegram.active,
    timestamp: new Date().toISOString()
  });
});

app.get('/v1/models', requireGatewayToken, async (req, res) => {
  try {
    if (!LLM_BASE_URL) {
      return res.json({
        object: 'list',
        data: []
      });
    }

    const response = await fetch(`${LLM_BASE_URL}/models`, {
      headers: {
        Authorization: `Bearer ${LLM_API_KEY}`
      }
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(502).json({
      error: {
        message: error.message,
        type: 'upstream_error'
      }
    });
  }
});

app.post('/v1/chat/completions', requireGatewayToken, async (req, res) => {
  try {
    if (!LLM_BASE_URL) {
      return res.status(500).json({
        error: {
          message: 'LLM_BASE_URL is not configured',
          type: 'configuration_error'
        }
      });
    }

    const useAgent = req.headers['x-agent'] !== 'off' && agent.tools().length > 0;

    if (useAgent && req.body.stream) {
      return await handleAgentStream(req, res);
    }

    if (useAgent) {
      const data = await agent.run(req.body);
      return res.json(data);
    }

    const payload = {
      model: req.body.model,
      messages: req.body.messages,
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      max_tokens: req.body.max_tokens,
      tools: req.body.tools,
      tool_choice: req.body.tool_choice,
      stream: Boolean(req.body.stream)
    };

    const response = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (payload.stream && response.body) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      response.body.pipe(res);
      return;
    }

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    if (res.headersSent) return;
    return res.status(error.status || 502).json({
      error: {
        message: error.message,
        type: 'upstream_error'
      }
    });
  }
});

app.get('/api/mcp/servers', requireGatewayToken, (req, res) => {
  res.json({ servers: mcp.status() });
});

app.get('/api/mcp/tools', requireGatewayToken, (req, res) => {
  const tools = mcp.getOpenAITools();
  res.json({ count: tools.length, tools });
});

app.post('/api/mcp/call', requireGatewayToken, async (req, res) => {
  const { name, arguments: args } = req.body || {};

  if (!name || typeof name !== 'string') {
    return res.status(400).json({
      error: { message: 'Field "name" is required', type: 'invalid_request_error' }
    });
  }

  try {
    const result = await mcp.callTool(name, args || {});
    return res.json({ name, isError: result.isError, text: result.text });
  } catch (error) {
    return res.status(502).json({
      error: { message: error.message, type: 'mcp_error' }
    });
  }
});

app.post('/api/telegram/notify', requireGatewayToken, async (req, res) => {
  const { chatId, text, buttons } = req.body || {};

  if (!telegram.active) {
    return res.status(503).json({ error: { message: 'Telegram bot not active', type: 'not_configured' } });
  }
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: { message: 'text is required', type: 'invalid_request_error' } });
  }

  try {
    const target = chatId || telegram.defaultChatId();
    if (!target) throw new Error('chatId fehlt und TELEGRAM_ALLOWED_USERS enthaelt keine numerische ID');
    const result = await telegram.send(target, text, buttons);
    return res.json({ ok: true, messageId: result && result.message_id });
  } catch (error) {
    return res.status(502).json({ error: { message: error.message, type: 'telegram_error' } });
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw backend listening on port ${PORT}`);
  console.log(`LLM endpoint: ${LLM_BASE_URL || 'not configured'}`);
  console.log(`MCP servers configured: ${mcp.servers.length}`);

  const mcpReady = mcp.init().catch(error => console.error('MCP init failed:', error.message));
  const telegramReady = telegram.start().catch(error => console.error('Telegram init failed:', error.message));

  Promise.all([mcpReady, telegramReady])
    .then(() => announceStart({ bot: telegram, agent, mcp, version: VERSION, resolveModel: resolveTelegramModel }))
    .catch(error => console.error('Startmeldung fehlgeschlagen:', error.message));
});

async function shutdown() {
  telegram.stop();
  await mcp.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
