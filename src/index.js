const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();

const PORT = process.env.PORT || 3000;
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
const LLM_API_KEY = process.env.LLM_API_KEY || '';

let mcpServers = [];

try {
  mcpServers = JSON.parse(process.env.MCP_SERVERS_JSON || '[]');
} catch (error) {
  console.error('Invalid MCP_SERVERS_JSON:', error.message);
  mcpServers = [];
}

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

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'openclaw-backend',
    version: '1.1.0',
    mcpServers: mcpServers.length,
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

    const payload = {
      model: req.body.model,
      messages: req.body.messages,
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      max_tokens: req.body.max_tokens,
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
    return res.status(502).json({
      error: {
        message: error.message,
        type: 'upstream_error'
      }
    });
  }
});

app.get('/api/mcp/servers', requireGatewayToken, (req, res) => {
  res.json({
    servers: mcpServers.map(server => ({
      name: server.name,
      transport: server.transport || 'http',
      url: server.url || null,
      enabled: server.enabled !== false
    }))
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`OpenClaw backend listening on port ${PORT}`);
  console.log(`LLM endpoint: ${LLM_BASE_URL || 'not configured'}`);
  console.log(`MCP servers configured: ${mcpServers.length}`);
});
