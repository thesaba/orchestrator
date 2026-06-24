import {
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Divider,
  DataTable,
  Card
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { api, WorkerProcess } from '../api/client'
import { ConfigEditor } from './ConfigEditor'

interface Props {
  siteId: number
  phpVersion: string
}

const STATE_TONE: Record<string, 'success' | 'critical' | 'warning' | 'info'> = {
  RUNNING:  'success',
  STOPPED:  'critical',
  STARTING: 'info',
  STOPPING: 'warning',
  FATAL:    'critical',
  EXITED:   'warning'
}

export function WorkersTab({ siteId, phpVersion }: Props) {
  const [loaded, setLoaded] = useState(false)

  // Supervisor config
  const [configContent, setConfigContent] = useState('')
  const [configPath, setConfigPath] = useState('')
  const [configError, setConfigError] = useState('')

  // Worker processes
  const [processes, setProcesses] = useState<WorkerProcess[]>([])
  const [controlling, setControlling] = useState<string | null>(null)
  const [controlResult, setControlResult] = useState<{ ok: boolean; text: string } | null>(null)

  // Scheduler cron
  const [cronActive, setCronActive] = useState(false)
  const [cronExpected, setCronExpected] = useState('')
  const [cronLoading, setCronLoading] = useState(false)
  const [cronResult, setCronResult] = useState<{ ok: boolean; text: string } | null>(null)

  const loadAll = useCallback(async () => {
    try {
      const [cfg, status, cron] = await Promise.all([
        api.supervisor.getConfig(siteId),
        api.supervisor.getStatus(siteId),
        api.supervisor.getCron(siteId)
      ])
      setConfigContent(cfg.content)
      setConfigPath(cfg.path)
      setProcesses(status.processes)
      setCronActive(cron.active)
      setCronExpected(cron.expected)
      setLoaded(true)
    } catch { /* ignore — supervisor may not be installed */ }
  }, [siteId])

  useEffect(() => { loadAll() }, [loadAll])

  const handleSaveConfig = useCallback(async () => {
    setConfigError('')
    try {
      const res = await api.supervisor.saveConfig(siteId, configContent)
      if (!res.ok) throw new Error(res.output)
      await loadAll()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Save failed'
      setConfigError(msg)
      throw err // propagate so ConfigEditor shows its error banner
    }
  }, [siteId, configContent, loadAll])

  const handleWorkerAction = async (action: string) => {
    setControlling(action)
    setControlResult(null)
    try {
      const res = await api.supervisor.control(siteId, action)
      setProcesses(res.processes)
      setControlResult({
        ok: res.ok,
        text: res.output || `${action} ${res.ok ? 'succeeded' : 'failed'}`
      })
    } catch (err: unknown) {
      setControlResult({ ok: false, text: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setControlling(null)
    }
  }

  const handleCronToggle = async () => {
    setCronLoading(true)
    setCronResult(null)
    try {
      if (cronActive) {
        await api.supervisor.disableCron(siteId)
        setCronActive(false)
        setCronResult({ ok: true, text: 'Scheduler cron removed.' })
      } else {
        await api.supervisor.enableCron(siteId)
        setCronActive(true)
        setCronResult({ ok: true, text: 'Scheduler cron installed.' })
      }
    } catch (err: unknown) {
      setCronResult({ ok: false, text: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setCronLoading(false)
    }
  }

  if (!loaded) return <Text as="p" tone="subdued">Loading supervisor info…</Text>

  return (
    <BlockStack gap="600">

      {/* ── Supervisor config ─────────────────────────────────────────── */}
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">Supervisor Config</Text>
          {configPath && (
            <Text as="p" variant="bodySm" tone="subdued">{configPath}</Text>
          )}
        </InlineStack>
        {configError && (
          <Banner tone="critical" onDismiss={() => setConfigError('')}>
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' }}>
              {configError}
            </pre>
          </Banner>
        )}
        <ConfigEditor
          value={configContent}
          onChange={setConfigContent}
          onSave={handleSaveConfig}
          saveLabel="Save & Reload Supervisor"
          minHeight="280px"
        />
      </BlockStack>

      <Divider />

      {/* ── Worker status + control ───────────────────────────────────── */}
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingSm">Worker Processes</Text>
          <InlineStack gap="200">
            {(['start', 'stop', 'restart'] as const).map((action) => (
              <Button
                key={action}
                size="slim"
                tone={action === 'stop' ? 'critical' : undefined}
                loading={controlling === action}
                disabled={controlling !== null}
                onClick={() => handleWorkerAction(action)}
              >
                {action.charAt(0).toUpperCase() + action.slice(1)} all
              </Button>
            ))}
            <Button size="slim" variant="plain" onClick={loadAll}>
              Refresh
            </Button>
          </InlineStack>
        </InlineStack>

        {controlResult && (
          <Banner
            tone={controlResult.ok ? 'success' : 'critical'}
            onDismiss={() => setControlResult(null)}
          >
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '12px' }}>
              {controlResult.text}
            </pre>
          </Banner>
        )}

        {processes.length === 0 ? (
          <Text as="p" tone="subdued">
            No worker processes found. Save the config above to register them with supervisor.
          </Text>
        ) : (
          <DataTable
            columnContentTypes={['text', 'text', 'text']}
            headings={['Process', 'State', 'Info']}
            rows={processes.map((p) => [
              <Text as="span" variant="bodySm" fontWeight="semibold">{p.name}</Text>,
              <Badge tone={STATE_TONE[p.state] ?? 'info'}>{p.state}</Badge>,
              <Text as="span" variant="bodySm" tone="subdued">{p.description}</Text>
            ])}
          />
        )}
      </BlockStack>

      <Divider />

      {/* ── Laravel Scheduler ─────────────────────────────────────────── */}
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <InlineStack gap="300" blockAlign="center">
              <Text as="h3" variant="headingSm">Laravel Scheduler</Text>
              <Badge tone={cronActive ? 'success' : 'warning'}>
                {cronActive ? 'Active' : 'Inactive'}
              </Badge>
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              Installs a cron.d entry that runs{' '}
              <code>php{phpVersion} artisan schedule:run</code> every minute.
            </Text>
          </BlockStack>
          <Button
            variant={cronActive ? 'secondary' : 'primary'}
            tone={cronActive ? 'critical' : undefined}
            loading={cronLoading}
            onClick={handleCronToggle}
          >
            {cronActive ? 'Disable scheduler' : 'Enable scheduler'}
          </Button>
        </InlineStack>

        {cronResult && (
          <Banner
            tone={cronResult.ok ? 'success' : 'critical'}
            onDismiss={() => setCronResult(null)}
          >
            {cronResult.text}
          </Banner>
        )}

        {cronExpected && (
          <div className="oc-terminal" style={{ whiteSpace: 'pre' }}>
            {cronExpected}
          </div>
        )}
      </BlockStack>

    </BlockStack>
  )
}
