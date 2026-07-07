const TOKEN_KEY = 'orchestrator_token'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      // Only set Content-Type when there's actually a body to send.
      // Fastify rejects an empty body when Content-Type: application/json is present
      // (FST_ERR_CTP_EMPTY_JSON_BODY), which broke body-less POSTs like deploy.trigger().
      ...(options?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers
    }
  })

  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY)
    window.location.href = '/login'
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }))
    const base = (err as any).error ?? 'Request failed'
    const detail = (err as any).details ?? ''
    throw new Error(detail ? `${base}\n\n${detail}` : base)
  }

  if (res.status === 204) return undefined as T
  return res.json()
}

export type SiteTemplate = 'laravel' | 'wordpress' | 'static'

export interface Site {
  id: number
  name: string
  domain: string
  phpVersion: string
  dbName: string | null
  dbUser: string | null
  sslEnabled: boolean
  rootPath: string
  status: 'pending' | 'provisioning' | 'active' | 'error'
  repoUrl: string | null
  branch: string
  webhookToken: string | null
  hasGitToken: boolean
  preDeploy: string | null
  postDeploy: string | null
  healthCheck: boolean
  healthCheckUrl: string | null
  runTests: boolean
  testCommand: string
  testFailureMode: 'block' | 'warn'
  testTimeout: number
  testUseSqlite: boolean
  maintenanceMode: boolean
  uptimeMonitor: boolean
  pinned: boolean
  disabled: boolean
  tags: string   // JSON string
  notes: string | null
  createdAt: string
  updatedAt: string
  deployments: Deployment[]
  sslDaysLeft?: number | null   // cached by the SSL monitor; drives the expiry badge
  sslExpiresAt?: string | null
}

export interface Deployment {
  id: number
  siteId: number
  commit: string | null
  branch: string
  status: 'pending' | 'running' | 'success' | 'failed'
  log: string | null
  comment?: string | null
  testResult?: 'passed' | 'failed' | 'skipped' | null
  testsPassed?: number | null
  testsFailed?: number | null
  testsTotal?: number | null
  testDurationMs?: number | null
  createdAt: string
}

export interface TestStats {
  totalRuns: number
  passRate: number | null
  avgDurationMs: number | null
  lastRun: {
    id: number
    commit: string | null
    testResult: 'passed' | 'failed'
    createdAt: string
    testsPassed: number | null
    testsFailed: number | null
    testsTotal: number | null
    testDurationMs: number | null
  } | null
  trend: {
    date: string
    result: 'passed' | 'failed'
    passed: number | null
    failed: number | null
    total: number | null
  }[]
}

export const api = {
  auth: {
    login: (email: string, password: string, totpCode?: string) =>
      request<{ token: string } | { requiresTOTP: true }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(totpCode ? { totpCode } : {}) })
      }),
    me: () => request<{ userId: number; email: string; totpEnabled: boolean }>('/auth/me'),
    setup2fa: () => request<{ secret: string; qrDataUrl: string }>('/auth/2fa/setup'),
    enable2fa: (totpCode: string) =>
      request<{ ok: boolean }>('/auth/2fa/enable', {
        method: 'POST',
        body: JSON.stringify({ totpCode })
      }),
    disable2fa: () => request<{ ok: boolean }>('/auth/2fa', { method: 'DELETE' })
  },
  sites: {
    list: () => request<Site[]>('/sites'),
    get: (id: number) => request<Site>(`/sites/${id}`),
    create: (data: { name: string; domain: string; phpVersion?: string }) =>
      request<Site>('/sites', { method: 'POST', body: JSON.stringify(data) }),
    remove: (id: number, cleanup?: boolean) =>
      request<void | CleanupResult>(
        `/sites/${id}${cleanup ? '?cleanup=true' : ''}`,
        { method: 'DELETE' }
      ),
    update: (id: number, data: {
      repoUrl?: string; branch?: string; name?: string; domain?: string; disabled?: boolean
      renameOnDisk?: boolean; gitToken?: string
      preDeploy?: string; postDeploy?: string; healthCheck?: boolean; healthCheckUrl?: string
      runTests?: boolean; testCommand?: string; testFailureMode?: string; testTimeout?: number; testUseSqlite?: boolean
      tags?: string[]; pinned?: boolean; notes?: string
    }) =>
      request<Site & { renameLog?: string }>(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    clone: (id: number, data: { name: string; domain: string }) =>
      request<Site>(`/sites/${id}/clone`, { method: 'POST', body: JSON.stringify(data) }),
    branches: (id: number) =>
      request<{ branches: string[] }>(`/sites/${id}/branches`),
    tags: () =>
      request<{ tags: string[] }>('/sites/tags'),
    testStats: (id: number) =>
      request<TestStats>(`/sites/${id}/test-stats`)
  },
  provision: {
    start: (
      siteId: number,
      data: { dbName: string; dbUser: string; dbPassword: string; template?: SiteTemplate }
    ) =>
      request<{ started: boolean; siteId: number }>(`/sites/${siteId}/provision`, {
        method: 'POST',
        body: JSON.stringify(data)
      })
  },
  deploy: {
    trigger: (siteId: number, opts?: { skipTests?: boolean; ref?: string }) => {
      const p = new URLSearchParams()
      if (opts?.skipTests) p.set('skipTests', '1')
      if (opts?.ref) p.set('ref', opts.ref)
      const qs = p.toString()
      return request<{ started: boolean; deploymentId: number } | { queued: boolean; message: string }>(
        `/sites/${siteId}/deploy${qs ? `?${qs}` : ''}`, { method: 'POST' }
      )
    },
    pending: (siteId: number) =>
      request<PendingChanges>(`/sites/${siteId}/deploy/pending`),
    generateWebhookToken: (siteId: number) =>
      request<{ webhookToken: string }>(`/sites/${siteId}/webhook-token`, { method: 'POST' })
  },
  monitor: {
    system: () =>
      request<SystemStats>('/monitor/system'),
    services: () =>
      request<ServiceStatus[]>('/monitor/services'),
    control: (key: string, action: string) =>
      request<ServiceControlResult>(`/monitor/services/${encodeURIComponent(key)}/control`, {
        method: 'POST',
        body: JSON.stringify({ action })
      }),
    history: (hours = 24) =>
      request<MetricsHistory>(`/monitor/history?hours=${hours}`),
    processes: (limit = 8) =>
      request<ProcessStats>(`/monitor/processes?limit=${limit}`),
    apm: (hours = 24) =>
      request<ApmResult>(`/monitor/apm?hours=${hours}`)
  },
  system: {
    info: () => request<SystemInfo>('/system/info')
    // Streamed actions (/system/run/:key/stream) are consumed directly via
    // ProvisionLog/consumeSSE with the built endpoint URL.
  },
  notifications: {
    list: () => request<{ notifications: AppNotification[]; unread: number }>('/notifications'),
    readAll: () => request<{ ok: true }>('/notifications/read-all', { method: 'POST' }),
    read: (id: number) => request<{ ok: true }>(`/notifications/${id}/read`, { method: 'POST' }),
    remove: (id: number) => request<{ ok: true }>(`/notifications/${id}`, { method: 'DELETE' }),
    clear: () => request<{ ok: true }>('/notifications', { method: 'DELETE' })
  },
  logErrors: {
    list: (params?: { siteId?: number; search?: string; resolved?: '0' | '1'; ignored?: '1' }) => {
      const p = new URLSearchParams()
      if (params?.siteId) p.set('siteId', String(params.siteId))
      if (params?.search) p.set('search', params.search)
      if (params?.resolved) p.set('resolved', params.resolved)
      if (params?.ignored) p.set('ignored', params.ignored)
      const qs = p.toString()
      return request<{ errors: LogErrorItem[]; unresolved: number }>(`/log-errors${qs ? `?${qs}` : ''}`)
    },
    get: (id: number) => request<LogErrorDetail>(`/log-errors/${id}`),
    setResolved: (id: number, resolved: boolean) =>
      request<LogErrorItem>(`/log-errors/${id}`, { method: 'PATCH', body: JSON.stringify({ resolved }) }),
    setIgnored: (id: number, ignored: boolean) =>
      request<LogErrorItem>(`/log-errors/${id}`, { method: 'PATCH', body: JSON.stringify({ ignored }) }),
    remove: (id: number) => request<{ ok: true }>(`/log-errors/${id}`, { method: 'DELETE' })
  },
  alerts: {
    list: () => request<{ rules: AlertRule[] }>('/alerts'),
    create: (data: { metric: string; operator?: string; threshold: number; cooldownMins?: number }) =>
      request<AlertRule>('/alerts', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: number, data: { enabled?: boolean; operator?: string; threshold?: number; cooldownMins?: number }) =>
      request<AlertRule>(`/alerts/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    remove: (id: number) => request<{ ok: true }>(`/alerts/${id}`, { method: 'DELETE' })
  },
  digest: {
    get: () => request<DigestConfig>('/digest'),
    update: (data: { enabled?: boolean; day?: number }) =>
      request<{ ok: true }>('/digest', { method: 'PATCH', body: JSON.stringify(data) }),
    sendNow: () => request<{ ok: boolean; digest: DigestData }>('/digest/send-now', { method: 'POST' })
  },
  telegram: {
    me: () => request<TelegramStatus>('/telegram/me'),
    linkCode: () => request<{ code: string; botUsername: string; deepLink: string | null; expiresAt: string }>('/telegram/link-code', { method: 'POST' }),
    unlink: () => request<{ ok: true }>('/telegram/unlink', { method: 'POST' }),
    setup: () => request<{ ok: boolean; url: string }>('/telegram/setup', { method: 'POST' }),
    removeWebhook: () => request<{ ok: true }>('/telegram/remove-webhook', { method: 'POST' })
  },
  tokens: {
    list: () => request<{ tokens: AccessToken[] }>('/tokens'),
    create: (name: string, expiresInDays?: number) =>
      request<AccessToken & { token: string }>('/tokens', {
        method: 'POST',
        body: JSON.stringify(expiresInDays ? { name, expiresInDays } : { name })
      }),
    revoke: (id: number) => request<{ ok: true }>(`/tokens/${id}`, { method: 'DELETE' })
  },
  dashboard: {
    get: () =>
      request<{ auto: string | null; presets: DashboardPreset[] }>('/dashboard'),
    saveAuto: (config: string) =>
      request<{ ok: true }>('/dashboard/auto', { method: 'PUT', body: JSON.stringify({ config }) }),
    savePreset: (name: string, config: string) =>
      request<DashboardPreset>('/dashboard/presets', { method: 'POST', body: JSON.stringify({ name, config }) }),
    deletePreset: (id: number) =>
      request<{ ok: true }>(`/dashboard/presets/${id}`, { method: 'DELETE' })
  },
  server: {
    status: () => request<ServerStatus>('/server/status'),
    listDroplets: () => request<DODroplet[]>('/server/droplets'),
    sizes: () => request<DOSize[]>('/server/sizes'),
    action: (type: string) => request<DOAction>('/server/actions', { method: 'POST', body: JSON.stringify({ type }) }),
    actions: () => request<DOAction[]>('/server/actions'),
    actionStatus: (id: number) => request<DOAction>(`/server/actions/${id}`),
    resize: (size: string, disk: boolean) =>
      request<DOAction>('/server/resize', { method: 'POST', body: JSON.stringify({ size, disk }) }),
    rename: (name: string) =>
      request<DOAction>('/server/rename', { method: 'PATCH', body: JSON.stringify({ name }) }),
    snapshots: () => request<DOSnapshot[]>('/server/snapshots'),
    createSnapshot: (name: string) =>
      request<DOAction>('/server/snapshots', { method: 'POST', body: JSON.stringify({ name }) }),
    deleteSnapshot: (id: string) => request<{ ok: boolean }>(`/server/snapshots/${id}`, { method: 'DELETE' }),
    backups: () => request<DOBackup[]>('/server/backups'),
    firewalls: () => request<DOFirewall[]>('/server/firewalls'),
    addFirewallRule: (id: string, body: { inbound_rules?: unknown[]; outbound_rules?: unknown[] }) =>
      request<{ ok: boolean }>(`/server/firewalls/${id}/rules`, { method: 'POST', body: JSON.stringify(body) }),
    removeFirewallRule: (id: string, body: { inbound_rules?: unknown[]; outbound_rules?: unknown[] }) =>
      request<{ ok: boolean }>(`/server/firewalls/${id}/rules`, { method: 'DELETE', body: JSON.stringify(body) })
  },
  audit: {
    list: (params?: { siteId?: number; limit?: number; offset?: number }) => {
      const q = new URLSearchParams()
      if (params?.siteId)  q.set('siteId',  String(params.siteId))
      if (params?.limit)   q.set('limit',   String(params.limit))
      if (params?.offset)  q.set('offset',  String(params.offset))
      const qs = q.toString()
      return request<AuditPage>(`/audit${qs ? `?${qs}` : ''}`)
    }
  },
  supervisor: {
    getConfig:   (id: number) =>
      request<{ content: string; path: string }>(`/sites/${id}/supervisor`),
    saveConfig:  (id: number, content: string) =>
      request<{ ok: boolean; output: string }>(`/sites/${id}/supervisor`, {
        method: 'PUT', body: JSON.stringify({ content })
      }),
    getStatus:   (id: number) =>
      request<{ processes: WorkerProcess[] }>(`/sites/${id}/supervisor/status`),
    control:     (id: number, action: string) =>
      request<{ ok: boolean; action: string; output: string; processes: WorkerProcess[] }>(
        `/sites/${id}/supervisor/control`,
        { method: 'POST', body: JSON.stringify({ action }) }
      ),
    getCron:     (id: number) =>
      request<{ active: boolean; content: string; path: string; expected: string }>(
        `/sites/${id}/cron`
      ),
    enableCron:  (id: number) =>
      request<{ ok: boolean; path: string }>(`/sites/${id}/cron`, { method: 'PUT', body: '{}' }),
    disableCron: (id: number) =>
      request<{ ok: boolean }>(`/sites/${id}/cron`, { method: 'DELETE' })
  },
  settings: {
    get: () => request<PanelSettings>('/settings'),
    update: (data: Partial<PanelSettings>) =>
      request<{ ok: boolean; updated: string[] }>('/settings', {
        method: 'PUT',
        body: JSON.stringify(data)
      }),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ ok: boolean; message: string }>('/settings/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword, newPassword })
      })
  },
  releases: {
    list: (siteId: number) =>
      request<{ releases: Release[]; current: string }>(`/sites/${siteId}/releases`),
    rollback: (siteId: number, release: string) =>
      request<{ started: boolean; deploymentId: number }>(`/sites/${siteId}/rollback`, {
        method: 'POST',
        body: JSON.stringify({ release })
      })
  },
  artisan: {
    commands: (siteId: number) =>
      request<{ commands: ArtisanCommand[] }>(`/sites/${siteId}/artisan/commands`),
    run: (siteId: number, command: string) =>
      request<{ started: boolean; command: string }>(`/sites/${siteId}/artisan/run`, {
        method: 'POST',
        body: JSON.stringify({ command })
      })
  },
  database: {
    listBackups: (siteId: number) =>
      request<{ backups: BackupFile[] }>(`/sites/${siteId}/database/backups`),
    createBackup: (siteId: number) =>
      request<{ ok: boolean; filename: string; sizeHuman: string; createdAt: string }>(
        `/sites/${siteId}/database/backup`,
        { method: 'POST' }
      ),
    deleteBackup: (siteId: number, filename: string) =>
      request<{ ok: boolean }>(`/sites/${siteId}/database/backups/${encodeURIComponent(filename)}`, {
        method: 'DELETE'
      }),
    restoreBackup: (siteId: number, filename: string) =>
      request<{ ok: boolean; filename: string }>(
        `/sites/${siteId}/database/backups/${encodeURIComponent(filename)}/restore`,
        { method: 'POST' }
      ),
    // Download uses raw fetch (not JSON) — triggers browser download
    getBackupSchedule: (siteId: number) =>
      request<BackupSchedule>(`/sites/${siteId}/database/backup-schedule`),
    enableBackupSchedule: (siteId: number, opts: { hour: number; minute?: number; days?: string }) =>
      request<{ ok: boolean; cronPath: string; hour: number; minute: number; days: string }>(
        `/sites/${siteId}/database/backup-schedule`,
        { method: 'PUT', body: JSON.stringify(opts) }
      ),
    disableBackupSchedule: (siteId: number) =>
      request<{ ok: boolean }>(`/sites/${siteId}/database/backup-schedule`, { method: 'DELETE' }),
    downloadBackup: async (siteId: number, filename: string) => {
      const token = localStorage.getItem(TOKEN_KEY)
      const res = await fetch(`/api/sites/${siteId}/database/backups/${encodeURIComponent(filename)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {}
      })
      if (!res.ok) throw new Error('Download failed')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    }
  },
  ssl: {
    status: (siteId: number) =>
      request<SslStatus>(`/sites/${siteId}/ssl`),
    issue: (siteId: number) =>
      request<{ started: boolean }>(`/sites/${siteId}/ssl`, { method: 'POST' }),
    renew: (siteId: number) =>
      request<{ started: boolean }>(`/sites/${siteId}/ssl/renew`, { method: 'POST' }),
    remove: (siteId: number) =>
      request<{ ok: boolean }>(`/sites/${siteId}/ssl`, { method: 'DELETE' })
  },
  config: {
    getNginx: (siteId: number) =>
      request<{ content: string; path: string }>(`/sites/${siteId}/config/nginx`),
    saveNginx: (siteId: number, content: string) =>
      request<{ ok: boolean; message: string }>(`/sites/${siteId}/config/nginx`, {
        method: 'PUT',
        body: JSON.stringify({ content })
      }),
    getEnv: (siteId: number) =>
      request<{ content: string; path: string }>(`/sites/${siteId}/config/env`),
    saveEnv: (siteId: number, content: string) =>
      request<{ ok: boolean; message: string }>(`/sites/${siteId}/config/env`, {
        method: 'PUT',
        body: JSON.stringify({ content })
      }),
    envVersions: (siteId: number) =>
      request<{ versions: EnvVersionMeta[] }>(`/sites/${siteId}/config/env/versions`),
    envVersion: (siteId: number, vid: number) =>
      request<{ content: string; createdAt: string }>(`/sites/${siteId}/config/env/versions/${vid}`),
    restoreEnvVersion: (siteId: number, vid: number) =>
      request<{ ok: boolean; content: string; message: string }>(`/sites/${siteId}/config/env/versions/${vid}/restore`, {
        method: 'POST'
      }),
    getPhpVersions: (siteId: number) =>
      request<{ current: string; available: string[] }>(`/sites/${siteId}/php-versions`),
    switchPhpVersion: (siteId: number, version: string) =>
      request<{ ok: boolean; reloaded: boolean; message: string }>(`/sites/${siteId}/php-version`, {
        method: 'POST',
        body: JSON.stringify({ version })
      })
  }
}

export interface CleanupResult {
  ok: boolean
  cleanupOk: boolean
  cleanupLog: string
}

export interface BackupSchedule {
  active: boolean
  hour: number
  minute: number
  days: string
  cronPath: string
}

export interface AuditEntry {
  id: number
  action: string
  siteId: number | null
  userId: number | null
  userEmail: string | null
  userRole:  string | null
  meta: Record<string, unknown> | null
  createdAt: string
}

export interface AuditPage {
  logs: AuditEntry[]
  total: number
  limit: number
  offset: number
}

export interface SslStatus {
  active: boolean
  sslEnabled: boolean
  expiresAt: string | null
  issuer: string | null
  daysLeft: number | null
  running: boolean
}

export interface WorkerProcess {
  name: string
  state: string       // RUNNING | STOPPED | STARTING | FATAL | …
  description: string
}

export interface PanelSettings {
  panel_title: string
  panel_url: string
  notify_email: string
  deploy_slack_webhook: string
  deploy_discord_webhook: string
  deploy_telegram_bot_token: string
  deploy_telegram_chat_id: string
  deploy_generic_webhook: string
  cloudflare_api_token?: string
  cloudflare_zone_id?: string
  server_public_ip?: string
  do_api_token?: string
  do_droplet_id?: string
}

export interface Release {
  name: string
  isCurrent: boolean
  createdAt: string
}

export interface ArtisanCommand {
  cmd: string
  label: string
  description: string
  group: string
}

export interface BackupFile {
  name: string
  sizeBytes: number
  createdAt: string
}

export interface SystemStats {
  cpu: { load1: number; load5: number; load15: number; cores: number; percent: number }
  ram: { total: number; used: number; free: number; percent: number }
  disk: { total: number; used: number; percent: number }
  swap: { total: number; used: number; percent: number }
  uptime: number
  hostname: string
}

export interface MetricSample {
  cpuPercent: number
  ramPercent: number
  diskPercent: number
  checkedAt: string
}

export interface MetricsHistory {
  hours: number
  samples: MetricSample[]
}

export interface ServiceStatus {
  key: string
  name: string
  status: 'active' | 'inactive'
}

export interface ProcessService {
  name: string
  cpuPercent: number
  memPercent: number
  rssBytes: number
  count: number
}

export interface ProcessStats {
  cores: number
  services: ProcessService[]
  capturedAt: string
}

export interface DashboardPreset {
  id: number
  name: string
  config: string
  updatedAt: string
}

export interface ApmSite {
  siteId: number
  domain: string
  samples: number
  uptimePct: number | null
  avg: number | null
  p50: number | null
  p95: number | null
  p99: number | null
  max: number | null
}

export interface ApmResult {
  hours: number
  sites: ApmSite[]
}

export interface SystemInfo {
  hostname: string
  kernel: string
  os: string
  uptimeSeconds: number
  pendingUpdates: number
  rebootRequired: boolean
  ufwStatus: 'active' | 'inactive' | null
}

export interface AccessToken {
  id: number
  name: string
  tokenPrefix: string
  lastUsedAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface DigestData {
  since: string
  deploySuccess: number
  deployFailed: number
  uptimePct: number | null
  avgMs: number | null
  errOpen: number
  errNew: number
  sites: number
}

export interface DigestConfig {
  enabled: boolean
  day: number
  lastSent: string | null
  preview: DigestData
}

export interface TelegramStatus {
  linked: boolean
  username: string | null
  linkedAt: string | null
  botConfigured: boolean
  botUsername: string
  webhookConfigured: boolean
}

export interface AppNotification {
  id: number
  type: string
  level: 'info' | 'success' | 'warning' | 'critical'
  title: string
  body: string | null
  meta: string | null
  read: boolean
  createdAt: string
}

export interface AlertRule {
  id: number
  metric: 'cpu' | 'ram' | 'disk' | 'swap'
  operator: 'gt' | 'lt'
  threshold: number
  enabled: boolean
  cooldownMins: number
  lastTriggeredAt: string | null
  createdAt: string
}

export interface LogErrorItem {
  id: number
  siteId: number
  level: string
  exceptionClass: string | null
  message: string
  count: number
  firstSeenAt: string
  lastSeenAt: string
  resolved: boolean
  ignored: boolean
  site: { domain: string }
}

export interface LogErrorDetail {
  id: number
  siteId: number
  level: string
  exceptionClass: string | null
  message: string
  sample: string | null
  count: number
  firstSeenAt: string
  lastSeenAt: string
  resolved: boolean
  ignored: boolean
  site: { id: number; domain: string }
  introducedBy: { id: number; branch: string; commit: string | null; createdAt: string } | null
}

export interface EnvVersionMeta {
  id: number
  note: string | null
  createdAt: string
  createdBy: { email: string } | null
}

export interface PendingCommit {
  hash: string
  subject: string
  author: string
  date: string
}

export interface PendingChanges {
  branch: string
  currentCommit: string | null
  remoteCommit: string
  upToDate: boolean
  range: boolean
  commits: PendingCommit[]
}

export interface ServiceControlResult {
  ok: boolean
  key: string
  serviceName: string
  action: string
  status: 'active' | 'inactive'
  output: string
}

// ── DigitalOcean droplet control (Server page) ──────────────────────────────
export interface DODroplet {
  id: number
  name: string
  status: 'active' | 'off' | 'archive' | 'new'
  memory: number
  vcpus: number
  disk: number
  region: { slug: string; name: string }
  image: { slug: string | null; distribution: string; name: string }
  size: { slug: string; memory: number; vcpus: number; disk: number; price_monthly: number }
  size_slug: string
  networks: { v4: { ip_address: string; type: string }[]; v6: { ip_address: string; type: string }[] }
  created_at: string
  tags: string[]
  backup_ids: number[]
  snapshot_ids: number[]
  features: string[]
  next_backup_window: { start: string; end: string } | null
}

export interface DOSize {
  slug: string
  memory: number
  vcpus: number
  disk: number
  transfer: number
  price_monthly: number
  price_hourly: number
  regions: string[]
  available: boolean
  description: string
}

export interface DOAction {
  id: number
  status: 'in-progress' | 'completed' | 'errored'
  type: string
  started_at: string
  completed_at: string | null
  resource_id: number
  resource_type: string
  region: { slug: string } | null
}

export interface DOSnapshot {
  id: string
  name: string
  created_at: string
  min_disk_size: number
  size_gigabytes: number
}

export interface DOBackup {
  id: number
  name: string
  created_at: string
  min_disk_size: number
  size_gigabytes: number
}

export interface DOFirewallRule {
  protocol: string
  ports: string
  sources?: { addresses?: string[] }
  destinations?: { addresses?: string[] }
}

export interface DOFirewall {
  id: string
  name: string
  status: string
  inbound_rules: DOFirewallRule[]
  outbound_rules: DOFirewallRule[]
  droplet_ids: number[]
}

export interface ServerStatus {
  configured: boolean
  needsDropletSelection: boolean
  droplet: DODroplet | null
}

export interface UptimeSiteStatus {
  siteId: number
  domain: string
  monitoring: boolean
  status: 'up' | 'down' | 'unknown'
  responseMs: number | null
  statusCode: number | null
  checkedAt: string | null
}

export interface SslExpiry {
  siteId: number
  domain: string
  daysLeft: number | null
  expiresAt: string | null
  error: string | null
}

export const uptimeApi = {
  list: () => request<{ sites: UptimeSiteStatus[] }>('/uptime'),
  history: (siteId: number) =>
    request<{ checks: UptimeCheck[]; uptime24h: number | null }>(`/uptime/${siteId}/history`),
  toggle: (siteId: number, monitoring: boolean) =>
    request<{ ok: boolean; monitoring: boolean }>(`/uptime/${siteId}`, {
      method: 'PATCH',
      body: JSON.stringify({ monitoring })
    })
}

export interface UptimeCheck {
  id: number
  siteId: number
  status: string
  responseMs: number | null
  statusCode: number | null
  checkedAt: string
}

export const sslExpiryApi = {
  all: () => request<{ sites: SslExpiry[] }>('/monitor/ssl')
}

export const statsApi = {
  history: () => request<{ days: { date: string; success: number; failed: number }[] }>('/monitor/stats/history')
}

export const composerApi = {
  outdated: (siteId: number) =>
    request<{ packages: ComposerPackage[] }>(`/sites/${siteId}/composer/outdated`),
  update: (siteId: number, pkg?: string) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/composer/update`, {
      method: 'POST',
      body: JSON.stringify(pkg ? { package: pkg } : {})
    })
}

export interface ComposerPackage {
  name: string
  version: string
  latest: string
  description?: string
  'latest-status'?: string
}

export const failedJobsApi = {
  list:     (siteId: number) => request<{ jobs: FailedJob[] }>(`/sites/${siteId}/failed-jobs`),
  retry:    (siteId: number, jobId: string) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/failed-jobs/${jobId}/retry`, { method: 'POST' }),
  retryAll: (siteId: number) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/failed-jobs/retry-all`, { method: 'POST' }),
  delete:   (siteId: number, jobId: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/failed-jobs/${jobId}`, { method: 'DELETE' }),
  flush:    (siteId: number) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/failed-jobs`, { method: 'DELETE' }),
  queueStats: (siteId: number) =>
    request<{ pending: number | null; failed: number | null }>(`/sites/${siteId}/queue/stats`)
}

export interface FailedJob {
  id: string | number
  connection: string
  queue: string
  payload?: string
  exception?: string
  failed_at: string
  class?: string
}

export const phpFpmApi = {
  get:  (siteId: number) => request<{ content: string; path: string; exists: boolean }>(`/sites/${siteId}/phpfpm`),
  save: (siteId: number, content: string) =>
    request<{ ok: boolean; reloaded: boolean; path: string }>(`/sites/${siteId}/phpfpm`, {
      method: 'PUT',
      body: JSON.stringify({ content })
    })
}

export const s3Api = {
  upload: (siteId: number, filename: string) =>
    request<{ ok: boolean; key: string; bucket: string }>(`/sites/${siteId}/database/backup/s3/${filename}`, {
      method: 'POST'
    }),
  list:   (siteId: number) =>
    request<{ files: S3File[]; configured: boolean; bucket?: string }>(`/sites/${siteId}/database/backup/s3`),
  delete: (siteId: number, key: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/database/backup/s3/${key}`, { method: 'DELETE' }),
  saveSettings: (data: { s3_access_key: string; s3_secret_key: string; s3_region: string; s3_bucket: string; s3_endpoint?: string }) =>
    request<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(data) })
}

export interface S3File {
  key: string
  filename: string
  sizeBytes: number
  lastModified: string | null
}

export const maintenanceApi = {
  get: (siteId: number) =>
    request<{ maintenanceMode: boolean }>(`/sites/${siteId}/maintenance`),
  toggle: (siteId: number, action: 'down' | 'up', secret?: string) =>
    request<{ ok: boolean; action: string; output: string }>(
      `/sites/${siteId}/maintenance`,
      { method: 'POST', body: JSON.stringify({ action, ...(secret ? { secret } : {}) }) }
    )
}

export const schedulerApi = {
  get: (siteId: number) =>
    request<{ active: boolean; cronPath: string; cronContent: string }>(`/sites/${siteId}/scheduler`),
  enable: (siteId: number) =>
    request<{ ok: boolean; cronPath: string }>(`/sites/${siteId}/scheduler`, { method: 'PUT', body: '{}' }),
  disable: (siteId: number) =>
    request<{ ok: boolean }>(`/sites/${siteId}/scheduler`, { method: 'DELETE' })
}

export const logsApi = {
  list: (siteId: number, params?: { level?: string; search?: string; lines?: number }) => {
    const q = new URLSearchParams()
    if (params?.level)  q.set('level', params.level)
    if (params?.search) q.set('search', params.search)
    if (params?.lines)  q.set('lines', String(params.lines))
    const qs = q.toString()
    return request<{ entries: LogEntry[]; total: number; path: string }>(`/sites/${siteId}/logs${qs ? `?${qs}` : ''}`)
  },
  clear: (siteId: number) => request<{ ok: boolean }>(`/sites/${siteId}/logs`, { method: 'DELETE' })
}

export interface LogEntry {
  timestamp: string | null
  environment: string | null
  level: string
  message: string
}

export const healthApi = {
  score: (siteId: number) =>
    request<{ score: number; breakdown: { uptime: number; deploy: number; ssl: number; maintenance: number } }>(
      `/monitor/health-score/${siteId}`
    )
}

export const sparklineApi = {
  get: (siteId: number) =>
    request<{ points: { ms: number | null; status: string; at: string }[] }>(`/uptime/${siteId}/sparkline`)
}

export const heatmapApi = {
  get: (siteId: number) =>
    request<{ days: Record<string, { total: number; success: number; failed: number }> }>(
      `/sites/${siteId}/deployments/heatmap`
    )
}

export const redeployApi = {
  trigger: (siteId: number, deployId: number) =>
    request<{ ok: boolean; deploymentId?: number; queued?: boolean; message?: string }>(
      `/sites/${siteId}/deployments/${deployId}/redeploy`,
      { method: 'POST' }
    ),
  // Admin-only escape hatch for a deploy stuck on 'running' (e.g. a hung
  // git clone / composer install after a network stall). Kills the process
  // if still tracked, or force-marks the row failed if it's orphaned from a
  // previous API process lifetime.
  cancel: (siteId: number) =>
    request<{ ok: boolean; message: string }>(
      `/sites/${siteId}/deploy/cancel`,
      { method: 'POST' }
    )
}

// ── File Manager API ──────────────────────────────────────────────────────────
export interface FMEntry {
  name: string
  type: 'file' | 'dir' | 'symlink'
  size: number
  modified: string
  permissions: string    // e.g. "755"
  permsDisplay: string   // e.g. "rwxr-xr-x"
  owner: string
  group: string
  ext: string
  mime: string
}

export interface FMListResult {
  entries: FMEntry[]
  path: string
  rootPath: string
}

export const fmApi = {
  list: (siteId: number, p: string, opts?: { hidden?: boolean; sort?: string; order?: string }) => {
    const q = new URLSearchParams({ path: p })
    if (opts?.hidden) q.set('hidden', '1')
    if (opts?.sort)   q.set('sort', opts.sort)
    if (opts?.order)  q.set('order', opts.order)
    return request<FMListResult>(`/sites/${siteId}/files?${q}`)
  },
  read: (siteId: number, p: string) =>
    request<{ content: string; ext: string; mime: string; size: number; binary: boolean; path: string }>(
      `/sites/${siteId}/files/read?path=${encodeURIComponent(p)}`
    ),
  write: (siteId: number, p: string, content: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/write`, {
      method: 'PUT', body: JSON.stringify({ path: p, content })
    }),
  mkdir: (siteId: number, p: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/mkdir`, {
      method: 'POST', body: JSON.stringify({ path: p })
    }),
  touch: (siteId: number, p: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/touch`, {
      method: 'POST', body: JSON.stringify({ path: p })
    }),
  delete: (siteId: number, paths: string[]) =>
    request<{ results: { path: string; ok: boolean; error?: string }[] }>(`/sites/${siteId}/files/delete`, {
      method: 'DELETE', body: JSON.stringify({ paths })
    }),
  rename: (siteId: number, from: string, to: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/rename`, {
      method: 'POST', body: JSON.stringify({ from, to })
    }),
  copy: (siteId: number, paths: string[], dest: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/copy`, {
      method: 'POST', body: JSON.stringify({ paths, dest })
    }),
  move: (siteId: number, paths: string[], dest: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/move`, {
      method: 'POST', body: JSON.stringify({ paths, dest })
    }),
  zip: (siteId: number, paths: string[], dest: string) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/files/zip`, {
      method: 'POST', body: JSON.stringify({ paths, dest })
    }),
  unzip: (siteId: number, p: string, dest: string) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/files/unzip`, {
      method: 'POST', body: JSON.stringify({ path: p, dest })
    }),
  tar: (siteId: number, paths: string[], dest: string) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/tar`, {
      method: 'POST', body: JSON.stringify({ paths, dest })
    }),
  untar: (siteId: number, p: string, dest: string) =>
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/files/untar`, {
      method: 'POST', body: JSON.stringify({ path: p, dest })
    }),
  chmod: (siteId: number, paths: string[], mode: string, recursive?: boolean) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/chmod`, {
      method: 'POST', body: JSON.stringify({ paths, mode, recursive })
    }),
  chown: (siteId: number, paths: string[], owner: string, group?: string, recursive?: boolean) =>
    request<{ ok: boolean }>(`/sites/${siteId}/files/chown`, {
      method: 'POST', body: JSON.stringify({ paths, owner, group, recursive })
    }),
  search: (siteId: number, p: string, q: string, type?: 'name' | 'content') => {
    const qs = new URLSearchParams({ path: p, q, ...(type ? { type } : {}) })
    return request<{ results: { path: string; name: string }[] }>(`/sites/${siteId}/files/search?${qs}`)
  },
  diff: (siteId: number, a: string, b: string) => {
    const q = new URLSearchParams({ a, b })
    return request<{ diff: string }>(`/sites/${siteId}/files/diff?${q}`)
  },
  properties: (siteId: number, p: string) =>
    request<FMEntry & { totalSize: number }>(`/sites/${siteId}/files/properties?path=${encodeURIComponent(p)}`),
  downloadUrl: (siteId: number, p: string) =>
    `/api/sites/${siteId}/files/download?path=${encodeURIComponent(p)}`,
  downloadZip: async (siteId: number, paths: string[], name: string) => {
    const token = localStorage.getItem('orchestrator_token')
    const res = await fetch(`/api/sites/${siteId}/files/download-zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ paths, name })
    })
    if (!res.ok) throw new Error('Download failed')
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = `${name}.zip`
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    URL.revokeObjectURL(url)
  },
  upload: async (siteId: number, dest: string, files: File[], onProgress?: (pct: number) => void) => {
    const token = localStorage.getItem('orchestrator_token')
    const formData = new FormData()
    files.forEach(f => formData.append('files', f))
    return new Promise<{ results: { filename: string; ok: boolean; size?: number; error?: string }[] }>((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `/api/sites/${siteId}/files/upload?dest=${encodeURIComponent(dest)}`)
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round(e.loaded / e.total * 100)) }
      xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)) } catch { reject(new Error('Upload failed')) } }
      xhr.onerror = () => reject(new Error('Network error'))
      xhr.send(formData)
    })
  }
}

// ── Database Management API ────────────────────────────────────────────────────

export interface SiteDatabase {
  id: number
  siteId: number
  dbName: string
  dbUser: string
  isPrimary: boolean
  createdAt: string
}

export interface QueryResult {
  columns: string[]
  rows: unknown[][]
  rowCount: number
  truncated: boolean
  elapsedMs: number
}

export const dbManageApi = {
  list: (siteId: number) =>
    request<{ databases: SiteDatabase[] }>(`/sites/${siteId}/databases`),
  create: (siteId: number, data: { dbName: string; dbUser: string }) =>
    request<SiteDatabase>(`/sites/${siteId}/databases`, {
      method: 'POST',
      body: JSON.stringify(data)
    }),
  remove: (siteId: number, dbId: number) =>
    request<{ ok: boolean }>(`/sites/${siteId}/databases/${dbId}`, { method: 'DELETE' }),
  runQuery: (siteId: number, dbId: number, sql: string) =>
    request<QueryResult>(`/sites/${siteId}/databases/${dbId}/query`, {
      method: 'POST',
      body: JSON.stringify({ sql })
    }),
  importSql: async (siteId: number, dbId: number, file: File): Promise<{ ok: boolean; warnings: string | null }> => {
    const token = localStorage.getItem(TOKEN_KEY)
    const form = new FormData()
    form.append('file', file)
    // Must NOT set Content-Type — browser auto-sets multipart/form-data with boundary
    const res = await fetch(`/api/sites/${siteId}/databases/${dbId}/import`, {
      method: 'POST',
      body: form,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    if (res.status === 401) { localStorage.removeItem(TOKEN_KEY); window.location.href = '/login' }
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string }
      throw new Error(err.error ?? `HTTP ${res.status}`)
    }
    return res.json()
  },
  openPma: (siteId: number, dbId: number) =>
    request<{ url: string }>(`/sites/${siteId}/databases/${dbId}/pma-session`, { method: 'POST' })
}

// ── Users / Team API ───────────────────────────────────────────────────────────

export interface UserRecord {
  id: number
  email: string
  role: 'admin' | 'developer' | 'viewer'
  allSitesAccess: boolean
  createdAt: string
}

export const usersApi = {
  list: () =>
    request<{ users: UserRecord[] }>('/users'),
  create: (data: { email: string; password: string; role: string }) =>
    request<UserRecord>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { email?: string; role?: string; allSitesAccess?: boolean }) =>
    request<UserRecord>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) =>
    request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  getSites: (id: number) =>
    request<{ siteIds: number[]; allSitesAccess: boolean }>(`/users/${id}/sites`),
  setSites: (id: number, siteIds: number[]) =>
    request<{ ok: boolean; siteIds: number[] }>(`/users/${id}/sites`, {
      method: 'PUT',
      body: JSON.stringify({ siteIds })
    })
}

// ── Directory (minimal user list, available to every role) ──────────────────
export interface DirectoryUser {
  id: number
  email: string
  role: string
}

export const directoryApi = {
  list: () => request<{ users: DirectoryUser[] }>('/directory')
}

// ── Tasks (Kanban) ────────────────────────────────────────────────────────────
export type TaskStatus = 'todo' | 'in_progress' | 'review' | 'done'
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent'

export interface TaskChecklistItem {
  id: number
  taskId: number
  text: string
  done: boolean
  position: number
}

export interface TaskComment {
  id: number
  taskId: number
  userId: number
  body: string
  createdAt: string
  user: { id: number; email: string }
}

export interface Task {
  id: number
  title: string
  description: string | null
  status: TaskStatus
  priority: TaskPriority
  position: number
  dueDate: string | null
  tags: string // JSON string array
  siteId: number | null
  site: { id: number; domain: string; name: string } | null
  assigneeId: number | null
  assignee: { id: number; email: string } | null
  createdById: number
  createdBy: { id: number; email: string }
  checklist: TaskChecklistItem[]
  comments?: TaskComment[]
  _count?: { comments: number }
  createdAt: string
  updatedAt: string
}

export const tasksApi = {
  list: (params?: { siteId?: number; assigneeId?: number; status?: string; mine?: boolean }) => {
    const qs = new URLSearchParams()
    if (params?.siteId) qs.set('siteId', String(params.siteId))
    if (params?.assigneeId) qs.set('assigneeId', String(params.assigneeId))
    if (params?.status) qs.set('status', params.status)
    if (params?.mine) qs.set('mine', '1')
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<{ tasks: Task[] }>(`/tasks${suffix}`)
  },
  get: (id: number) => request<Task>(`/tasks/${id}`),
  create: (data: {
    title: string; description?: string; status?: TaskStatus; priority?: TaskPriority
    dueDate?: string; tags?: string[]; siteId?: number; assigneeId?: number
  }) => request<Task>('/tasks', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<{
    title: string; description: string | null; status: TaskStatus; priority: TaskPriority
    position: number; dueDate: string | null; tags: string[]; siteId: number | null; assigneeId: number | null
  }>) => request<Task>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<{ ok: boolean }>(`/tasks/${id}`, { method: 'DELETE' }),

  addChecklistItem: (taskId: number, text: string) =>
    request<TaskChecklistItem>(`/tasks/${taskId}/checklist`, { method: 'POST', body: JSON.stringify({ text }) }),
  updateChecklistItem: (taskId: number, itemId: number, data: Partial<{ text: string; done: boolean; position: number }>) =>
    request<TaskChecklistItem>(`/tasks/${taskId}/checklist/${itemId}`, { method: 'PATCH', body: JSON.stringify(data) }),
  removeChecklistItem: (taskId: number, itemId: number) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/checklist/${itemId}`, { method: 'DELETE' }),

  addComment: (taskId: number, body: string) =>
    request<TaskComment>(`/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  removeComment: (taskId: number, commentId: number) =>
    request<{ ok: boolean }>(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' })
}

// ── Notes ─────────────────────────────────────────────────────────────────────
export interface NoteShareEntry {
  userId: number
  canEdit: boolean
  user: { id: number; email: string }
}

export interface Note {
  id: number
  title: string
  body: string
  pinned: boolean
  isPublic: boolean
  tags: string // JSON string array
  siteId: number | null
  site: { id: number; domain: string; name: string } | null
  ownerId: number
  owner: { id: number; email: string }
  shares: NoteShareEntry[]
  canEdit: boolean
  createdAt: string
  updatedAt: string
}

export const notesApi = {
  list: (params?: { search?: string; tag?: string; pinned?: boolean; siteId?: number }) => {
    const qs = new URLSearchParams()
    if (params?.search) qs.set('search', params.search)
    if (params?.tag) qs.set('tag', params.tag)
    if (params?.pinned) qs.set('pinned', '1')
    if (params?.siteId) qs.set('siteId', String(params.siteId))
    const suffix = qs.toString() ? `?${qs}` : ''
    return request<{ notes: Note[] }>(`/notes${suffix}`)
  },
  get: (id: number) => request<Note>(`/notes/${id}`),
  create: (data: { title: string; body?: string; tags?: string[]; pinned?: boolean; isPublic?: boolean; siteId?: number }) =>
    request<Note>('/notes', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<{ title: string; body: string; tags: string[]; pinned: boolean; isPublic: boolean; siteId: number | null }>) =>
    request<Note>(`/notes/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<{ ok: boolean }>(`/notes/${id}`, { method: 'DELETE' }),
  setShares: (id: number, shares: { userId: number; canEdit?: boolean }[]) =>
    request<Note>(`/notes/${id}/shares`, { method: 'PUT', body: JSON.stringify({ shares }) })
}

// ── Calendar ──────────────────────────────────────────────────────────────────
export type CalendarEventKind = 'event' | 'task_due'

export interface CalendarEvent {
  id: string // synthetic for occurrences/virtual entries, e.g. "event-12" or "task-7"
  kind: CalendarEventKind
  title: string
  description: string | null
  type: string
  startAt: string
  endAt: string | null
  allDay: boolean
  color: string | null
  recurrence: 'daily' | 'weekly' | 'monthly' | null
  siteId: number | null
  site: { id: number; domain: string; name: string } | null
  taskId: number | null
  task: { id: number; title: string; status: string } | null
  createdBy: { id: number; email: string } | null
  attendees: { userId: number; user: { id: number; email: string } }[]
  editable: boolean
}

export const calendarApi = {
  list: (params: { start: string; end: string; siteId?: number }) => {
    const qs = new URLSearchParams({ start: params.start, end: params.end })
    if (params.siteId) qs.set('siteId', String(params.siteId))
    return request<{ events: CalendarEvent[] }>(`/calendar/events?${qs}`)
  },
  create: (data: {
    title: string; description?: string; type?: string; startAt: string; endAt?: string
    allDay?: boolean; color?: string; recurrence?: 'daily' | 'weekly' | 'monthly'
    reminderMins?: number; siteId?: number; taskId?: number; attendeeIds?: number[]
  }) => request<CalendarEvent>('/calendar/events', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: Partial<{
    title: string; description: string | null; type: string; startAt: string; endAt: string | null
    allDay: boolean; color: string | null; recurrence: 'daily' | 'weekly' | 'monthly' | null
    reminderMins: number | null; siteId: number | null; taskId: number | null; attendeeIds: number[]
  }>) => request<CalendarEvent>(`/calendar/events/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) => request<{ ok: boolean }>(`/calendar/events/${id}`, { method: 'DELETE' })
}

