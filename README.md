# hAI.OpenClawUIPortainer

Portainer-Stack für eine OpenClaw-Backend-Runtime mit Open WebUI und BYOK-Unterstützung für OpenAI-kompatible LLM-Anbieter.

## Voraussetzungen

- Docker/Portainer auf x86_64
- Externes Docker-Netzwerk `highfishNetwork`
- Ein OpenAI-kompatibler API-Endpunkt und API-Key
- Für die WebUI mindestens etwa 2 GB freier Arbeitsspeicher; lokale LLMs benötigen zusätzliche Ressourcen

Netzwerk einmalig anlegen, falls es nicht existiert:

```bash
docker network create highfishNetwork
```

## Portainer-Installation

1. Portainer öffnen und **Stacks → Add stack** wählen.
2. Als Namen `openclaw` verwenden.
3. **Git Repository** wählen.
4. Repository-URL eintragen:
   `https://github.com/jbkunama1/hAI.OpenClawUIPortainer.git`
5. Branch `main` verwenden und Compose-Datei `docker-compose.yml` auswählen.
6. Unter **Environment variables** die Werte aus `.env.example` setzen.
7. Stack deployen.

Die WebUI ist anschließend unter `http://SERVER-IP:8666` erreichbar.

## Umgebungsvariablen

| Variable | Pflicht | Beispiel/Bedeutung |
|---|---:|---|
| `OPENCLAW_GATEWAY_TOKEN` | Ja | Langes zufälliges Gateway-Token |
| `OPENAI_API_BASE_URL` | Ja | OpenAI-kompatible Base-URL, inklusive `/v1` |
| `OPENAI_API_KEY` | Ja | API-Key des gewählten Providers |
| `WEBUI_PORT` | Nein | Externer Port, Standard `8666` |
| `WEBUI_AUTH` | Nein | Login aktivieren, Standard `true` |
| `WEBUI_NAME` | Nein | Anzeigename der WebUI |
| `TZ` | Nein | Standard `Europe/Berlin` |

## BYOK-Beispiele

### OpenAI

```text
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
```

### OpenRouter

```text
OPENAI_API_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-v1-...
```

### Ollama im separaten Container

```text
OPENAI_API_BASE_URL=http://ollama:11434/v1
OPENAI_API_KEY=ollama
```

Der Ollama-Container muss im selben Docker-Netzwerk erreichbar sein. Ein Modell wird anschließend in Open WebUI ausgewählt.

### Andere Anbieter

Base-URL und Modellnamen bitte nach der Dokumentation des jeweiligen Anbieters eintragen. Die URL muss den OpenAI-kompatiblen API-Pfad bereitstellen.

## Sicherheit

- Niemals echte Keys committen; nur Portainer-Environment-Variablen oder Secrets verwenden.
- `WEBUI_AUTH=true` beibehalten, besonders bei Zugriff über Cloudflare oder Internet.
- Das Gateway nicht direkt per Port nach außen veröffentlichen.
- Für externe Zugriffe HTTPS, Cloudflare Access oder eine vergleichbare Zugriffskontrolle verwenden.
- Das Standard-Token ersetzen und nicht im README dokumentieren.

## Aktualisieren

In Portainer den Stack öffnen und **Pull and redeploy** ausführen. Die benannten Volumes bleiben dabei erhalten.

## Troubleshooting

```bash
docker compose ps
docker logs openclaw
docker logs open-webui
```

- Bei `502` zuerst prüfen, ob der Backend-Container läuft.
- Bei API-Fehlern Base-URL, Key und Modellnamen prüfen.
- Bei einem Netzwerkfehler sicherstellen, dass `highfishNetwork` bereits existiert.

## Lizenz

MIT