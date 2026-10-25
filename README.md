# hAI.OpenClawUIPortainer

Portainer-Stack für Open WebUI mit einem OpenAI-kompatiblen Agent-Gateway.

Das Projekt bietet:

- Open WebUI auf Port 8666
- BYOK für OpenAI-kompatible LLM-Anbieter
- Gateway-API für Open WebUI
- MCP-Client (Streamable HTTP, SSE-Fallback, stdio)
- Tool-Calling-Schleife über MCP-Tools mit Allowlist
- Persistente Docker-Volumes
- GHCR-Image-Build über GitHub Actions

## Portainer-Installation

1. Portainer öffnen.
2. **Stacks → Add stack** wählen.
3. Stack-Name: `openclaw`
4. **Repository** auswählen.
5. Repository-URL:

   ```text
   https://github.com/jbkunama1/hAI.OpenClawUIPortainer.git
   ```

6. Branch: `main`
7. Compose-Datei: `docker-compose.yml`
8. Environment-Variablen setzen.
9. Stack deployen.

Die WebUI ist danach erreichbar unter:

```text
http://SERVER-IP:8666
```

## Environment-Variablen

| Variable | Pflicht | Beispiel |
|---|---:|---|
| `GATEWAY_TOKEN` | Ja | Langes zufälliges Token |
| `LLM_BASE_URL` | Ja | `https://api.openai.com/v1` |
| `LLM_API_KEY` | Ja | API-Key des Providers |
| `WEBUI_PORT` | Nein | `8666` |
| `WEBUI_AUTH` | Nein | `true` |
| `WEBUI_NAME` | Nein | `OpenClaw Lab` |
| `TZ` | Nein | `Europe/Berlin` |
| `MCP_SERVERS_JSON` | Nein | JSON-Array mit MCP-Servern |
| `HAI_MCP_TOKEN` | Nein | Token für MCP-Header |
| `MCP_TOOL_ALLOW` | Nein | `hai__fhem_get*,hai__web_search_exa` |
| `AGENT_ENABLED` | Nein | `true` |
| `AGENT_MAX_STEPS` | Nein | `8` |
| `SHOW_TOOL_CALLS` | Nein | `true` |

## BYOK-Beispiele

### OpenAI

```text
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-...
```

### OpenRouter

```text
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-v1-...
```

### Ollama

```text
LLM_BASE_URL=http://ollama:11434/v1
LLM_API_KEY=ollama
```

## MCP-Konfiguration

MCP-Server werden als JSON-Array übergeben. Echte URLs und Tokens gehören nur in die Portainer-Environment, nicht ins Repository.

```json
[
  {
    "name": "hai",
    "transport": "http",
    "url": "https://mcp.example.com/mcp",
    "headers": { "Authorization": "Bearer ${HAI_MCP_TOKEN}" }
  }
]
```

Felder pro Server:

| Feld | Bedeutung |
|---|---|
| `name` | Servername, wird Präfix der Tools (`name__tool`) |
| `transport` | `http` (Standard, mit SSE-Fallback), `sse` oder `stdio` |
| `url` | Endpunkt bei `http`/`sse` |
| `headers` | Zusätzliche HTTP-Header, `${VAR}` wird aus der Container-Umgebung ersetzt |
| `command`, `args`, `env` | Nur bei `stdio` |
| `enabled` | `false` deaktiviert den Server |

Als Environment-Variable (einzeilig):

```text
MCP_SERVERS_JSON=[{"name":"hai","transport":"http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ${HAI_MCP_TOKEN}"}}]
```

## Agent und Tool-Calling

Sind MCP-Tools verbunden, hängt das Gateway sie an jede Chat-Anfrage. Ruft das Modell ein MCP-Tool auf, führt das Gateway es aus, gibt das Ergebnis ans Modell zurück und wiederholt das bis `AGENT_MAX_STEPS`.

- `MCP_TOOL_ALLOW` begrenzt die erlaubten Tools (kommagetrennt, `*` am Ende als Präfix). Leer bedeutet: alle Tools.
- Setze die Allowlist immer, damit das Modell keine schreibenden oder gefährlichen Tools aufrufen kann.
- Mit dem Header `x-agent: off` läuft eine Anfrage ohne MCP-Tools.
- Das Modell muss Function Calling unterstützen.

### Gateway-Endpunkte

Alle außer `/health` verlangen `Authorization: Bearer <GATEWAY_TOKEN>`.

| Endpunkt | Zweck |
|---|---|
| `GET /health` | Status, `mcpConnected`, `agentTools` |
| `GET /v1/models` | Modelle des Providers |
| `POST /v1/chat/completions` | Chat mit Agent-Schleife |
| `GET /api/mcp/servers` | Verbindungsstatus je MCP-Server |
| `GET /api/mcp/tools` | Tools im OpenAI-Format |
| `POST /api/mcp/call` | Einzelnes Tool testen |

## Sicherheit

- Niemals echte API-Keys, Tokens oder MCP-URLs ins Repository committen.
- `GATEWAY_TOKEN` immer ersetzen.
- `WEBUI_AUTH=true` beibehalten.
- `MCP_TOOL_ALLOW` setzen und nur lesende Tools freigeben, bis alles zuverlässig läuft.
- Backend-Port 3000 nicht nach außen freigeben.
- Für Internetzugriff HTTPS, Cloudflare Access oder eine vergleichbare Absicherung verwenden.

## Troubleshooting

```bash
docker compose ps
docker logs openclaw
docker logs open-webui
```

Bei `502`: Backend-Container und `LLM_BASE_URL` prüfen.  
Bei `401`: `GATEWAY_TOKEN` prüfen.  
Bei Image-Pull-Fehlern: GHCR-Workflow und Paket-Sichtbarkeit prüfen.  
Bei MCP-Problemen: `GET /api/mcp/servers` zeigt Status und Fehlertext je Server.
