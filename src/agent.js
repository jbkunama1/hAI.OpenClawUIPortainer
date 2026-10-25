const fetch = require('node-fetch');

const MAX_TOOL_RESULT_CHARS = 20000;

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    return null;
  }
}

function truncate(text) {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[truncated ${text.length - MAX_TOOL_RESULT_CHARS} chars]`;
}

function createAgent({ mcp, baseUrl, apiKey, enabled, maxSteps, allow, showCalls }) {
  const patterns = String(allow || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  function isAllowed(name) {
    if (patterns.length === 0) return true;
    return patterns.some(p => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  }

  function tools() {
    if (!enabled) return [];
    return mcp.getOpenAITools().filter(t => isAllowed(t.function.name));
  }

  async function llm(body) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error((data && data.error && data.error.message) || `Upstream error ${response.status}`);
      error.status = response.status;
      error.payload = data;
      throw error;
    }
    return data;
  }

  async function execute(call) {
    const name = call.function.name;
    const args = parseArgs(call.function.arguments);
    if (args === null) return 'Error: tool arguments are not valid JSON';
    try {
      const result = await mcp.callTool(name, args);
      return truncate(result.isError ? `Error: ${result.text}` : result.text || '(empty result)');
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }

  async function run(body, onProgress) {
    const mcpTools = tools();
    const names = new Set(mcpTools.map(t => t.function.name));
    const clientTools = Array.isArray(body.tools) ? body.tools : [];
    const messages = [...body.messages];
    const base = {
      model: body.model,
      temperature: body.temperature,
      top_p: body.top_p,
      max_tokens: body.max_tokens,
      stream: false
    };
    const allTools = [...clientTools, ...mcpTools];

    for (let step = 0; step < maxSteps; step += 1) {
      const data = await llm({
        ...base,
        messages,
        tools: allTools,
        tool_choice: step === 0 ? body.tool_choice : undefined
      });
      const message = data.choices && data.choices[0] && data.choices[0].message;
      const calls = (message && message.tool_calls) || [];

      if (calls.length === 0 || calls.some(c => !names.has(c.function.name))) {
        return data;
      }

      messages.push(message);
      for (const call of calls) {
        if (showCalls && onProgress) onProgress(`> \u{1F527} \`${call.function.name}\`\n\n`);
        const content = await execute(call);
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    return llm({ ...base, messages });
  }

  return { tools, run };
}

module.exports = { createAgent };
