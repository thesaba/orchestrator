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
  maintenanceMode: boolean
  uptimeMonitor: boolean
  pinned: boolean
  tags: string   // JSON string
  notes: string | null
  createdAt: string
  updatedAt: string
  deployments: Deployment[]
}

export interface Deployment {
  id: number
  siteId: number
  commit: string | null
  branch: string
  status: 'pending' | 'running' | 'success' | 'failed'
  log: string | null
  comment?: string | null
  createdAt: string
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
      repoUrl?: string; branch?: string; name?: string; gitToken?: string
      preDeploy?: string; postDeploy?: string; healthCheck?: boolean; healthCheckUrl?: string
      tags?: string[]; pinned?: boolean; notes?: string
    }) =>
      request<Site>(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    clone: (id: number, data: { name: string; domain: string }) =>
      request<Site>(`/sites/${id}/clone`, { method: 'POST', body: JSON.stringify(data) }),
    branches: (id: number) =>
      request<{ branches: string[] }>(`/sites/${id}/branches`),
    tags: () =>
      request<{ tags: string[] }>('/sites/tags')
  },
  provision: {
    start: (
      siteId: number,
      data: { dbName: string; dbUser: string; dbPassword: string }
    ) =>
      request<{ started: boolean; siteId: number }>(`/sites/${siteId}/provision`, {
        method: 'POST',
        body: JSON.stringify(data)
      })
  },
  deploy: {
    trigger: (siteId: number) =>
      request<{ started: boolean; deploymentId: number } | { queued: boolean; message: string }>(
        `/sites/${siteId}/deploy`, { method: 'POST' }
      ),
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
      })
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
  uptime: number
  hostname: string
}

export interface ServiceStatus {
  key: string
  name: string
  status: 'active' | 'inactive'
}

export interface ServiceControlResult {
  ok: boolean
  key: string
  serviceName: string
  action: string
  status: 'active' | 'inactive'
  output: string
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
    request<{ ok: boolean; output: string }>(`/sites/${siteId}/failed-jobs`, { method: 'DELETE' })
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
    request<{ ok: boolean; deploymentId: number }>(
      `/sites/${siteId}/deployments/${deployId}/redeploy`,
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
    })
}

// ── Users / Team API ───────────────────────────────────────────────────────────

export interface UserRecord {
  id: number
  email: string
  role: 'admin' | 'developer' | 'viewer'
  createdAt: string
}

export const usersApi = {
  list: () =>
    request<{ users: UserRecord[] }>('/users'),
  create: (data: { email: string; password: string; role: string }) =>
    request<UserRecord>('/users', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: number, data: { email?: string; role?: string }) =>
    request<UserRecord>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: number) =>
    request<{ ok: boolean }>(`/users/${id}`, { method: 'DELETE' }),
  getSites: (id: number) =>
    request<{ siteIds: number[] }>(`/users/${id}/sites`),
  setSites: (id: number, siteIds: number[]) =>
    request<{ ok: boolean; siteIds: number[] }>(`/users/${id}/sites`, {
      method: 'PUT',
      body: JSON.stringify({ siteIds })
    })
}

