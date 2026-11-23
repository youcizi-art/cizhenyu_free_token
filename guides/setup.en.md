# Free Token Gateway — Setup

## What it does

Runs a local OpenAI-compatible gateway (default port `20188`):

- UI: `http://127.0.0.1:20188/`
- API: `http://127.0.0.1:20188/v1`

Configure upstreams (any OpenAI-compatible `baseUrl` + API key) in the UI. You may import CMS AI settings `providers` JSON as upstreams.

When Deploy starts this service, it temporarily points DSH / OpenCode chat at the gateway. Stopping restores the previous Agent model settings. Upstream secrets stay in this tool’s `home/config.json`.

## Steps

1. Install and **start** the service in Deploy Ops → Tools.
2. Open the UI, add at least one upstream, save.
3. Use the **local** API key (placeholder for Agents, not the upstream key).
4. Chat in DSH / OpenCode as usual.
5. **Stop** the service to restore original Agent model config.

## Notes

- Restart the gateway after changing the port.
- If the process crashes, Deploy will try to restore Agent model slices on the next status check.
- “Free” depends on your upstreams; this tool itself does not bill you.
