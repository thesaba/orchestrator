const TOKEN_KEY = 'orchestrator_token'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY)
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
  createdAt: string
}

export const api = {
  auth: {
    login: (email: string, password: string) =>
      request<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      }),
    me: () => request<{ userId: number; email: string }>('/auth/me')
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
    update: (id: number, data: { repoUrl?: string; branch?: string; name?: string }) =>
      request<Site>(`/sites/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
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
      request<{ started: boolean; deploymentId: number }>(`/sites/${siteId}/deploy`, {
        method: 'POST'
      }),
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
    enableBackupSchedule: (siteId: number, hour: number) =>
      request<{ ok: boolean; cronPath: string; hour: number }>(
        `/sites/${siteId}/database/backup-schedule`,
        { method: 'PUT', body: JSON.stringify({ hour }) }
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
  cronPath: string
}

export interface AuditEntry {
  id: number
  action: string
  siteId: number | null
  userId: number | null
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
