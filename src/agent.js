const fetch = require('node-fetch');

const MAX_TOOL_RESULT_CHARS = 20000;

const DEFAULT_CONFIRM = [
  '*__fhem_set*', '*__fhem_command', '*__fhem_define', '*__fhem_delete', '*__fhem_attr',
  '*__ssh_*',
  '*__portainer_deploy_stack', '*__portainer_undeploy_stack', '*__portainer_pull_image',
  '*__portainer_execute_sql', '*__portainer_alias_*',
  '*__push_files', '*__create_*', '*__delete_*', '*__update_*', '*__add_*', '*__merge_pull_request',
  '*__issue_write', '*__sub_issue_write', '*__pull_request_review_write', '*__fork_repository',
  '*__assign_copilot_to_issue', '*__request_copilot_review',
  '*__memory_write_page', '*__memory_delete_page', '*__memory_consolidate', '*__memory_forget_sweep',
  '*__execute', '*__invoke_operation', '*__submit_or_merge_change_request',
  '*__perform-editing-operations', '*__commit-editing-transaction'
].join(',');

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function compile(list) {
  return String(list || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(globToRegExp);
}

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

function createAgent({ mcp, baseUrl, apiKey, enabled, maxSteps, allow, showCalls, confirm }) {
  const allowList = compile(allow);
  const trimmed = String(confirm || '').trim();
  const confirmList = compile(trimmed.toLowerCase() === 'none' ? '' : trimmed || DEFAULT_CONFIRM);

  function isAllowed(name) {
    return allowList.length === 0 || allowList.some(r => r.test(name));
  }

  function needsConfirm(name) {
    return confirmList.some(r => r.test(name));
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

  async function run(body, onProgress, options = {}) {
    const { approve, onToolCall } = options;
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
        tools: allTools.length > 0 ? allTools : undefined,
        tool_choice: step === 0 && allTools.length > 0 ? body.tool_choice : undefined
      });
      const message = data.choices && data.choices[0] && data.choices[0].message;
      const calls = (message && message.tool_calls) || [];

      if (calls.length === 0 || calls.some(c => !names.has(c.function.name))) {
        return data;
      }

      messages.push(message);
      for (const call of calls) {
        const name = call.function.name;
        let content;

        let allowed = true;
        if (approve && needsConfirm(name)) {
          allowed = await Promise.resolve(approve(call)).catch(() => false);
        }

        if (!allowed) {
          content = 'Error: Der Benutzer hat die Ausführung nicht freigegeben.';
        } else {
          if (onToolCall) await Promise.resolve(onToolCall(call)).catch(() => {});
          if (showCalls && onProgress) onProgress(`> \u{1F527} \`${name}\`\n\n`);
          content = await execute(call);
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content });
      }
    }

    return llm({ ...base, messages });
  }

  return { tools, run, needsConfirm };
}

module.exports = { createAgent, DEFAULT_CONFIRM };
