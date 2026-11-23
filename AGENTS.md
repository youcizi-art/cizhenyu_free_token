# AGENTS.md — free-token

## Role

Ops protocol tool: local LLM gateway (not a data MCP like World Bank).

## Rules

- Keep secrets in `home/config.json` only.
- Do not write upstream API keys into DSH/OpenCode configs.
- Deploy owns Agent model slice backup/restore; this repo owns gateway + UI + manage.
- Prefer simple OpenAI-compatible proxy + ordered upstream fallback; do not vendor full 9router Dashboard.
- No git push from agents unless the user explicitly asks.

## Ports

Default `20188`. Override with `CIZHENYU_FREE_TOKEN_PORT` or UI config (restart required).
