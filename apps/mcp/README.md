# Orchestrator MCP

An [MCP](https://modelcontextprotocol.io) server that exposes the Orchestrator
panel to Claude (Desktop / Code) and other MCP-compatible AIs. It is a thin layer
over the existing Orchestrator REST API — it adds **no new privileges**: every
call is authenticated with a Personal Access Token and goes through the panel's
own auth, RBAC and audit log.

## What the AI can do

**Read — 31 tools, always on:**
`list_sites`, `get_site`, `list_releases`, `deploy_pending`, `composer_outdated`,
`site_logs`, `log_errors`, `ssl_status`, `workers_status`, `failed_jobs`,
`scheduler_status`, `artisan_commands`, `database_backups`, `monitor_services`,
`performance_apm`, `metrics_history`, `top_processes`, `system_info`,
`list_servers`, `server_health`, `uptime`, `notifications`, `alerts`,
`audit_log`, `billing_overview`, `billing_clients`, `billing_subscriptions`,
`server_economics`, `automation_webhooks`, `automation_rules`,
`automation_event_types`.

**Safe actions — 12 tools, on when `MCP_ENABLE_ACTIONS=true`:**
`deploy_site`, `rollback_site`, `clear_cache`, `run_artisan` (cache/optimize/
queue only), `queue_restart`, `set_maintenance`, `create_staging`,
`create_database_backup`, `retry_failed_job`, `retry_all_failed_jobs`,
`ssl_renew`, `test_webhook`.

**Intentionally NOT exposed:** deleting sites, server power/cleanup, editing
nginx or `.env`, reading secrets, the web terminal or file manager, database
restore/drop, destructive artisan (`migrate*`, `db:*`), turning billing
enforcement on, or Composer major upgrades. Anything that could endanger or
expose a hosted site stays in the panel UI only.

## Setup

1. **Create a Personal Access Token** in the panel (Settings → Access tokens, or
   `POST /api/tokens`). Tip: make it under a non-admin user to scope what the MCP
   can touch — the API's RBAC applies to the token's user.

2. **Configure & build:**
   ```bash
   cd apps/mcp
   cp .env.example .env     # set ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN
   npm install
   npm run build
   ```

### Claude Desktop (stdio)

Add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "node",
      "args": ["/opt/orchestrator/apps/mcp/dist/index.js"],
      "env": {
        "ORCHESTRATOR_URL": "http://127.0.0.1:3001",
        "ORCHESTRATOR_TOKEN": "orch_xxx",
        "MCP_ENABLE_ACTIONS": "true"
      }
    }
  }
}
```
(The same block works for Claude Code via `claude mcp add`.)

### Remote / team (HTTP)

```bash
MCP_HTTP_PORT=8787 MCP_HTTP_AUTH=some-long-random-string node dist/index.js
```
Endpoint: `POST/GET/DELETE http://host:8787/mcp` (Streamable HTTP). Put it behind
TLS and keep `MCP_HTTP_AUTH` set. Clients send `Authorization: Bearer <MCP_HTTP_AUTH>`.

## Security notes

- The PAT (`orch_…`) is the only credential the MCP holds; it never sees git
  tokens, SSH keys or `.env` contents (the API redacts those).
- Read-only is the floor — set `MCP_ENABLE_ACTIONS=false` for a view-only server.
- Side-effect tools are marked ⚠️ in their descriptions so the AI client shows a
  clear approval prompt before running them.
- Every action is written to the panel's audit log, attributed to the PAT's user.
