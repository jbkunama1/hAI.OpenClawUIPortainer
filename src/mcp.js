const SEP = '__';

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || '');
}

function expandHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = expandEnv(value);
  }
  return out;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resultToText(result) {
  if (!result) return '';
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map(part => {
      if (part.type === 'text') return part.text;
      if (part.type === 'resource' && part.resource && part.resource.text) return part.resource.text;
      return `[${part.type} content omitted]`;
    })
    .join('\n');
  if (text) return text;
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return '';
}

class McpManager {
  constructor(configs, options = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs || 15000;
    this.callTimeoutMs = options.callTimeoutMs || 60000;
    this.closing = false;
    this.toolMap = new Map();
    this.servers = (Array.isArray(configs) ? configs : [])
      .filter(cfg => cfg && cfg.name)
      .map(cfg => ({
        name: String(cfg.name),
        key: sanitize(cfg.name),
        transport: (cfg.transport || 'http').toLowerCase(),
        url: cfg.url || null,
        command: cfg.command || null,
        args: Array.isArray(cfg.args) ? cfg.args : [],
        env: cfg.env || {},
        headers: cfg.headers || {},
        enabled: cfg.enabled !== false,
        state: cfg.enabled === false ? 'disabled' : 'pending',
        error: null,
        client: null,
        tools: [],
        retries: 0,
        timer: null
      }));
  }

  async init() {
    await Promise.allSettled(this.servers.filter(s => s.enabled).map(s => this.connect(s)));
  }

  async createTransport(server, kind) {
    if (kind === 'stdio') {
      const { StdioClientTransport, getDefaultEnvironment } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const env = { ...getDefaultEnvironment() };
      for (const [k, v] of Object.entries(server.env)) env[k] = expandEnv(v);
      return new StdioClientTransport({ command: server.command, args: server.args, env });
    }
    if (!server.url) throw new Error('url is required for http/sse transport');
    const requestInit = { headers: expandHeaders(server.headers) };
    if (kind === 'sse') {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      return new SSEClientTransport(new URL(server.url), { requestInit });
    }
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    return new StreamableHTTPClientTransport(new URL(server.url), { requestInit });
  }

  async openClient(server, kind) {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'openclaw-gateway', version: '1.0.0' }, { capabilities: {} });
    const transport = await this.createTransport(server, kind);
    try {
      await client.connect(transport, { timeout: this.connectTimeoutMs });
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    return client;
  }

  async connect(server) {
    if (this.closing) return;
    server.state = 'connecting';
    const kinds = server.transport === 'stdio' ? ['stdio'] : server.transport === 'sse' ? ['sse'] : ['http', 'sse'];
    let lastError;

    for (const kind of kinds) {
      try {
        const client = await this.openClient(server, kind);
        client.onclose = () => this.handleClose(server, client);
        client.onerror = error => console.error(`[mcp:${server.name}] ${error.message}`);
        await this.watchToolChanges(server, client);
        server.client = client;
        server.state = 'connected';
        server.error = null;
        server.retries = 0;
        await this.refreshTools(server);
        console.log(`[mcp:${server.name}] connected via ${kind}, ${server.tools.length} tools`);
        return;
      } catch (error) {
        lastError = error;
      }
    }

    server.state = 'error';
    server.error = lastError ? lastError.message : 'unknown error';
    console.error(`[mcp:${server.name}] connect failed: ${server.error}`);
    this.scheduleReconnect(server);
  }

  async watchToolChanges(server, client) {
    try {
      const { ToolListChangedNotificationSchema } = await import('@modelcontextprotocol/sdk/types.js');
      client.setNotificationHandler(ToolListChangedNotificationSchema, () =>
        this.refreshTools(server).catch(error => console.error(`[mcp:${server.name}] refresh failed: ${error.message}`))
      );
    } catch (error) {
      console.error(`[mcp:${server.name}] list_changed handler unavailable: ${error.message}`);
    }
  }

  handleClose(server, client) {
    if (this.closing || server.client !== client) return;
    server.client = null;
    server.state = 'error';
    server.error = 'connection closed';
    server.tools = [];
    this.rebuildToolMap();
    console.error(`[mcp:${server.name}] connection closed`);
    this.scheduleReconnect(server);
  }

  scheduleReconnect(server) {
    if (this.closing || !server.enabled || server.timer) return;
    const delay = Math.min(2000 * 2 ** server.retries, 60000);
    server.retries += 1;
    server.timer = setTimeout(() => {
      server.timer = null;
      this.connect(server);
    }, delay);
  }

  async refreshTools(server) {
    const tools = [];
    let cursor;
    do {
      const page = await server.client.listTools(cursor ? { cursor } : undefined, { timeout: this.connectTimeoutMs });
      tools.push(...(page.tools || []));
      cursor = page.nextCursor;
    } while (cursor);
    server.tools = tools;
    this.rebuildToolMap();
  }

  rebuildToolMap() {
    const map = new Map();
    for (const server of this.servers) {
      if (server.state !== 'connected') continue;
      for (const tool of server.tools) {
        let name = `${server.key}${SEP}${sanitize(tool.name)}`.slice(0, 64);
        let n = 2;
        while (map.has(name)) {
          name = `${name.slice(0, 60)}_${n++}`;
        }
        map.set(name, { server, tool });
      }
    }
    this.toolMap = map;
  }

  getOpenAITools() {
    return [...this.toolMap.entries()].map(([name, { server, tool }]) => ({
      type: 'function',
      function: {
        name,
        description: `[${server.name}] ${tool.description || tool.title || tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    }));
  }

  async callTool(exposedName, args) {
    const entry = this.toolMap.get(exposedName);
    if (!entry) throw new Error(`Unknown MCP tool: ${exposedName}`);
    const { server, tool } = entry;
    if (!server.client) throw new Error(`MCP server not connected: ${server.name}`);
    const result = await server.client.callTool(
      { name: tool.name, arguments: args || {} },
      undefined,
      { timeout: this.callTimeoutMs }
    );
    return { isError: Boolean(result.isError), text: resultToText(result), raw: result };
  }

  status() {
    return this.servers.map(s => ({
      name: s.name,
      transport: s.transport,
      url: s.url,
      enabled: s.enabled,
      state: s.state,
      error: s.error,
      tools: s.tools.length
    }));
  }

  connectedCount() {
    return this.servers.filter(s => s.state === 'connected').length;
  }

  async close() {
    this.closing = true;
    for (const server of this.servers) {
      if (server.timer) clearTimeout(server.timer);
      if (server.client) await withTimeout(server.client.close(), 3000, 'close').catch(() => {});
    }
  }
}

module.exports = { McpManager };
