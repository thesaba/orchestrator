import {
  Page,
  Card,
  Tabs,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  DataTable,
  Button,
  Modal,
  TextField,
  Banner,
  SkeletonPage,
  SkeletonBodyText,
  Divider,
  CalloutCard,
  InlineCode,
  Select
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { api, ArtisanCommand, BackupFile, Deployment, Release, Site } from '../api/client'
import { ProvisionLog } from '../components/ProvisionLog'
import { ConfigEditor } from '../components/ConfigEditor'
import { WorkersTab } from '../components/WorkersTab'
import { SslTab } from '../components/SslTab'
import { useToast } from '../context/toast'

const DESTRUCTIVE_ARTISAN = new Set([
  'migrate:rollback',
  'migrate:fresh',
  'migrate:reset',
  'db:wipe',
  'db:seed'
])

const STATUS_TONE: Record<string, 'success' | 'warning' | 'critical' | 'info'> = {
  active: 'success',
  provisioning: 'info',
  pending: 'warning',
  error: 'critical',
  success: 'success',
  running: 'info',
  failed: 'critical'
}

export function SiteDetailPage() {
  const { id } = useParams<{ id: string }>()
  const siteId = Number(id)
  const navigate = useNavigate()

  const [site, setSite] = useState<Site | null>(null)
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState(0)

  // Deploy state
  const [deploying, setDeploying] = useState(false)
  const [deployError, setDeployError] = useState('')
  const [deployResult, setDeployResult] = useState<'success' | 'failed' | null>(null)

  // Releases / rollback
  const [releases, setReleases] = useState<Release[]>([])
  const [releasesLoaded, setReleasesLoaded] = useState(false)
  const [rollingBack, setRollingBack] = useState<string | null>(null)

  const showToast = useToast()

  // Deploy settings (edit)
  const [repoUrl, setRepoUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [savingRepo, setSavingRepo] = useState(false)

  // Delete modal
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [cleanupServer, setCleanupServer] = useState(false)
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; log: string } | null>(null)

  // Deployment log modal
  const [logModal, setLogModal] = useState<Deployment | null>(null)

  // Database tab state
  const [backups, setBackups] = useState<BackupFile[]>([])
  const [backupsLoaded, setBackupsLoaded] = useState(false)
  const [creatingBackup, setCreatingBackup] = useState(false)
  const [backupError, setBackupError] = useState('')
  const [deletingBackup, setDeletingBackup] = useState<string | null>(null)

  // Backup schedule state
  const [scheduleActive, setScheduleActive] = useState(false)
  const [scheduleHour, setScheduleHour] = useState(2)
  const [scheduleLoaded, setScheduleLoaded] = useState(false)
  const [savingSchedule, setSavingSchedule] = useState(false)

  // Artisan tab state
  const [artisanCommands, setArtisanCommands] = useState<ArtisanCommand[]>([])
  const [artisanCommandsLoaded, setArtisanCommandsLoaded] = useState(false)
  const [artisanRunning, setArtisanRunning] = useState(false)
  const [artisanActiveCmd, setArtisanActiveCmd] = useState('')
  const [artisanFailed, setArtisanFailed] = useState(false)
  const [artisanError, setArtisanError] = useState('')

  // Artisan destructive confirmation
  const [destructiveCmd, setDestructiveCmd] = useState<string | null>(null)

  // Panel URL for webhook display (loaded when Deploy Settings tab opens)
  const [panelUrl, setPanelUrl] = useState('')

  // Config tab state
  const [nginxContent, setNginxContent] = useState('')
  const [nginxPath, setNginxPath] = useState('')
  const [envContent, setEnvContent] = useState('')
  const [envPath, setEnvPath] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configLoaded, setConfigLoaded] = useState(false)

  // PHP version switcher
  const [phpVersions, setPhpVersions] = useState<string[]>([])
  const [phpSelected, setPhpSelected] = useState('')
  const [phpSwitching, setPhpSwitching] = useState(false)
  const [phpError, setPhpError] = useState('')

  const fetchSite = useCallback(async () => {
    try {
      const s = await api.sites.get(siteId)
      setSite(s)
      setRepoUrl(s.repoUrl ?? '')
      setBranch(s.branch)
      // Reconnect to running deploy on page refresh
      if (s.deployments.some((d) => d.status === 'running') && !deploying) {
        setDeploying(true)
      }
    } catch {
      navigate('/sites')
    } finally {
      setLoading(false)
    }
  }, [siteId, navigate, deploying])

  useEffect(() => { fetchSite() }, [siteId]) // eslint-disable-line

  // Load Deploy Settings tab data (PHP versions + panel URL for webhook)
  useEffect(() => {
    if (tab !== 1) return
    if (phpVersions.length === 0) {
      api.config.getPhpVersions(siteId)
        .then((r) => { setPhpVersions(r.available); setPhpSelected(r.current) })
        .catch(() => {})
    }
    if (!panelUrl) {
      api.settings.get()
        .then((s) => setPanelUrl(s.panel_url?.trim() || window.location.origin))
        .catch(() => setPanelUrl(window.location.origin))
    }
  }, [tab, siteId, phpVersions.length, panelUrl])

  const handlePhpSwitch = async () => {
    if (!phpSelected || !site || phpSelected === site.phpVersion) return
    setPhpSwitching(true)
    setPhpError('')
    try {
      const r = await api.config.switchPhpVersion(siteId, phpSelected)
      showToast(r.message)
      fetchSite()
    } catch (err: unknown) {
      setPhpError(err instanceof Error ? err.message : 'Switch failed')
    } finally {
      setPhpSwitching(false)
    }
  }

  const handleDeploy = async () => {
    if (!site?.repoUrl) {
      setTab(1)
      setDeployError('Set a repository URL in the Deploy Settings tab first.')
      return
    }
    setDeployError('')
    setDeployResult(null)
    try {
      await api.deploy.trigger(siteId)
      setDeploying(true)
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : 'Deploy failed to start')
    }
  }

  // Load on-disk releases when Deployments tab is visible
  const loadReleases = useCallback(async () => {
    try {
      const r = await api.releases.list(siteId)
      setReleases(r.releases)
      setReleasesLoaded(true)
    } catch { /* releases dir not yet created — ignore */ }
  }, [siteId])

  useEffect(() => {
    if (tab !== 0) return
    loadReleases()
  }, [tab, loadReleases])

  const handleRollback = async (releaseName: string) => {
    setRollingBack(releaseName)
    setDeployError('')
    setDeployResult(null)
    try {
      await api.releases.rollback(siteId, releaseName)
      setDeploying(true)
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : 'Rollback failed')
      setRollingBack(null)
    }
  }

  const handleDeployComplete = useCallback(
    (status: string) => {
      setDeploying(false)
      setRollingBack(null)
      setDeployResult(status === 'success' ? 'success' : 'failed')
      fetchSite()
      loadReleases()
    },
    [fetchSite, loadReleases]
  )

  const handleSaveRepo = async () => {
    setSavingRepo(true)
    try {
      await api.sites.update(siteId, { repoUrl, branch })
      await fetchSite()
      showToast('Deploy settings saved')
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
    } finally {
      setSavingRepo(false)
    }
  }

  const handleGenerateToken = async () => {
    await api.deploy.generateWebhookToken(siteId)
    await fetchSite()
  }

  // Load backups + schedule when Database tab is selected
  useEffect(() => {
    if (tab !== 3) return
    if (!backupsLoaded) {
      api.database.listBackups(siteId)
        .then((r) => { setBackups(r.backups); setBackupsLoaded(true) })
        .catch(() => {})
    }
    if (!scheduleLoaded) {
      api.database.getBackupSchedule(siteId)
        .then((s) => { setScheduleActive(s.active); setScheduleHour(s.hour); setScheduleLoaded(true) })
        .catch(() => setScheduleLoaded(true))
    }
  }, [tab, siteId, backupsLoaded, scheduleLoaded])

  const handleCreateBackup = async () => {
    setCreatingBackup(true)
    setBackupError('')
    try {
      const result = await api.database.createBackup(siteId)
      showToast(`Backup created: ${result.filename} (${result.sizeHuman})`)
      const r = await api.database.listBackups(siteId)
      setBackups(r.backups)
    } catch (err: unknown) {
      setBackupError(err instanceof Error ? err.message : 'Backup failed')
    } finally {
      setCreatingBackup(false)
    }
  }

  const handleDeleteBackup = async (filename: string) => {
    setDeletingBackup(filename)
    try {
      await api.database.deleteBackup(siteId, filename)
      setBackups((prev) => prev.filter((b) => b.name !== filename))
    } catch {
      /* ignore */
    } finally {
      setDeletingBackup(null)
    }
  }

  const handleDownloadBackup = async (filename: string) => {
    try {
      await api.database.downloadBackup(siteId, filename)
    } catch {
      /* ignore — browser will show native download error */
    }
  }

  // Load artisan command list when Artisan tab is first selected
  useEffect(() => {
    if (tab !== 4 || artisanCommandsLoaded) return
    api.artisan.commands(siteId)
      .then((r) => { setArtisanCommands(r.commands); setArtisanCommandsLoaded(true) })
      .catch(() => {})
  }, [tab, siteId, artisanCommandsLoaded])

  const runArtisan = async (command: string) => {
    setArtisanActiveCmd(command)
    setArtisanFailed(false)
    setArtisanError('')
    try {
      await api.artisan.run(siteId, command)
      setArtisanRunning(true)
    } catch (err: unknown) {
      setArtisanError(err instanceof Error ? err.message : 'Failed to start command')
    }
  }

  const handleRunArtisan = (command: string) => {
    if (DESTRUCTIVE_ARTISAN.has(command)) {
      setDestructiveCmd(command)
    } else {
      runArtisan(command)
    }
  }

  const confirmDestructive = () => {
    if (destructiveCmd) {
      runArtisan(destructiveCmd)
      setDestructiveCmd(null)
    }
  }

  const handleArtisanComplete = useCallback((status: string) => {
    setArtisanRunning(false)
    if (status === 'success') {
      setArtisanFailed(false)
      showToast(`artisan ${artisanActiveCmd}: completed successfully`)
    } else {
      setArtisanFailed(true)
    }
  }, [artisanActiveCmd, showToast])

  // Load configs once when Config tab is selected
  useEffect(() => {
    if (tab !== 2 || configLoaded) return
    setConfigLoading(true)
    Promise.all([
      api.config.getNginx(siteId),
      api.config.getEnv(siteId)
    ]).then(([nginx, env]) => {
      setNginxContent(nginx.content)
      setNginxPath(nginx.path)
      setEnvContent(env.content)
      setEnvPath(env.path)
      setConfigLoaded(true)
    }).catch(() => {}).finally(() => setConfigLoading(false))
  }, [tab, siteId, configLoaded])

  const handleSaveNginx = useCallback(async () => {
    await api.config.saveNginx(siteId, nginxContent)
  }, [siteId, nginxContent])

  const handleSaveEnv = useCallback(async () => {
    await api.config.saveEnv(siteId, envContent)
  }, [siteId, envContent])

  const handleToggleSchedule = async (enable: boolean) => {
    setSavingSchedule(true)
    try {
      if (enable) {
        await api.database.enableBackupSchedule(siteId, scheduleHour)
        setScheduleActive(true)
        showToast(`Daily backup enabled at ${String(scheduleHour).padStart(2, '0')}:00 (server time)`)
      } else {
        await api.database.disableBackupSchedule(siteId)
        setScheduleActive(false)
        showToast('Scheduled backup disabled')
      }
    } catch {
      showToast('Failed to update backup schedule', { error: true })
    } finally {
      setSavingSchedule(false)
    }
  }

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const result = await api.sites.remove(siteId, cleanupServer)
      if (cleanupServer && result) {
        const r = result as import('../api/client').CleanupResult
        setDeleteResult({ ok: r.cleanupOk, log: r.cleanupLog })
        setDeleteOpen(false)
        if (r.cleanupOk) setTimeout(() => navigate('/sites'), 2000)
      } else {
        navigate('/sites')
      }
    } finally {
      setDeleting(false)
    }
  }

  if (loading) return <SkeletonPage><SkeletonBodyText lines={8} /></SkeletonPage>
  if (!site) return null

  const webhookUrl = site.webhookToken
    ? `${panelUrl || window.location.origin}/api/webhooks/github/${site.webhookToken}`
    : null

  const deployRows = site.deployments.map((d) => [
    <Badge tone={STATUS_TONE[d.status] ?? 'info'}>{d.status}</Badge>,
    d.branch,
    d.commit ?? '—',
    new Date(d.createdAt).toLocaleString(),
    d.log ? (
      <Button size="micro" onClick={() => setLogModal(d)}>View log</Button>
    ) : null
  ])

  return (
    <Page
      title={site.domain}
      subtitle={site.name}
      backAction={{ content: 'Sites', onAction: () => navigate('/sites') }}
      primaryAction={
        <Button
          variant="primary"
          onClick={handleDeploy}
          loading={deploying}
          disabled={site.status !== 'active'}
        >
          Deploy
        </Button>
      }
      secondaryActions={[
        {
          content: site.sslEnabled ? '🔒 SSL' : 'SSL',
          onAction: () => setTab(6)
        },
        { content: 'Delete', destructive: true, onAction: () => setDeleteOpen(true) }
      ]}
    >
      <BlockStack gap="500">

        {/* ── Status bar ─────────────────────────────────────────────────── */}
        <Card>
          <InlineStack gap="400" wrap>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Status</Text>
              <Badge tone={STATUS_TONE[site.status] ?? 'info'}>{site.status}</Badge>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">PHP</Text>
              <Text as="p" variant="bodyMd">{site.phpVersion}</Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">SSL</Text>
              <Text as="p" variant="bodyMd">{site.sslEnabled ? '🔒 Enabled' : 'Not enabled'}</Text>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Branch</Text>
              <Text as="p" variant="bodyMd">{site.branch}</Text>
            </BlockStack>
          </InlineStack>
        </Card>

        {/* ── Active deploy log ──────────────────────────────────────────── */}
        {deploying && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Deploying {site.domain}</Text>
                <Badge tone="info">Running</Badge>
              </InlineStack>
              <ProvisionLog
                endpoint={`/api/sites/${siteId}/deploy/stream`}
                onComplete={handleDeployComplete}
              />
            </BlockStack>
          </Card>
        )}

        {deployError && <Banner tone="critical" onDismiss={() => setDeployError('')}>{deployError}</Banner>}

        {deployResult && (
          <Banner
            tone={deployResult === 'success' ? 'success' : 'critical'}
            onDismiss={() => setDeployResult(null)}
          >
            {deployResult === 'success'
              ? 'Deploy completed successfully!'
              : 'Deploy failed — check the log above for details.'}
          </Banner>
        )}

        {/* ── Tabs ──────────────────────────────────────────────────────── */}
        <Tabs
          tabs={[
            { id: 'deployments', content: `Deployments (${site.deployments.length})` },
            { id: 'settings', content: 'Deploy Settings' },
            { id: 'config', content: 'Config' },
            { id: 'database', content: 'Database' },
            { id: 'artisan', content: 'Artisan' },
            { id: 'workers', content: 'Workers' },
            { id: 'ssl', content: site.sslEnabled ? '🔒 SSL' : 'SSL' },
            { id: 'provision', content: 'Provision Log' }
          ]}
          selected={tab}
          onSelect={setTab}
        >

          {/* Tab 0 — Deployments */}
          {tab === 0 && (
            <BlockStack gap="400">
              {/* Deployment history */}
              <Card padding="0">
                {deployRows.length > 0 ? (
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <DataTable
                      columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                      headings={['Status', 'Branch', 'Commit', 'Started', 'Log']}
                      rows={deployRows}
                    />
                  </div>
                ) : (
                  <div style={{ padding: '32px', textAlign: 'center' }}>
                    <Text as="p" tone="subdued">No deployments yet. Click Deploy to start.</Text>
                  </div>
                )}
              </Card>

              {/* Releases on disk */}
              {releasesLoaded && releases.length > 0 && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Releases on disk</Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {releases.length} release{releases.length !== 1 ? 's' : ''} kept
                      </Text>
                    </InlineStack>
                    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <DataTable
                      columnContentTypes={['text', 'text', 'text']}
                      headings={['Release', 'Created', 'Action']}
                      rows={releases.map((r) => [
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="span" variant="bodySm" fontWeight="semibold">
                            {formatReleaseName(r.name)}
                          </Text>
                          {r.isCurrent && <Badge tone="success">Current</Badge>}
                        </InlineStack>,
                        new Date(r.createdAt).toLocaleString(),
                        r.isCurrent ? (
                          <Text as="span" variant="bodySm" tone="subdued">—</Text>
                        ) : (
                          <Button
                            size="micro"
                            loading={rollingBack === r.name}
                            disabled={deploying || rollingBack !== null}
                            onClick={() => handleRollback(r.name)}
                          >
                            Rollback
                          </Button>
                        )
                      ])}
                    />
                    </div>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          )}

          {/* Tab 1 — Deploy Settings */}
          {tab === 1 && (
            <Card>
              <BlockStack gap="600">

                {/* Repo config */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Repository</Text>
                  <TextField
                    label="Repository URL"
                    value={repoUrl}
                    onChange={setRepoUrl}
                    placeholder="https://github.com/user/repo.git"
                    autoComplete="off"
                    helpText="HTTPS clone URL from GitHub / GitLab"
                  />
                  <TextField
                    label="Branch"
                    value={branch}
                    onChange={setBranch}
                    autoComplete="off"
                  />
                  <InlineStack align="start">
                    <Button variant="primary" onClick={handleSaveRepo} loading={savingRepo}>
                      Save settings
                    </Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                {/* Webhook */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">GitHub Auto-Deploy Webhook</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Push to <InlineCode>{site.branch}</InlineCode> → webhook fires → zero-downtime deploy runs automatically.
                  </Text>

                  {webhookUrl ? (
                    <BlockStack gap="300">
                      <TextField
                        label="Webhook URL"
                        value={webhookUrl}
                        readOnly
                        autoComplete="off"
                        helpText='In GitHub: Settings → Webhooks → Add webhook. Set "Content type" to application/json.'
                      />
                      <TextField
                        label="Webhook Secret (use this as the Secret field in GitHub)"
                        value={site.webhookToken!}
                        readOnly
                        autoComplete="off"
                        type="password"
                      />
                      <InlineStack>
                        <Button onClick={handleGenerateToken} tone="critical">
                          Regenerate token
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <CalloutCard
                      title="Generate a webhook token"
                      illustration=""
                      primaryAction={{ content: 'Generate token', onAction: handleGenerateToken }}
                    >
                      <p>A unique token will be created. Use it as the webhook URL and secret in GitHub.</p>
                    </CalloutCard>
                  )}
                </BlockStack>

                <Divider />

                {/* Deploy Now */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Manual Deploy</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Deploys branch <InlineCode>{site.branch}</InlineCode> from the configured repo right now.
                  </Text>
                  <InlineStack>
                    <Button
                      variant="primary"
                      size="large"
                      onClick={handleDeploy}
                      loading={deploying}
                      disabled={site.status !== 'active' || !site.repoUrl}
                    >
                      Deploy Now
                    </Button>
                  </InlineStack>
                  {!site.repoUrl && (
                    <Text as="p" variant="bodySm" tone="caution">
                      Set a repository URL above before deploying.
                    </Text>
                  )}
                </BlockStack>

                <Divider />

                {/* PHP version */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">PHP Version</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Current: <strong>PHP {site.phpVersion}</strong>. Switching updates the nginx FastCGI socket and reloads nginx.
                  </Text>

                  {phpError && (
                    <Banner tone="critical" onDismiss={() => setPhpError('')}>
                      <Text as="p">{phpError}</Text>
                    </Banner>
                  )}

                  {phpVersions.length > 0 ? (
                    <InlineStack gap="300" blockAlign="end">
                      <div style={{ minWidth: 140 }}>
                        <Select
                          label="Available versions"
                          options={phpVersions.map((v) => ({ label: `PHP ${v}`, value: v }))}
                          value={phpSelected}
                          onChange={setPhpSelected}
                        />
                      </div>
                      <Button
                        variant="primary"
                        onClick={handlePhpSwitch}
                        loading={phpSwitching}
                        disabled={phpSelected === site.phpVersion || phpSwitching}
                      >
                        Switch
                      </Button>
                    </InlineStack>
                  ) : (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Detecting installed PHP versions…
                    </Text>
                  )}
                </BlockStack>

              </BlockStack>
            </Card>
          )}

          {/* Tab 2 — Config */}
          {tab === 2 && (
            <Card>
              {configLoading ? (
                <Text as="p" tone="subdued">Loading config files…</Text>
              ) : (
                <BlockStack gap="600">

                  {/* Nginx */}
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Nginx Config</Text>
                      {nginxPath && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {nginxPath}
                        </Text>
                      )}
                    </InlineStack>
                    <ConfigEditor
                      value={nginxContent}
                      onChange={setNginxContent}
                      onSave={handleSaveNginx}
                      saveLabel="Save & Reload Nginx"
                      minHeight="400px"
                    />
                  </BlockStack>

                  <Divider />

                  {/* .env */}
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Environment (.env)</Text>
                      {envPath && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {envPath}
                        </Text>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Changes take effect on the next deploy (shared/.env is symlinked into each release).
                    </Text>
                    <ConfigEditor
                      value={envContent}
                      onChange={setEnvContent}
                      onSave={handleSaveEnv}
                      saveLabel="Save .env"
                      minHeight="500px"
                    />
                  </BlockStack>

                </BlockStack>
              )}
            </Card>
          )}

          {/* Tab 3 — Database */}
          {tab === 3 && (
            <Card>
              <BlockStack gap="500">

                {/* Header + backup button */}
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">MySQL Backups</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {site.dbName
                        ? `Database: ${site.dbName}`
                        : 'DB credentials are read from shared/.env'}
                    </Text>
                  </BlockStack>
                  <Button
                    variant="primary"
                    onClick={handleCreateBackup}
                    loading={creatingBackup}
                    disabled={site.status !== 'active'}
                  >
                    Create Backup Now
                  </Button>
                </InlineStack>

                {backupError && (
                  <Banner tone="critical" onDismiss={() => setBackupError('')}>
                    <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' }}>
                      {backupError}
                    </pre>
                  </Banner>
                )}

                <Divider />

                {/* Backup list */}
                {backups.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '32px 0' }}>
                    <Text as="p" tone="subdued">
                      No backups yet. Click "Create Backup Now" to make one.
                    </Text>
                  </div>
                ) : (
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                  <DataTable
                    columnContentTypes={['text', 'numeric', 'text', 'text']}
                    headings={['Filename', 'Size', 'Created', 'Actions']}
                    rows={backups.map((b) => [
                      <Text as="span" variant="bodySm" fontWeight="semibold">
                        {b.name}
                      </Text>,
                      formatBytes(b.sizeBytes),
                      new Date(b.createdAt).toLocaleString(),
                      <InlineStack gap="200">
                        <Button
                          size="micro"
                          onClick={() => handleDownloadBackup(b.name)}
                        >
                          Download
                        </Button>
                        <Button
                          size="micro"
                          tone="critical"
                          loading={deletingBackup === b.name}
                          onClick={() => handleDeleteBackup(b.name)}
                        >
                          Delete
                        </Button>
                      </InlineStack>
                    ])}
                  />
                  </div>
                )}

              </BlockStack>
            </Card>
          )}

          {/* Tab 3 — Database: Schedule section (inserted after backup list) */}
          {tab === 3 && (
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text as="h3" variant="headingSm">Automated Backup Schedule</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Runs daily via cron, keeps 30 most recent backups.
                    </Text>
                  </BlockStack>
                  <Badge tone={scheduleActive ? 'success' : 'info'}>
                    {scheduleActive ? 'Active' : 'Inactive'}
                  </Badge>
                </InlineStack>

                <InlineStack gap="400" blockAlign="end">
                  <div style={{ minWidth: 180 }}>
                    <Select
                      label="Run daily at (server time)"
                      options={Array.from({ length: 24 }, (_, h) => ({
                        label: `${String(h).padStart(2, '0')}:00`,
                        value: String(h)
                      }))}
                      value={String(scheduleHour)}
                      onChange={(v) => setScheduleHour(Number(v))}
                      disabled={scheduleActive}
                    />
                  </div>
                  {scheduleActive ? (
                    <Button
                      tone="critical"
                      loading={savingSchedule}
                      onClick={() => handleToggleSchedule(false)}
                    >
                      Disable schedule
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      loading={savingSchedule}
                      onClick={() => handleToggleSchedule(true)}
                    >
                      Enable schedule
                    </Button>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>
          )}

          {/* Tab 4 — Artisan */}
          {tab === 4 && (
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">Artisan Commands</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Runs <code>php{site.phpVersion} artisan &lt;command&gt;</code> inside{' '}
                    <code>{site.rootPath}/current</code>
                  </Text>
                </BlockStack>

                {artisanError && (
                  <Banner tone="critical" onDismiss={() => setArtisanError('')}>
                    {artisanError}
                  </Banner>
                )}

                {artisanFailed && !artisanRunning && (
                  <Banner
                    tone="critical"
                    onDismiss={() => setArtisanFailed(false)}
                  >
                    {artisanActiveCmd}: failed — see output below.
                  </Banner>
                )}

                {/* Running terminal */}
                {artisanRunning && (
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" fontWeight="semibold">
                        php artisan {artisanActiveCmd}
                      </Text>
                      <Badge tone="info">Running</Badge>
                    </InlineStack>
                    <ProvisionLog
                      endpoint={`/api/sites/${siteId}/artisan/stream`}
                      onComplete={handleArtisanComplete}
                    />
                  </BlockStack>
                )}

                <Divider />

                {/* Command groups */}
                {(['Cache', 'Database', 'Queue', 'Other'] as const).map((group) => {
                  const cmds = artisanCommands.filter((c) => c.group === group)
                  if (cmds.length === 0) return null
                  return (
                    <BlockStack key={group} gap="300">
                      <Text as="h3" variant="headingXs" tone="subdued">
                        {group}
                      </Text>
                      <div
                        style={{
                          display: 'flex',
                          flexWrap: 'wrap',
                          gap: '8px'
                        }}
                      >
                        {cmds.map((c) => (
                          <div key={c.cmd} title={c.description}>
                            <Button
                              size="slim"
                              onClick={() => handleRunArtisan(c.cmd)}
                              loading={artisanRunning && artisanActiveCmd === c.cmd}
                              disabled={artisanRunning || site.status !== 'active'}
                            >
                              {c.label}
                            </Button>
                          </div>
                        ))}
                      </div>
                    </BlockStack>
                  )
                })}
              </BlockStack>
            </Card>
          )}

          {/* Tab 5 — Workers */}
          {tab === 5 && (
            <Card>
              <WorkersTab siteId={siteId} phpVersion={site.phpVersion} />
            </Card>
          )}

          {/* Tab 6 — SSL */}
          {tab === 6 && (
            <Card>
              <SslTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 7 — Provision Log */}
          {tab === 7 && (
            <Card>
              {site.status === 'provisioning' ? (
                <ProvisionLog
                  endpoint={`/api/sites/${siteId}/provision/stream`}
                  onComplete={() => fetchSite()}
                />
              ) : (
                <Banner tone={site.status === 'active' ? 'success' : 'warning'}>
                  Provision status: <strong>{site.status}</strong>
                </Banner>
              )}
            </Card>
          )}

        </Tabs>
      </BlockStack>

      {/* ── Deployment log modal ──────────────────────────────────────────── */}
      <Modal
        open={!!logModal}
        onClose={() => setLogModal(null)}
        title={logModal ? `Deploy log — ${logModal.branch}@${logModal.commit ?? '?'}` : ''}
        large
      >
        <Modal.Section>
          {logModal?.log ? (
            <div
              style={{
                background: '#0d1117',
                color: '#e6edf3',
                fontFamily: 'monospace',
                fontSize: '12px',
                padding: '16px',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap',
                maxHeight: '60vh',
                overflowY: 'auto'
              }}
            >
              {logModal.log}
            </div>
          ) : (
            <Text as="p" tone="subdued">No log available.</Text>
          )}
        </Modal.Section>
      </Modal>

      {/* ── Destructive artisan confirmation ────────────────────────────── */}
      <Modal
        open={destructiveCmd !== null}
        onClose={() => setDestructiveCmd(null)}
        title="Confirm destructive command"
        primaryAction={{
          content: `Run artisan ${destructiveCmd ?? ''}`,
          destructive: true,
          onAction: confirmDestructive
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDestructiveCmd(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Banner tone="warning">
              This command can permanently delete or modify database data.
            </Banner>
            <Text as="p">
              Running <InlineCode>php artisan {destructiveCmd}</InlineCode> on{' '}
              <strong>{site.domain}</strong>. Make sure you have a recent backup before continuing.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Delete modal ──────────────────────────────────────────────────── */}
      <Modal
        open={deleteOpen}
        onClose={() => { setDeleteOpen(false); setCleanupServer(false) }}
        title={`Delete ${site.domain}?`}
        primaryAction={{
          content: cleanupServer ? 'Delete & Clean server' : 'Delete record',
          destructive: true,
          loading: deleting,
          onAction: handleDelete
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setDeleteOpen(false); setCleanupServer(false) } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">
              Removes the site from the Orchestrator database.
            </Text>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <input
                type="checkbox"
                id="cleanup-server"
                checked={cleanupServer}
                onChange={(e) => setCleanupServer(e.target.checked)}
                style={{ marginTop: 2, accentColor: '#e01e5a' }}
              />
              <label htmlFor="cleanup-server" style={{ cursor: 'pointer' }}>
                <Text as="span" variant="bodyMd" fontWeight="semibold">
                  Also remove from server
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Deletes Nginx config, MySQL database{site.dbName ? ` (${site.dbName})` : ''}, and{' '}
                  <code>{site.rootPath}</code>. This cannot be undone.
                </Text>
              </label>
            </div>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Cleanup result banner (shown after delete with server cleanup) ── */}
      {deleteResult && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 999, minWidth: 360 }}>
          <Banner
            tone={deleteResult.ok ? 'success' : 'critical'}
            onDismiss={() => setDeleteResult(null)}
          >
            <BlockStack gap="200">
              <Text as="p">{deleteResult.ok ? 'Server cleanup completed.' : 'Server cleanup failed — site record was still deleted.'}</Text>
              {deleteResult.log && (
                <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto' }}>
                  {deleteResult.log}
                </pre>
              )}
            </BlockStack>
          </Banner>
        </div>
      )}
    </Page>
  )
}

// Converts '20240601150304' → '2024-06-01 15:03:04'
function formatReleaseName(name: string): string {
  if (!/^\d{14}$/.test(name)) return name
  const [, y, mo, d, h, mi, s] = name.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)!
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
