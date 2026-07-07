import {
  Page,
  Card,
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
  Select,
  Checkbox
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ArtisanCommand, Deployment, Release, Site, maintenanceApi, logsApi, redeployApi } from '../api/client'
import { phpVersionOptions } from '../utils/php'
import { ProvisionLog }      from '../components/ProvisionLog'
import { DeployReviewModal }  from '../components/DeployReview'
import { LogConsole }         from '../components/LogConsole'
import { StatusPageCard }     from '../components/StatusPageCard'
import { ConfigEditor }      from '../components/ConfigEditor'
import { WorkersTab }        from '../components/WorkersTab'
import { SslTab }            from '../components/SslTab'
import { WebTerminal }       from '../components/WebTerminal'
import { SchedulerSection }  from '../components/SchedulerSection'
import { ComposerTab }       from '../components/ComposerTab'
import { FailedJobsTab }     from '../components/FailedJobsTab'
import { PhpFpmTab }         from '../components/PhpFpmTab'
import { EnvEditorTab }      from '../components/EnvEditorTab'
import { DeployTimeline }    from '../components/DeployTimeline'
import { LaravelLogsTab }    from '../components/LaravelLogsTab'
import { FileManagerTab }    from '../components/FileManagerTab'
import { DeployHeatmap }     from '../components/DeployHeatmap'
import { TestResultsCard }   from '../components/TestResultsCard'
import { HealthScoreBadge }  from '../components/HealthScoreBadge'
import { Breadcrumb }        from '../components/Breadcrumb'
import { useToast } from '../context/toast'
import { DatabaseTab }       from '../components/DatabaseTab'
import { useAuth }           from '../context/AuthContext'

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
  const { isAdmin } = useAuth()

  const [site, setSite]       = useState<Site | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchParams, setSearchParams] = useSearchParams()
  const tab    = searchParams.get('tab') ?? 'deploys'
  const setTab = (slug: string) => setSearchParams({ tab: slug }, { replace: true })

  // Deploy state
  const [deploying, setDeploying]       = useState(false)
  const [deployError, setDeployError]   = useState('')
  const [deployResult, setDeployResult] = useState<'success' | 'failed' | 'queued' | null>(null)
  const [reviewOpen, setReviewOpen]     = useState(false)

  // Releases / rollback
  const [releases, setReleases]           = useState<Release[]>([])
  const [releasesLoaded, setReleasesLoaded] = useState(false)
  const [rollingBack, setRollingBack]     = useState<string | null>(null)

  const showToast = useToast()

  // Deploy settings
  const [repoUrl, setRepoUrl]       = useState('')
  const [branch, setBranch]         = useState('main')
  const [gitToken, setGitToken]     = useState('')
  const [preDeploy, setPreDeploy]   = useState('')
  const [postDeploy, setPostDeploy] = useState('')
  const [healthCheck, setHealthCheck]         = useState(false)
  const [healthCheckUrl, setHealthCheckUrl]   = useState('')
  // Deploy-time tests
  const [runTests, setRunTests]               = useState(false)
  const [testCommand, setTestCommand]         = useState('php artisan test')
  const [testFailureMode, setTestFailureMode] = useState('block')
  const [testTimeout, setTestTimeout]         = useState('300')
  const [testUseSqlite, setTestUseSqlite]     = useState(true)
  const [savingRepo, setSavingRepo]           = useState(false)

  // Maintenance mode
  const [maintenanceMode, setMaintenanceMode] = useState(false)
  const [maintenanceSecret, setMaintenanceSecret] = useState('')
  const [maintenanceLoading, setMaintenanceLoading] = useState(false)
  const [maintenanceError, setMaintenanceError]     = useState('')

  // Site identity (name / domain rename)
  const [identityName, setIdentityName]     = useState('')
  const [identityDomain, setIdentityDomain] = useState('')
  const [savingIdentity, setSavingIdentity] = useState(false)
  const [identityError, setIdentityError]   = useState('')
  const [renameConfirmOpen, setRenameConfirmOpen] = useState(false)

  // Enable / disable serving
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [disableConfirmOpen, setDisableConfirmOpen] = useState(false)

  // Stuck-deploy detection / cancel
  const [cancellingDeploy, setCancellingDeploy] = useState(false)
  const [nowTick, setNowTick] = useState(Date.now())

  // Delete modal
  const [deleteOpen, setDeleteOpen]     = useState(false)
  const [deleting, setDeleting]         = useState(false)
  const [cleanupServer, setCleanupServer] = useState(false)
  const [deleteResult, setDeleteResult] = useState<{ ok: boolean; log: string } | null>(null)

  // Deployment log modal
  const [logModal, setLogModal] = useState<Deployment | null>(null)


  // Artisan tab state
  const [artisanCommands, setArtisanCommands]               = useState<ArtisanCommand[]>([])
  const [artisanCommandsLoaded, setArtisanCommandsLoaded]   = useState(false)
  const [artisanRunning, setArtisanRunning]                 = useState(false)
  const [artisanActiveCmd, setArtisanActiveCmd]             = useState('')
  const [artisanFailed, setArtisanFailed]                   = useState(false)
  const [artisanError, setArtisanError]                     = useState('')
  const [destructiveCmd, setDestructiveCmd]                 = useState<string | null>(null)

  // Panel URL for webhook display
  const [panelUrl, setPanelUrl] = useState('')

  // Anomaly detection
  const [hasErrorSpike, setHasErrorSpike] = useState(false)

  // Redeploy loading state (tracks deployment id being redeployed)
  const [redeploying, setRedeploying] = useState<number | null>(null)

  // Config tab state
  const [nginxContent, setNginxContent] = useState('')
  const [nginxPath, setNginxPath]       = useState('')
  const [envContent, setEnvContent]     = useState('')
  const [envPath, setEnvPath]           = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configLoaded, setConfigLoaded]   = useState(false)

  // PHP version switcher
  const [phpVersions, setPhpVersions]   = useState<string[]>([])
  const [phpSelected, setPhpSelected]   = useState('')
  const [phpSwitching, setPhpSwitching] = useState(false)
  const [phpError, setPhpError]         = useState('')

  const fetchSite = useCallback(async () => {
    try {
      const s = await api.sites.get(siteId)
      setSite(s)
      setRepoUrl(s.repoUrl ?? '')
      setBranch(s.branch)
      setPreDeploy(s.preDeploy ?? '')
      setPostDeploy(s.postDeploy ?? '')
      setHealthCheck(s.healthCheck)
      setHealthCheckUrl(s.healthCheckUrl ?? '')
      setRunTests(s.runTests ?? false)
      setTestCommand(s.testCommand ?? 'php artisan test')
      setTestFailureMode(s.testFailureMode ?? 'block')
      setTestTimeout(String(s.testTimeout ?? 300))
      setTestUseSqlite(s.testUseSqlite ?? true)
      setMaintenanceMode(s.maintenanceMode)
      setIdentityName(s.name)
      setIdentityDomain(s.domain)
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

  // Anomaly detection: check for error spike after site loads
  useEffect(() => {
    if (!siteId) return
    logsApi.list(siteId, { level: 'error', lines: 50 })
      .then((r) => { if (r.entries.length > 10) setHasErrorSpike(true) })
      .catch(() => {})
  }, [siteId])

  // Tab index constants (easier to maintain)
  const TAB = { DEPLOYS: 'deploys', SETTINGS: 'settings', CONFIG: 'config', ENV: 'env', DATABASE: 'database', ARTISAN: 'artisan', WORKERS: 'workers', SSL: 'ssl', MAINTENANCE: 'maintenance', COMPOSER: 'composer', FAILED_JOBS: 'failed-jobs', PHPFPM: 'phpfpm', TERMINAL: 'terminal', PROVISION: 'provision', LOGS: 'logs', FILES: 'files' }

  // Load Deploy Settings tab data
  useEffect(() => {
    if (tab !== TAB.SETTINGS) return
    // Default the selector to the site's current version so it works even if
    // server-side detection is unavailable.
    if (site && !phpSelected) setPhpSelected(site.phpVersion)
    if (phpVersions.length === 0) {
      api.config.getPhpVersions(siteId)
        .then((r) => { setPhpVersions(r.available) })
        .catch(() => {})
    }
    if (!panelUrl) {
      api.settings.get()
        .then((s) => setPanelUrl(s.panel_url?.trim() || window.location.origin))
        .catch(() => setPanelUrl(window.location.origin))
    }
  }, [tab, siteId, phpVersions.length, panelUrl, site, phpSelected])

  const handlePhpSwitch = async () => {
    if (!phpSelected || !site || phpSelected === site.phpVersion) return
    setPhpSwitching(true); setPhpError('')
    try {
      const r = await api.config.switchPhpVersion(siteId, phpSelected)
      showToast(r.message)
      fetchSite()
    } catch (err: unknown) {
      setPhpError(err instanceof Error ? err.message : 'Switch failed')
    } finally { setPhpSwitching(false) }
  }

  const handleDeploy = async (opts?: { skipTests?: boolean; ref?: string }) => {
    if (!site?.repoUrl) {
      setTab(TAB.SETTINGS)
      setDeployError('Set a repository URL in the Deploy Settings tab first.')
      return
    }
    setDeployError(''); setDeployResult(null)
    try {
      const res = await api.deploy.trigger(siteId, opts)
      if ('queued' in res) {
        setDeployResult('queued')
        showToast(res.message)
      } else {
        setDeploying(true)
      }
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : 'Deploy failed to start')
    }
  }

  const loadReleases = useCallback(async () => {
    try {
      const r = await api.releases.list(siteId)
      setReleases(r.releases)
      setReleasesLoaded(true)
    } catch { /* releases dir not yet created */ }
  }, [siteId])

  useEffect(() => {
    if (tab !== TAB.DEPLOYS) return
    loadReleases()
  }, [tab, loadReleases]) // eslint-disable-line

  const handleRollback = async (releaseName: string) => {
    setRollingBack(releaseName); setDeployError(''); setDeployResult(null)
    try {
      await api.releases.rollback(siteId, releaseName)
      setDeploying(true)
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : 'Rollback failed')
      setRollingBack(null)
    }
  }

  const handleDeployComplete = useCallback((status: string) => {
    setDeploying(false); setRollingBack(null)
    setDeployResult(status === 'success' ? 'success' : 'failed')
    fetchSite(); loadReleases()
  }, [fetchSite, loadReleases])

  const handleRedeploy = async (deploymentId: number) => {
    setRedeploying(deploymentId)
    try {
      await redeployApi.trigger(siteId, deploymentId)
      setDeploying(true)
      await fetchSite()
    } catch (err: unknown) {
      setDeployError(err instanceof Error ? err.message : 'Redeploy failed')
    } finally { setRedeploying(null) }
  }

  // Stuck-deploy detection: ticks every 30s while a deploy is showing so the
  // "this may be stuck" banner can appear without needing a manual refresh.
  useEffect(() => {
    if (!deploying) return
    const t = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [deploying])

  const STUCK_AFTER_MIN = 10
  const DEPLOY_TIMEOUT_MIN = 25 // mirrors the API's default DEPLOY_TIMEOUT_MS watchdog
  const runningDeployment = site?.deployments.find((d) => d.status === 'running')
  const stuckDeploy = !!runningDeployment &&
    (nowTick - new Date(runningDeployment.createdAt).getTime()) > STUCK_AFTER_MIN * 60_000

  const handleCancelDeploy = async () => {
    setCancellingDeploy(true)
    try {
      const r = await redeployApi.cancel(siteId)
      showToast(r.message)
      setDeploying(false)
      await fetchSite()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Cancel failed', { error: true })
    } finally { setCancellingDeploy(false) }
  }

  const handleSaveRepo = async () => {
    setSavingRepo(true)
    try {
      await api.sites.update(siteId, {
        repoUrl,
        branch,
        preDeploy,
        postDeploy,
        healthCheck,
        healthCheckUrl: healthCheckUrl || undefined,
        runTests,
        testCommand: testCommand || 'php artisan test',
        testFailureMode,
        testTimeout: Math.max(10, Math.min(3600, Number(testTimeout) || 300)),
        testUseSqlite,
        ...(gitToken ? { gitToken } : {})
      })
      setGitToken('')
      await fetchSite()
      showToast('Deploy settings saved')
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
    } finally { setSavingRepo(false) }
  }

  const handleClearGitToken = async () => {
    setSavingRepo(true)
    try {
      await api.sites.update(siteId, { gitToken: '' })
      setGitToken(''); await fetchSite()
      showToast('Access token removed')
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Remove failed', { error: true })
    } finally { setSavingRepo(false) }
  }

  const handleGenerateToken = async () => {
    await api.deploy.generateWebhookToken(siteId)
    await fetchSite()
  }

  // Site identity (name / domain)
  const identityDirty = !!site && (identityName !== site.name || identityDomain !== site.domain)
  const domainDirty   = !!site && identityDomain !== site.domain

  const doSaveIdentity = async () => {
    if (!site) return
    setSavingIdentity(true); setIdentityError('')
    try {
      const updated = await api.sites.update(siteId, {
        ...(identityName   !== site.name   ? { name: identityName }     : {}),
        ...(identityDomain !== site.domain ? { domain: identityDomain } : {})
      })
      if (updated.renameLog) console.info('[rename]', updated.renameLog)
      showToast(domainDirty ? `Domain changed to ${updated.domain}` : 'Name updated')
      await fetchSite()
      if (domainDirty) navigate(`/sites/${siteId}?tab=${TAB.SETTINGS}`, { replace: true })
    } catch (err: unknown) {
      setIdentityError(err instanceof Error ? err.message : 'Save failed')
    } finally { setSavingIdentity(false); setRenameConfirmOpen(false) }
  }

  const handleSaveIdentity = () => {
    if (domainDirty) setRenameConfirmOpen(true)
    else doSaveIdentity()
  }

  // Enable / disable serving
  const doToggleEnabled = async () => {
    if (!site) return
    setTogglingEnabled(true)
    try {
      await api.sites.update(siteId, { disabled: !site.disabled })
      showToast(site.disabled ? 'Site enabled' : 'Site disabled — it will stop serving traffic')
      await fetchSite()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed to update', { error: true })
    } finally { setTogglingEnabled(false); setDisableConfirmOpen(false) }
  }

  const handleToggleEnabled = () => {
    if (!site) return
    if (!site.disabled) setDisableConfirmOpen(true) // confirm before disabling; re-enabling is safe to do immediately
    else doToggleEnabled()
  }

  // Maintenance toggle
  const handleMaintenance = async (action: 'down' | 'up') => {
    setMaintenanceLoading(true); setMaintenanceError('')
    try {
      const res = await maintenanceApi.toggle(siteId, action, action === 'down' ? maintenanceSecret || undefined : undefined)
      setMaintenanceMode(action === 'down')
      showToast(action === 'down' ? 'Maintenance mode enabled' : 'Site is back online')
      if (res.output) console.info('[maintenance]', res.output)
    } catch (err: unknown) {
      setMaintenanceError(err instanceof Error ? err.message : 'Failed')
    } finally { setMaintenanceLoading(false) }
  }

  // Load artisan command list when Artisan tab is first selected
  useEffect(() => {
    if (tab !== TAB.ARTISAN || artisanCommandsLoaded) return
    api.artisan.commands(siteId)
      .then((r) => { setArtisanCommands(r.commands); setArtisanCommandsLoaded(true) })
      .catch(() => {})
  }, [tab, siteId, artisanCommandsLoaded])

  const runArtisan = async (command: string) => {
    setArtisanActiveCmd(command); setArtisanFailed(false); setArtisanError('')
    try {
      await api.artisan.run(siteId, command)
      setArtisanRunning(true)
    } catch (err: unknown) {
      setArtisanError(err instanceof Error ? err.message : 'Failed to start command')
    }
  }

  const handleRunArtisan = (command: string) => {
    if (DESTRUCTIVE_ARTISAN.has(command)) setDestructiveCmd(command)
    else runArtisan(command)
  }

  const confirmDestructive = () => {
    if (destructiveCmd) { runArtisan(destructiveCmd); setDestructiveCmd(null) }
  }

  const handleArtisanComplete = useCallback((status: string) => {
    setArtisanRunning(false)
    if (status === 'success') { setArtisanFailed(false); showToast(`artisan ${artisanActiveCmd}: completed successfully`) }
    else setArtisanFailed(true)
  }, [artisanActiveCmd, showToast])

  // Load configs once when Config tab is selected
  useEffect(() => {
    if (tab !== TAB.CONFIG || configLoaded) return
    setConfigLoading(true)
    Promise.all([api.config.getNginx(siteId), api.config.getEnv(siteId)])
      .then(([nginx, env]) => {
        setNginxContent(nginx.content); setNginxPath(nginx.path)
        setEnvContent(env.content); setEnvPath(env.path)
        setConfigLoaded(true)
      }).catch(() => {}).finally(() => setConfigLoading(false))
  }, [tab, siteId, configLoaded])

  const handleSaveNginx = useCallback(async () => {
    await api.config.saveNginx(siteId, nginxContent)
  }, [siteId, nginxContent])

  const handleSaveEnv = useCallback(async () => {
    await api.config.saveEnv(siteId, envContent)
  }, [siteId, envContent])

  const handleDelete = async () => {
    setDeleting(true)
    try {
      const result = await api.sites.remove(siteId, cleanupServer)
      if (cleanupServer && result) {
        const r = result as import('../api/client').CleanupResult
        setDeleteResult({ ok: r.cleanupOk, log: r.cleanupLog })
        setDeleteOpen(false)
        if (r.cleanupOk) setTimeout(() => navigate('/sites'), 2000)
      } else { navigate('/sites') }
    } finally { setDeleting(false) }
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
    d.log ? <Button size="micro" onClick={() => setLogModal(d)}>View log</Button> : null,
    <Button
      size="micro"
      loading={redeploying === d.id}
      disabled={deploying || redeploying !== null}
      onClick={() => handleRedeploy(d.id)}
    >↺ Redeploy</Button>
  ])

  return (
    <Page
      title={site.domain}
      subtitle={site.name}
      backAction={{ content: 'Sites', onAction: () => navigate('/sites') }}
      primaryAction={
        <Button variant="primary" onClick={() => handleDeploy()} loading={deploying} disabled={site.status !== 'active'}>
          Deploy
        </Button>
      }
      secondaryActions={[
        { content: 'Review changes', disabled: deploying || site.status !== 'active', onAction: () => setReviewOpen(true) },
        { content: site.sslEnabled ? '🔒 SSL' : 'SSL', onAction: () => setTab(TAB.SSL) },
        ...(isAdmin ? [{
          content: site.disabled ? 'Enable site' : 'Disable site',
          destructive: !site.disabled,
          loading: togglingEnabled,
          onAction: handleToggleEnabled
        }] : []),
        { content: 'Delete', destructive: true, onAction: () => setDeleteOpen(true) }
      ]}
    >
      <BlockStack gap="500">
        <DeployReviewModal open={reviewOpen} onClose={() => setReviewOpen(false)} siteId={siteId} onDeploy={handleDeploy} />

        {/* ── Breadcrumb ────────────────────────────────────────────────── */}
        <Breadcrumb items={[{ label: 'Sites', url: '/sites' }, { label: site.domain }]} />

        {/* ── Status bar ─────────────────────────────────────────────────── */}
        <Card>
          <InlineStack gap="400" wrap>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Status</Text>
              <Badge tone={STATUS_TONE[site.status] ?? 'info'}>{site.status}</Badge>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Serving</Text>
              <Badge tone={site.disabled ? 'critical' : 'success'}>{site.disabled ? 'Disabled' : 'Enabled'}</Badge>
            </BlockStack>
            <BlockStack gap="100">
              <Text as="p" variant="bodySm" tone="subdued">Health</Text>
              <HealthScoreBadge siteId={siteId} />
            </BlockStack>
            {maintenanceMode && (
              <BlockStack gap="100">
                <Text as="p" variant="bodySm" tone="subdued">Maintenance</Text>
                <Badge tone="warning">Down</Badge>
              </BlockStack>
            )}
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
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone="info">Running</Badge>
                  {isAdmin && (
                    <Button size="micro" tone="critical" loading={cancellingDeploy} onClick={handleCancelDeploy}>
                      Cancel
                    </Button>
                  )}
                </InlineStack>
              </InlineStack>
              {stuckDeploy && (
                <Banner tone="warning">
                  This deploy has been running for over {STUCK_AFTER_MIN} minutes — it may be stuck (e.g. a network
                  stall during git clone or package install). It will auto-fail after{' '}
                  {Math.round(DEPLOY_TIMEOUT_MIN)} minutes total, or {isAdmin ? 'you can cancel it now above.' : 'ask an admin to cancel it.'}
                </Banner>
              )}
              <ProvisionLog endpoint={`/api/sites/${siteId}/deploy/stream`} onComplete={handleDeployComplete} />
            </BlockStack>
          </Card>
        )}

        {deployError && <Banner tone="critical" onDismiss={() => setDeployError('')}>{deployError}</Banner>}

        {hasErrorSpike && (
          <Banner tone="warning" onDismiss={() => setHasErrorSpike(false)}>
            ⚠️ Anomaly detected: high error rate in Laravel logs. Check the Logs tab.
          </Banner>
        )}

        {deployResult && deployResult !== 'queued' && (
          <Banner tone={deployResult === 'success' ? 'success' : 'critical'} onDismiss={() => setDeployResult(null)}>
            {deployResult === 'success' ? 'Deploy completed successfully!' : 'Deploy failed — check the log above for details.'}
          </Banner>
        )}

        {/* ── Tab content ───────────────────────────────────────────────── */}
        <div>

          {/* Tab 0 — Deployments + Timeline */}
          {tab === TAB.DEPLOYS && (
            <BlockStack gap="400">
              {/* Test analytics — shown when tests are enabled or any run exists */}
              {(site.runTests || site.deployments.some((d) => d.testResult === 'passed' || d.testResult === 'failed')) && (
                <TestResultsCard siteId={siteId} deployments={site.deployments} />
              )}
              {site.deployments.length > 0 && (
                <Card>
                  <BlockStack gap="300">
                    <Text as="h3" variant="headingSm">Deploy Timeline</Text>
                    <DeployTimeline deployments={site.deployments} />
                  </BlockStack>
                </Card>
              )}
              <Card>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Deploy Activity</Text>
                  <DeployHeatmap siteId={siteId} />
                </BlockStack>
              </Card>
              <Card padding="0">
                {deployRows.length > 0 ? (
                  <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                    <DataTable
                      columnContentTypes={['text', 'text', 'text', 'text', 'text', 'text']}
                      headings={['Status', 'Branch', 'Commit', 'Started', 'Log', 'Action']}
                      rows={deployRows}
                    />
                  </div>
                ) : (
                  <div style={{ padding: '32px', textAlign: 'center' }}>
                    <Text as="p" tone="subdued">No deployments yet. Click Deploy to start.</Text>
                  </div>
                )}
              </Card>

              {releasesLoaded && releases.length > 0 && (
                <Card>
                  <BlockStack gap="400">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Releases on disk</Text>
                      <Text as="p" variant="bodySm" tone="subdued">{releases.length} release{releases.length !== 1 ? 's' : ''} kept</Text>
                    </InlineStack>
                    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                      <DataTable
                        columnContentTypes={['text', 'text', 'text']}
                        headings={['Release', 'Created', 'Action']}
                        rows={releases.map((r) => [
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="span" variant="bodySm" fontWeight="semibold">{formatReleaseName(r.name)}</Text>
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
          {tab === TAB.SETTINGS && (
            <Card>
              <BlockStack gap="600">

                {/* Site Identity */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Site Identity</Text>
                  {identityError && <Banner tone="critical" onDismiss={() => setIdentityError('')}>{identityError}</Banner>}
                  <TextField label="Display name" value={identityName} onChange={setIdentityName} autoComplete="off" />
                  {isAdmin ? (
                    <TextField label="Domain" value={identityDomain} onChange={setIdentityDomain} autoComplete="off"
                      helpText="Renaming moves the site's files and rewrites its Nginx config on the server. Re-run SSL setup afterwards if this site uses HTTPS." />
                  ) : (
                    <TextField label="Domain" value={identityDomain} disabled autoComplete="off"
                      helpText="Only admins can change the domain." />
                  )}
                  <InlineStack align="start">
                    <Button variant="primary" onClick={handleSaveIdentity} loading={savingIdentity} disabled={!identityDirty}>
                      Save identity
                    </Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                {/* Repository */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Repository</Text>
                  <TextField label="Repository URL" value={repoUrl} onChange={setRepoUrl}
                    placeholder="https://github.com/user/repo.git" autoComplete="off"
                    helpText="HTTPS clone URL from GitHub / GitLab" />
                  <TextField label="Branch" value={branch} onChange={setBranch} autoComplete="off" />
                  <TextField label="Git Access Token (for private repos)" value={gitToken} onChange={setGitToken}
                    type="password" autoComplete="off"
                    placeholder={site.hasGitToken ? '•••••••• (saved — leave blank to keep)' : 'Personal Access Token, optional'}
                    helpText="Only needed for private repositories. Stored encrypted; never displayed again after saving." />
                  {site.hasGitToken && (
                    <InlineStack align="start">
                      <Badge tone="success">Token saved</Badge>
                      <Button variant="plain" tone="critical" onClick={handleClearGitToken}>Remove token</Button>
                    </InlineStack>
                  )}
                </BlockStack>

                <Divider />

                {/* Deploy Hooks */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Deploy Hooks</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Bash scripts that run before and after the deploy. Leave blank to skip.
                  </Text>
                  <TextField
                    label="Pre-deploy hook"
                    value={preDeploy}
                    onChange={setPreDeploy}
                    multiline={4}
                    autoComplete="off"
                    placeholder={'# Runs before git clone\n# e.g. notify Slack, tag Sentry release\nexport SENTRY_RELEASE=$(date +%Y%m%d%H%M%S)'}
                    monospaced
                  />
                  <TextField
                    label="Post-deploy hook"
                    value={postDeploy}
                    onChange={setPostDeploy}
                    multiline={4}
                    autoComplete="off"
                    placeholder={'# Runs after symlink swap\n# e.g. clear CDN cache, notify team\ncurl -s https://cdn.example.com/purge?zone=app'}
                    monospaced
                  />
                </BlockStack>

                <Divider />

                {/* Health Check */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Health Check & Auto-Rollback</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    After a successful deploy, the panel pings the URL up to 3 times. If all fail, it automatically rolls back to the previous release.
                  </Text>
                  <Checkbox
                    label="Enable health check after deploy"
                    checked={healthCheck}
                    onChange={setHealthCheck}
                  />
                  {healthCheck && (
                    <TextField
                      label="Health check URL"
                      value={healthCheckUrl}
                      onChange={setHealthCheckUrl}
                      autoComplete="off"
                      placeholder={`https://${site.domain}/`}
                      helpText="Must return HTTP < 500 to pass. Defaults to https://{domain}/ if blank."
                    />
                  )}
                </BlockStack>

                <Divider />

                {/* Deploy-time tests */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">Tests (pre-deploy gate)</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Run your test suite on the new release before it goes live. In “block” mode a
                    failing test aborts the deploy and the current release keeps serving traffic.
                  </Text>
                  <Checkbox
                    label="Run tests during deploy"
                    checked={runTests}
                    onChange={setRunTests}
                  />
                  {runTests && (
                    <BlockStack gap="300">
                      <TextField
                        label="Test command"
                        value={testCommand}
                        onChange={setTestCommand}
                        autoComplete="off"
                        placeholder="php artisan test"
                        helpText="e.g. php artisan test · ./vendor/bin/pest · ./vendor/bin/phpunit --testsuite=Unit"
                      />
                      <InlineStack gap="400" blockAlign="start">
                        <div style={{ minWidth: 220 }}>
                          <Select
                            label="On failure"
                            options={[
                              { label: 'Block deploy (recommended)', value: 'block' },
                              { label: 'Warn only (deploy anyway)', value: 'warn' }
                            ]}
                            value={testFailureMode}
                            onChange={setTestFailureMode}
                          />
                        </div>
                        <div style={{ minWidth: 150 }}>
                          <TextField
                            label="Timeout (seconds)"
                            type="number"
                            value={testTimeout}
                            onChange={setTestTimeout}
                            autoComplete="off"
                            min={10}
                            max={3600}
                          />
                        </div>
                      </InlineStack>
                      <Checkbox
                        label="Run against isolated in-memory SQLite (recommended)"
                        checked={testUseSqlite}
                        onChange={setTestUseSqlite}
                        helpText="Forces APP_ENV=testing + SQLite :memory: so tests can never read or wipe your production database."
                      />
                    </BlockStack>
                  )}
                </BlockStack>

                <Divider />

                {/* Scheduler */}
                <SchedulerSection siteId={siteId} />

                <Divider />

                <InlineStack align="start">
                  <Button variant="primary" onClick={handleSaveRepo} loading={savingRepo}>
                    Save settings
                  </Button>
                </InlineStack>

                <Divider />

                {/* Webhook */}
                <BlockStack gap="400">
                  <Text as="h3" variant="headingSm">GitHub Auto-Deploy Webhook</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Push to <InlineCode>{site.branch}</InlineCode> → webhook fires → zero-downtime deploy runs automatically.
                  </Text>
                  {webhookUrl ? (
                    <BlockStack gap="300">
                      <TextField label="Webhook URL" value={webhookUrl} readOnly autoComplete="off"
                        helpText='In GitHub: Settings → Webhooks → Add webhook. Set "Content type" to application/json.' />
                      <TextField label="Webhook Secret" value={site.webhookToken!} readOnly autoComplete="off" type="password" />
                      <InlineStack>
                        <Button onClick={handleGenerateToken} tone="critical">Regenerate token</Button>
                      </InlineStack>
                    </BlockStack>
                  ) : (
                    <CalloutCard title="Generate a webhook token" illustration=""
                      primaryAction={{ content: 'Generate token', onAction: handleGenerateToken }}>
                      <p>A unique token will be created. Use it as the webhook URL and secret in GitHub.</p>
                    </CalloutCard>
                  )}
                </BlockStack>

                <Divider />

                {/* PHP version */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">PHP Version</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Current: <strong>PHP {site.phpVersion}</strong>. Switching updates the nginx FastCGI socket and reloads nginx.
                  </Text>
                  {phpError && <Banner tone="critical" onDismiss={() => setPhpError('')}><Text as="p">{phpError}</Text></Banner>}
                  <InlineStack gap="300" blockAlign="end">
                    <div style={{ minWidth: 140 }}>
                      <Select
                        label="PHP version"
                        options={phpVersionOptions(phpVersions)}
                        value={phpSelected || site.phpVersion}
                        onChange={setPhpSelected}
                      />
                    </div>
                    <Button variant="primary" onClick={handlePhpSwitch} loading={phpSwitching}
                      disabled={(phpSelected || site.phpVersion) === site.phpVersion || phpSwitching}>Switch</Button>
                  </InlineStack>
                </BlockStack>

                <Divider />

                {/* Deploy Now */}
                <BlockStack gap="300">
                  <Text as="h3" variant="headingSm">Manual Deploy</Text>
                  <InlineStack gap="300">
                    <Button variant="primary" size="large" onClick={() => handleDeploy()} loading={deploying}
                      disabled={site.status !== 'active' || !site.repoUrl}>Deploy Now</Button>
                    {site.runTests && (
                      <Button size="large" tone="critical" onClick={() => handleDeploy({ skipTests: true })}
                        disabled={site.status !== 'active' || !site.repoUrl}>
                        Deploy without tests
                      </Button>
                    )}
                  </InlineStack>
                  {site.runTests && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      Tests run automatically before this site goes live. “Deploy without tests” is a one-off emergency bypass.
                    </Text>
                  )}
                  {!site.repoUrl && <Text as="p" variant="bodySm" tone="caution">Set a repository URL above before deploying.</Text>}
                </BlockStack>

              </BlockStack>
            </Card>
          )}

          {/* Tab 2 — Config */}
          {tab === TAB.CONFIG && (
            <Card>
              {configLoading ? (
                <Text as="p" tone="subdued">Loading config files…</Text>
              ) : (
                <BlockStack gap="600">
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Nginx Config</Text>
                      {nginxPath && <Text as="p" variant="bodySm" tone="subdued">{nginxPath}</Text>}
                    </InlineStack>
                    <ConfigEditor value={nginxContent} onChange={setNginxContent} onSave={handleSaveNginx} saveLabel="Save & Reload Nginx" minHeight="400px" />
                  </BlockStack>
                  <Divider />
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h3" variant="headingSm">Environment (.env)</Text>
                      {envPath && <Text as="p" variant="bodySm" tone="subdued">{envPath}</Text>}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Changes take effect on the next deploy (shared/.env is symlinked into each release).
                    </Text>
                    <ConfigEditor value={envContent} onChange={setEnvContent} onSave={handleSaveEnv} saveLabel="Save .env" minHeight="500px" />
                  </BlockStack>
                </BlockStack>
              )}
            </Card>
          )}

          {/* Tab 3 — .env Visual Editor */}
          {tab === TAB.ENV && (
            <Card>
              <EnvEditorTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 4 — Database */}
          {tab === TAB.DATABASE && site && (
            <DatabaseTab siteId={siteId} site={site} />
          )}

          {/* Tab 5 — Artisan */}
          {tab === TAB.ARTISAN && (
            <Card>
              <BlockStack gap="500">
                <BlockStack gap="100">
                  <Text as="h3" variant="headingSm">Artisan Commands</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Runs <code>php{site.phpVersion} artisan &lt;command&gt;</code> inside{' '}
                    <code>{site.rootPath}/current</code>
                  </Text>
                </BlockStack>

                {artisanError && <Banner tone="critical" onDismiss={() => setArtisanError('')}>{artisanError}</Banner>}

                {artisanFailed && !artisanRunning && (
                  <Banner tone="critical" onDismiss={() => setArtisanFailed(false)}>
                    {artisanActiveCmd}: failed — see output below.
                  </Banner>
                )}

                {artisanRunning && (
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodySm" fontWeight="semibold">php artisan {artisanActiveCmd}</Text>
                      <Badge tone="info">Running</Badge>
                    </InlineStack>
                    <ProvisionLog endpoint={`/api/sites/${siteId}/artisan/stream`} onComplete={handleArtisanComplete} />
                  </BlockStack>
                )}

                <Divider />

                {(['Cache', 'Database', 'Queue', 'Other'] as const).map((group) => {
                  const cmds = artisanCommands.filter((c) => c.group === group)
                  if (cmds.length === 0) return null
                  return (
                    <BlockStack key={group} gap="300">
                      <Text as="h3" variant="headingXs" tone="subdued">{group}</Text>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                        {cmds.map((c) => (
                          <div key={c.cmd} title={c.description}>
                            <Button size="slim" onClick={() => handleRunArtisan(c.cmd)}
                              loading={artisanRunning && artisanActiveCmd === c.cmd}
                              disabled={artisanRunning || site.status !== 'active'}>
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

          {/* Tab 6 — Workers */}
          {tab === TAB.WORKERS && (
            <Card>
              <WorkersTab siteId={siteId} phpVersion={site.phpVersion} />
            </Card>
          )}

          {/* Tab 7 — SSL */}
          {tab === TAB.SSL && (
            <BlockStack gap="400">
              <Card>
                <SslTab siteId={siteId} />
              </Card>
              <StatusPageCard siteId={siteId} />
            </BlockStack>
          )}

          {/* Tab 8 — Maintenance */}
          {tab === TAB.MAINTENANCE && (
            <Card>
              <BlockStack gap="500">
                <InlineStack gap="300" blockAlign="center">
                  <Text as="h2" variant="headingMd">Maintenance Mode</Text>
                  <Badge tone={maintenanceMode ? 'warning' : 'success'}>
                    {maintenanceMode ? 'Down' : 'Online'}
                  </Badge>
                </InlineStack>

                <Text as="p" variant="bodySm" tone="subdued">
                  Runs <InlineCode>php artisan down</InlineCode> / <InlineCode>php artisan up</InlineCode>. While down, Laravel returns a 503 maintenance page. With a secret you can bypass it via <InlineCode>?secret=…</InlineCode>.
                </Text>

                {maintenanceError && (
                  <Banner tone="critical" onDismiss={() => setMaintenanceError('')}>{maintenanceError}</Banner>
                )}

                {!maintenanceMode ? (
                  <BlockStack gap="300">
                    <TextField
                      label="Bypass secret (optional)"
                      value={maintenanceSecret}
                      onChange={setMaintenanceSecret}
                      autoComplete="off"
                      placeholder="my-bypass-secret"
                      helpText={`Access your site at https://${site.domain}?secret=${maintenanceSecret || 'my-bypass-secret'} while it's in maintenance mode.`}
                    />
                    <InlineStack>
                      <Button tone="critical" onClick={() => handleMaintenance('down')} loading={maintenanceLoading} disabled={site.status !== 'active'}>
                        Enable Maintenance Mode
                      </Button>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <Banner tone="warning">
                    <BlockStack gap="300">
                      <Text as="p">Your site is currently in maintenance mode and returning HTTP 503.</Text>
                      <Button onClick={() => handleMaintenance('up')} loading={maintenanceLoading}>
                        Take Site Online
                      </Button>
                    </BlockStack>
                  </Banner>
                )}
              </BlockStack>
            </Card>
          )}

          {/* Tab 9 — Composer */}
          {tab === TAB.COMPOSER && (
            <Card>
              <ComposerTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 10 — Failed Jobs */}
          {tab === TAB.FAILED_JOBS && (
            <Card>
              <FailedJobsTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 11 — PHP-FPM */}
          {tab === TAB.PHPFPM && (
            <Card>
              <PhpFpmTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 12 — Terminal */}
          {tab === TAB.TERMINAL && (
            <Card>
              <WebTerminal siteId={siteId} />
            </Card>
          )}

          {/* Tab 13 — Provision Log */}
          {tab === TAB.PROVISION && (
            <Card>
              {site.status === 'provisioning' ? (
                <ProvisionLog endpoint={`/api/sites/${siteId}/provision/stream`} onComplete={() => fetchSite()} />
              ) : (
                <Banner tone={site.status === 'active' ? 'success' : 'warning'}>
                  Provision status: <strong>{site.status}</strong>
                </Banner>
              )}
            </Card>
          )}

          {/* Tab 14 — Laravel Logs */}
          {tab === TAB.LOGS && (
            <Card>
              <LaravelLogsTab siteId={siteId} />
            </Card>
          )}

          {/* Tab 15 — File Manager */}
          {tab === TAB.FILES && (
            <Card padding="0">
              <FileManagerTab siteId={siteId} rootPath={site.rootPath} />
            </Card>
          )}

        </div>
      </BlockStack>

      {/* ── Deployment log modal ──────────────────────────────────────────── */}
      <Modal open={!!logModal} onClose={() => setLogModal(null)}
        title={logModal ? `Deploy log — ${logModal.branch}@${logModal.commit ?? '?'}` : ''} size="large">
        <Modal.Section>
          {logModal?.log ? (
            <LogConsole lines={[logModal.log]} minHeight={200} maxHeight={520} />
          ) : (
            <Text as="p" tone="subdued">No log available.</Text>
          )}
        </Modal.Section>
      </Modal>

      {/* ── Destructive artisan confirmation ────────────────────────────── */}
      <Modal open={destructiveCmd !== null} onClose={() => setDestructiveCmd(null)}
        title="Confirm destructive command"
        primaryAction={{ content: `Run artisan ${destructiveCmd ?? ''}`, destructive: true, onAction: confirmDestructive }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDestructiveCmd(null) }]}>
        <Modal.Section>
          <BlockStack gap="300">
            <Banner tone="warning">This command can permanently delete or modify database data.</Banner>
            <Text as="p">
              Running <InlineCode>php artisan {destructiveCmd}</InlineCode> on <strong>{site.domain}</strong>.
              Make sure you have a recent backup before continuing.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Confirm domain rename ────────────────────────────────────────── */}
      <Modal open={renameConfirmOpen} onClose={() => setRenameConfirmOpen(false)}
        title={`Rename ${site.domain} to ${identityDomain}?`}
        primaryAction={{ content: 'Rename', destructive: true, loading: savingIdentity, onAction: doSaveIdentity }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setRenameConfirmOpen(false) }]}>
        <Modal.Section>
          <BlockStack gap="200">
            <Text as="p">
              This moves <code>{site.rootPath}</code> on the server and rewrites its Nginx config to serve{' '}
              <strong>{identityDomain}</strong> instead of <strong>{site.domain}</strong>.
            </Text>
            <Text as="p" tone="subdued">
              Point DNS at the new domain before or right after this completes. If SSL is enabled, re-run SSL setup
              for the new domain afterwards — the existing certificate won't cover it.
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Confirm disable ───────────────────────────────────────────────── */}
      <Modal open={disableConfirmOpen} onClose={() => setDisableConfirmOpen(false)}
        title={`Disable ${site.domain}?`}
        primaryAction={{ content: 'Disable site', destructive: true, loading: togglingEnabled, onAction: doToggleEnabled }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDisableConfirmOpen(false) }]}>
        <Modal.Section>
          <Text as="p">
            Removes this site's Nginx sites-enabled symlink and reloads Nginx — visitors will get a connection error
            until it's re-enabled. Files, the database, and the deploy history are left untouched.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── Delete modal ──────────────────────────────────────────────────── */}
      <Modal open={deleteOpen} onClose={() => { setDeleteOpen(false); setCleanupServer(false) }}
        title={`Delete ${site.domain}?`}
        primaryAction={{ content: cleanupServer ? 'Delete & Clean server' : 'Delete record', destructive: true, loading: deleting, onAction: handleDelete }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setDeleteOpen(false); setCleanupServer(false) } }]}>
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p">Removes the site from the Orchestrator database.</Text>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              <input type="checkbox" id="cleanup-server" checked={cleanupServer}
                onChange={(e) => setCleanupServer(e.target.checked)} style={{ marginTop: 2, accentColor: 'var(--oc-remove-color)' }} />
              <label htmlFor="cleanup-server" style={{ cursor: 'pointer' }}>
                <Text as="span" variant="bodyMd" fontWeight="semibold">Also remove from server</Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Deletes Nginx config, MySQL database{site.dbName ? ` (${site.dbName})` : ''}, and{' '}
                  <code>{site.rootPath}</code>. This cannot be undone.
                </Text>
              </label>
            </div>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {deleteResult && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 999, width: 'min(420px, calc(100vw - 32px))' }}>
          <Banner tone={deleteResult.ok ? 'success' : 'critical'} onDismiss={() => setDeleteResult(null)}>
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
