# AGENTS.md — free-token

## Role

Ops protocol tool: curated catalog + local LLM rotation gateway (not a data MCP).

## Product path

- **Path B**: self-owned catalog + connection rotation (not embedding 9router).
- **Phase 1**: maintainable static `data/providers.json`.
- **Later**: optional external feed / API for free-trial discovery.

## Rules

- Keep secrets in `home/config.json` only.
- Do not write upstream API keys into DSH/OpenCode configs.
- This repo owns gateway + catalog + UI + manage + agent wire (`CIZHENYU_SYSTEM_ROOT`).
- Deploy only hosts `config.type=page` WebView + generic `manage.mjs` service shell.
- No git push from agents unless the user explicitly asks.

## Ports

Default `20188`. Override with `CIZHENYU_FREE_TOKEN_PORT` or UI config (restart required).
