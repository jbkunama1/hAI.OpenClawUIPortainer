# hAI.OpenClawUIPortainer

Portainer-Stack für Open WebUI mit einem OpenAI-kompatiblen Agent-Gateway.

Das Projekt bietet:

- Open WebUI auf Port 8666
- BYOK für OpenAI-kompatible LLM-Anbieter
- Gateway-API für Open WebUI
- Optionale MCP-Server-Konfiguration
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

MCP-Server werden als JSON-Array übergeben:

```json
[
  {
    "name": "fhem",
    "transport": "http",
    "url": "http://fhem-mcp:3001",
    "enabled": true
  }
]
```

Als Environment-Variable:

```text
MCP_SERVERS_JSON=[{"name":"fhem","transport":"http","url":"http://fhem-mcp:3001","enabled":true}]
```

## Sicherheit

- Niemals echte API-Keys ins Repository committen.
- `GATEWAY_TOKEN` immer ersetzen.
- `WEBUI_AUTH=true` beibehalten.
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
