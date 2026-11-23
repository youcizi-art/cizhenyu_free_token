# CIZHENYU Free Token Gateway

Curated free/trial provider catalog → paste keys → local rotation gateway for DSH / OpenCode.

- Repo: https://github.com/youcizi-art/cizhenyu_free_token
- Tool id: `free-token`
- Default: `http://127.0.0.1:20188/` (UI) · `/v1` (API)

## Commands

```bash
node manage.mjs start
node manage.mjs status
node manage.mjs open
node manage.mjs stop
node manage.mjs serve   # foreground
```

## Layout

```text
data/providers.json   static curated catalog (path B, phase 1)
server.mjs            HTTP gateway + UI static
lib/                  catalog, config v2, router, proxy, agent wire
manage.mjs            start/stop/status
public/               Catalog / Connections / Strategy UI
home/                 local config (gitignored)
cizhenyu.tool.json    Deploy tool protocol (config.type=page)
```

## Agent wiring

On gateway start/save: backup and patch DSH / OpenCode model slices to this gateway.  
On stop: restore. Upstream API keys never leave `home/config.json`.
