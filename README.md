# CIZHENYU Free Token Gateway

Local OpenAI-compatible LLM gateway for CIZHENYU Deploy (DSH / OpenCode).

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
server.mjs          HTTP gateway + UI static
manage.mjs          start/stop/status
mcp_launcher.mjs    status/models MCP helpers
public/             gateway UI
home/               local config (gitignored)
cizhenyu.tool.json  Deploy tool protocol
```

## Agent wiring

Handled by Deploy: on service start, snapshot and patch Agent model slices to this gateway; on stop, restore. MCP injects are not rolled back.
