import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z, ZodRawShape } from 'zod'
import { OrchestratorClient, OrchestratorError, toolContext } from './orchestrator.js'

// Uniform JSON text result + error handling, so a failed API call becomes a
// clean tool error (isError) rather than crashing the server.
function register(
  server: McpServer,
  name: string,
  description: string,
  shape: ZodRawShape,
  handler: (args: any) => Promise<unknown>
) {
  server.tool(name, description, shape, async (args: any) => {
    try {
      // Tag every API request this handler makes with the tool name (X-MCP-Tool),
      // so the panel's AI-activity log shows exactly which tool ran.
      const out = await toolContext.run(name, () => handler(args))
      const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2)
      return { content: [{ type: 'text' as const, text }] }
    } catch (e) {
      const err = e as OrchestratorError
      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Error${err.status ? ` (${err.status})` : ''}: ${err.message}` }]
      }
    }
  })
}

// Cache/optimize/queue commands only — deliberately EXCLUDES every destructive
// artisan command (migrate*, db:wipe, db:seed, …) even though the API allowlists
// some of them, so the AI can never touch schema or data through this server.
const SAFE_ARTISAN = new Set([
  'optimize', 'optimize:clear',
  'cache:clear', 'config:clear', 'config:cache',
  'route:clear', 'route:cache', 'view:clear', 'view:cache',
  'event:clear', 'event:cache', 'queue:restart'
])

interface SiteSummary {
  id: number; domain: string; name: string; status: string
  phpVersion?: string; sslEnabled?: boolean; stackType?: string; disabled?: boolean
  deployments?: Array<{ status: string; branch: string; commit: string | null; createdAt: string }>
}

export function registerTools(
  server: McpServer,
  client: OrchestratorClient,
  opts: { enableActions: boolean }
) {
  // ── Read-only tools (always available) ─────────────────────────────────────

  register(server, 'list_sites',
    'List all sites the token can see, with status, PHP version, SSL, stack and last deploy.',
    {},
    async () => {
      const sites = await client.get<SiteSummary[]>('/sites')
      return sites.map((s) => ({
        id: s.id, domain: s.domain, name: s.name, status: s.status,
        php: s.phpVersion, ssl: s.sslEnabled, stack: s.stackType, disabled: s.disabled,
        lastDeploy: s.deployments?.[0]
          ? { status: s.deployments[0].status, branch: s.deployments[0].branch, commit: s.deployments[0].commit, at: s.deployments[0].createdAt }
          : null
      }))
    })

  register(server, 'get_site',
    'Full detail for one site (config, deploy settings, recent deployments). Secrets are never returned.',
    { siteId: z.number().int().describe('Site id from list_sites') },
    async ({ siteId }) => client.get(`/sites/${siteId}`))

  register(server, 'list_releases',
    'Releases currently on disk for a site (for choosing a rollback target).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/releases`))

  register(server, 'deploy_pending',
    'Commits on the remote branch that have not been deployed yet.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/deploy/pending`))

  register(server, 'composer_outdated',
    'Outdated Composer packages for a Laravel site (semver-safe vs major).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/composer/outdated`))

  register(server, 'site_logs',
    'Recent Laravel log entries for a site.',
    {
      siteId: z.number().int(),
      level: z.enum(['error', 'warning', 'info', 'debug']).optional().describe('Filter by level'),
      lines: z.number().int().min(1).max(500).optional().describe('How many lines (default 100)')
    },
    async ({ siteId, level, lines }) => {
      const q = new URLSearchParams()
      if (level) q.set('level', level)
      q.set('lines', String(lines ?? 100))
      return client.get(`/sites/${siteId}/logs?${q.toString()}`)
    })

  register(server, 'monitor_services',
    'Status of system services (nginx, mariadb, redis, php-fpm, supervisor, …).',
    {},
    async () => client.get('/monitor/services'))

  register(server, 'performance_apm',
    'Response-time percentiles (p50/p95/p99) and uptime per monitored site.',
    { hours: z.number().int().min(1).max(720).optional().describe('Window in hours (default 24)') },
    async ({ hours }) => client.get(`/monitor/apm?hours=${hours ?? 24}`))

  register(server, 'list_servers',
    'Managed servers (local + remote) with status and monthly cost.',
    {},
    async () => client.get('/servers'))

  register(server, 'uptime',
    'Uptime status for all monitored sites.',
    {},
    async () => client.get('/uptime'))

  register(server, 'billing_overview',
    'Billing summary: clients, subscriptions, open invoices, enforcement mode.',
    {},
    async () => client.get('/billing/overview'))

  register(server, 'server_economics',
    'Per-server monthly cost vs revenue vs margin and latest utilisation.',
    {},
    async () => client.get('/billing/server-economics'))

  register(server, 'metrics_history',
    'Historical resource metrics (CPU/RAM/disk) for the panel host.',
    { hours: z.number().int().min(1).max(720).optional().describe('Window in hours (default 24)') },
    async ({ hours }) => client.get(`/monitor/history?hours=${hours ?? 24}`))

  register(server, 'top_processes',
    'Top services/processes by resource use on the panel host.',
    { limit: z.number().int().min(1).max(50).optional().describe('How many (default 8)') },
    async ({ limit }) => client.get(`/monitor/processes?limit=${limit ?? 8}`))

  register(server, 'log_errors',
    'Aggregated application error feed across sites (with unresolved count).',
    {},
    async () => client.get('/log-errors'))

  register(server, 'notifications',
    'Recent panel notifications (deploys, alerts, billing, automation) and unread count.',
    {},
    async () => client.get('/notifications'))

  register(server, 'alerts',
    'Configured monitoring alert rules.',
    {},
    async () => client.get('/alerts'))

  register(server, 'audit_log',
    'Recent audit-log entries (who did what in the panel).',
    { limit: z.number().int().min(1).max(200).optional().describe('How many (default 50)') },
    async ({ limit }) => client.get(`/audit?limit=${limit ?? 50}`))

  register(server, 'system_info',
    'Panel host system info: OS, versions, resource summary.',
    {},
    async () => client.get('/system/info'))

  register(server, 'server_health',
    'Live CPU/RAM/disk/uptime for a managed server.',
    { serverId: z.number().int().describe('Server id from list_servers') },
    async ({ serverId }) => client.get(`/servers/${serverId}/health`))

  register(server, 'ssl_status',
    'SSL certificate status for a site (issuer, expiry, days left).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/ssl`))

  register(server, 'workers_status',
    'Queue worker (supervisor) processes for a site and their state.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/supervisor/status`))

  register(server, 'artisan_commands',
    'The allowlisted artisan commands available for a site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/artisan/commands`))

  register(server, 'database_backups',
    'List database backups on disk for a site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/database/backups`))

  register(server, 'failed_jobs',
    'Failed queue jobs for a site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/failed-jobs`))

  register(server, 'scheduler_status',
    'Laravel scheduler (cron) status for a site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.get(`/sites/${siteId}/scheduler`))

  register(server, 'billing_clients',
    'Billing clients.',
    {},
    async () => client.get('/billing/clients'))

  register(server, 'billing_subscriptions',
    'Billing subscriptions (site, client, amount, next invoice, state).',
    {},
    async () => client.get('/billing/subscriptions'))

  register(server, 'automation_webhooks',
    'Configured outbound webhooks.',
    {},
    async () => client.get('/automation/webhooks'))

  register(server, 'automation_rules',
    'Configured automation rules.',
    {},
    async () => client.get('/automation/rules'))

  register(server, 'automation_event_types',
    'The event types and action types automation rules/webhooks can use.',
    {},
    async () => client.get('/automation/event-types'))

  if (!opts.enableActions) return

  // ── Safe actions (opt-in via MCP_ENABLE_ACTIONS; still admin-gated by the PAT's
  //    user role on the API side). No destructive tools are exposed here — no
  //    site delete, server cleanup, nginx edits or billing enforcement. ─────────

  register(server, 'deploy_site',
    '⚠️ Triggers a REAL zero-downtime deployment of the site (git pull + build + atomic swap). Returns immediately; poll get_site for status.',
    {
      siteId: z.number().int(),
      skipTests: z.boolean().optional().describe('Bypass the pre-deploy test gate (emergency only)'),
      ref: z.string().max(100).optional().describe('Deploy a specific tag/branch/commit instead of the branch HEAD')
    },
    async ({ siteId, skipTests, ref }) => {
      const q = new URLSearchParams()
      if (skipTests) q.set('skipTests', '1')
      if (ref) q.set('ref', ref)
      const qs = q.toString()
      return client.post(`/sites/${siteId}/deploy${qs ? `?${qs}` : ''}`)
    })

  register(server, 'rollback_site',
    '⚠️ Rolls the site back to a previous on-disk release (atomic symlink swap). Use list_releases to pick a release name.',
    { siteId: z.number().int(), release: z.string().describe('Release name from list_releases (e.g. 20261017120712)') },
    async ({ siteId, release }) => client.post(`/sites/${siteId}/rollback`, { release }))

  register(server, 'clear_cache',
    'Runs "php artisan optimize:clear" on the site (safe, cache-only).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/artisan/run`, { command: 'optimize:clear' }))

  register(server, 'set_maintenance',
    '⚠️ Puts the site into or out of Laravel maintenance mode (503 while down). A secret enables bypass at https://<domain>/<secret>.',
    {
      siteId: z.number().int(),
      action: z.enum(['down', 'up']).describe('down = enable maintenance, up = back online'),
      secret: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional().describe('Bypass secret (letters/numbers/-/_ only), only for "down"')
    },
    async ({ siteId, action, secret }) =>
      client.post(`/sites/${siteId}/maintenance`, { action, ...(secret ? { secret } : {}) }))

  register(server, 'create_staging',
    'Creates a staging/preview copy of the site at staging.<domain> (config copy; same repo/branch/stack). Does not touch the production site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/staging`))

  register(server, 'run_artisan',
    'Runs a SAFE artisan command (cache/optimize/queue:restart only). Destructive commands (migrate*, db:*) are rejected.',
    {
      siteId: z.number().int(),
      command: z.string().describe('One of: ' + [...SAFE_ARTISAN].join(', '))
    },
    async ({ siteId, command }) => {
      if (!SAFE_ARTISAN.has(command)) {
        throw Object.assign(new Error(`"${command}" is not a safe command. Allowed: ${[...SAFE_ARTISAN].join(', ')}`), { status: 400 })
      }
      return client.post(`/sites/${siteId}/artisan/run`, { command })
    })

  register(server, 'queue_restart',
    'Gracefully restarts the site\'s queue workers (php artisan queue:restart).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/artisan/run`, { command: 'queue:restart' }))

  register(server, 'create_database_backup',
    'Creates a fresh database dump for the site (non-destructive — adds a new backup file).',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/database/backup`))

  register(server, 'retry_failed_job',
    'Re-queues one failed job for a site.',
    { siteId: z.number().int(), jobId: z.string().describe('Failed job id/uuid from failed_jobs') },
    async ({ siteId, jobId }) => client.post(`/sites/${siteId}/failed-jobs/${encodeURIComponent(jobId)}/retry`))

  register(server, 'retry_all_failed_jobs',
    'Re-queues all failed jobs for a site.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/failed-jobs/retry-all`))

  register(server, 'ssl_renew',
    '⚠️ Issues/renews the site\'s Let\'s Encrypt certificate (certbot). Non-destructive — a failed renew keeps the current cert and nginx is guarded.',
    { siteId: z.number().int() },
    async ({ siteId }) => client.post(`/sites/${siteId}/ssl`))

  register(server, 'test_webhook',
    'Fires a one-off test delivery to a configured outbound webhook.',
    { webhookId: z.number().int().describe('Webhook id from automation_webhooks') },
    async ({ webhookId }) => client.post(`/automation/webhooks/${webhookId}/test`))
}
