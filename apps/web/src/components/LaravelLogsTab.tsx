import { useState, useCallback, useEffect } from 'react'
import { BlockStack, InlineStack, Text, Button, Badge, Select, TextField, Spinner, Banner } from '@shopify/polaris'
import { logsApi, LogEntry } from '../api/client'

const LEVELS = ['all','error','warning','info','debug','critical','emergency','notice','alert']

const LEVEL_TONE: Record<string, 'critical' | 'warning' | 'info' | 'success' | 'attention'> = {
  error: 'critical', critical: 'critical', emergency: 'critical', alert: 'critical',
  warning: 'warning', notice: 'attention',
  info: 'info', debug: 'info'
}

interface Props { siteId: number }

export function LaravelLogsTab({ siteId }: Props) {
  const [entries,  setEntries]  = useState<LogEntry[]>([])
  const [total,    setTotal]    = useState(0)
  const [logPath,  setLogPath]  = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [level,    setLevel]    = useState('all')
  const [search,   setSearch]   = useState('')
  const [clearing, setClearing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await logsApi.list(siteId, {
        level: level === 'all' ? undefined : level,
        search: search || undefined,
        lines: 300
      })
      setEntries(res.entries)
      setTotal(res.total)
      setLogPath(res.path)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load logs')
    } finally {
      setLoading(false)
    }
  }, [siteId, level, search])

  useEffect(() => { load() }, [load])

  const handleClear = async () => {
    if (!confirm('Clear all log entries? This cannot be undone.')) return
    setClearing(true)
    try {
      await logsApi.clear(siteId)
      setEntries([]); setTotal(0)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to clear')
    } finally { setClearing(false) }
  }

  const errorCount = entries.filter(e => ['error','critical','emergency','alert'].includes(e.level)).length

  return (
    <BlockStack gap="400">
      {/* Toolbar */}
      <InlineStack gap="300" blockAlign="center" align="space-between" wrap={false}>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <div style={{ minWidth: 130 }}>
            <Select
              label="" labelHidden
              options={LEVELS.map(l => ({ label: l === 'all' ? 'All levels' : l.charAt(0).toUpperCase() + l.slice(1), value: l }))}
              value={level}
              onChange={setLevel}
            />
          </div>
          <div style={{ minWidth: 240 }}>
            <TextField label="" labelHidden value={search} onChange={setSearch}
              placeholder="Search messages…" autoComplete="off" clearButton onClearButtonClick={() => setSearch('')} />
          </div>
          <Button onClick={load} loading={loading} size="slim">Refresh</Button>
        </InlineStack>
        <InlineStack gap="200" blockAlign="center">
          {errorCount > 0 && <Badge tone="critical">{`${errorCount} errors`}</Badge>}
          <Text as="p" variant="bodySm" tone="subdued">{total} entries</Text>
          <Button size="slim" tone="critical" onClick={handleClear} loading={clearing}>Clear log</Button>
        </InlineStack>
      </InlineStack>

      {logPath && (
        <Text as="p" variant="bodySm" tone="subdued">{logPath}</Text>
      )}

      {error && <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>}

      {loading && entries.length === 0 ? (
        <InlineStack align="center"><Spinner size="small" /></InlineStack>
      ) : entries.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>📋</div>
          <Text as="p" variant="bodyMd" tone="subdued">No log entries found</Text>
        </div>
      ) : (
        <div style={{ fontFamily: 'SF Mono, Fira Code, Consolas, monospace', fontSize: 12 }}>
          {entries.map((e, i) => (
            <div key={i} style={{
              display: 'grid', gridTemplateColumns: '160px 80px 1fr',
              gap: 8, padding: '6px 0',
              borderBottom: '1px solid var(--oc-border)',
              alignItems: 'flex-start'
            }}>
              <Text as="span" variant="bodySm" tone="subdued">
                {e.timestamp ?? '—'}
              </Text>
              <Badge tone={LEVEL_TONE[e.level] ?? 'info'}>
                {e.level}
              </Badge>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.5 }}>
                {e.message}
              </pre>
            </div>
          ))}
        </div>
      )}
    </BlockStack>
  )
}
