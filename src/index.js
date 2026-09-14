const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// BYOK: User liefert eigenen API-Key
app.post('/api/chat/completions', async (req, res) => {
  const userApiKey = req.headers['authorization']?.replace('Bearer ', '');
  
  if (!userApiKey) {
    return res.status(401).json({ error: 'API-Key erforderlich (Authorization: Bearer <key>)' });
  }

  const { model, messages } = req.body;
  
  try {
    const response = await fetch(`${process.env.LLM_ENDPOINT}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userApiKey}`
      },
      body: JSON.stringify({ model, messages })
    });

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Health endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Info endpoint
app.get('/', (req, res) => {
  res.json({
    name: 'OpenClaw Backend',
    version: '1.0.0',
    features: ['BYOK', 'OpenAI-kompatibel', 'Open WebUI Ready']
  });
});

app.listen(PORT, () => {
  console.log(`OpenClaw Backend läuft auf Port ${PORT}`);
});
