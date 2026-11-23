# Free Token Gateway — Setup

## What it does

Local curated LLM gateway (default port `20188`):

1. **Catalog** (static `data/providers.json`): free / trial / cheap API signup links  
2. **Connections**: paste keys; gateway rotates on quota / 429 with cooldown  
3. **Wire**: while the Deploy service runs, DSH / OpenCode chat points at this gateway; stop restores prior settings  

Upstream secrets stay in `home/config.json` only.

- UI: `http://127.0.0.1:20188/`
- OpenAI: `/v1/chat/completions`, `/v1/models`
- Anthropic (DSH): `/v1/messages`, `/models`

## Steps

1. Install and **start** Free Token Gateway in Deploy Ops → Tools.
2. Click **Configure** (top-level WebView, same pattern as CMS/CRM).
3. In **Catalog**, open signup links, create keys, then **Connect** and paste them.
4. Under **Strategy**, confirm default model / rotation; rewire if needed.
5. **Reopen** DSH / OpenCode.
6. **Stop** the service to restore original Agent model config.

## Catalog maintenance

Edit `data/providers.json` in the tool source (synced on install/update). A later release may swap in an external feed; this phase stays intentionally static.

## Notes

- Restart the gateway after changing the port.
- If the process crashes, Deploy tries to restore Agent slices on the next status check.
- “Free” depends on provider policy; this tool does not guarantee third-party quota.
