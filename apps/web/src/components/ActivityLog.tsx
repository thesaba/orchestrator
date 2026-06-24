import { BlockStack, InlineStack, Text, Badge, Button, Select } from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { api, AuditEntry, Site } from '../api/client'

const ACTION_META: Record<string, { icon: string; tone: 'success' | 'critical' | 'info' | 'warning' }> = {
  'deploy.success':    { icon: '🚀', tone: 'success' },
  'deploy.failed':     { icon: '💥', tone: 'critical' },
  'rollback.success':  { icon: '↩️', tone: 'info' },
  'rollback.failed':   { icon: '❌', tone: 'critical' },
  'site.created':      { icon: '➕', tone: 'info' },
  'site.deleted':      { icon: '🗑️', tone: 'warning' },
  'provision.success': { icon: '✅', tone: 'success' },
  'provision.failed':  { icon: '❌', tone: 'critical' }
}

function actionLabel(action: string): string {
  return action.replace('.', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function metaSummary(entry: AuditEntry): string {
  if (!entry.meta) return ''
  const m = entry.meta
  const parts: string[] = []
  if (m.domain)  parts.push(String(m.domain))
  if (m.branch)  parts.push(`branch: ${m.branch}`)
  if (m.commit)  parts.push(`@ ${String(m.commit).slice(0, 7)}`)
  if (m.release) parts.push(`release: ${m.release}`)
  return parts.join(' · ')
}

interface Props {
  sites: Site[]
}

const PAGE = 30

export function ActivityLog({ sites }: Props) {
  const [logs, setLogs]       = useState<AuditEntry[]>([])
  const [total, setTotal]     = useState(0)
  const [offset, setOffset]   = useState(0)
  const [siteFilter, setSiteFilter] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async (off: number, sid: string) => {
    setLoading(true)
    try {
      const res = await api.audit.list({
        limit: PAGE,
        offset: off,
        ...(sid ? { siteId: Number(sid) } : {})
      })
      setLogs(res.logs)
      setTotal(res.total)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(0, siteFilter); setOffset(0) }, [siteFilter]) // eslint-disable-line
  useEffect(() => { load(offset, siteFilter) }, [offset])              // eslint-disable-line

  // Auto-refresh every 30s (only on page 1 to avoid jumping)
  useEffect(() => {
    const id = setInterval(() => { if (offset === 0) load(0, siteFilter) }, 30_000)
    return () => clearInterval(id)
  }, [offset, siteFilter]) // eslint-disable-line

  const siteOptions = [
    { label: 'All sites', value: '' },
    ...sites.map((s) => ({ label: s.domain, value: String(s.id) }))
  ]

  return (
    <BlockStack gap="400">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">Activity Log</Text>
        <InlineStack gap="300" blockAlign="center">
          <div style={{ width: 220 }}>
            <Select
              label=""
              labelHidden
              options={siteOptions}
              value={siteFilter}
              onChange={setSiteFilter}
            />
          </div>
          <Button size="slim" onClick={() => load(offset, siteFilter)} loading={loading}>
            Refresh
          </Button>
        </InlineStack>
      </InlineStack>

      {logs.length === 0 && !loading ? (
        <Text as="p" tone="subdued">No activity recorded yet.</Text>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {logs.map((entry, i) => {
            const meta  = ACTION_META[entry.action]
            const icon  = meta?.icon ?? '•'
            const tone  = meta?.tone ?? 'info'
            const summary = metaSummary(entry)

            return (
              <div
                key={entry.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '10px 4px',
                  borderBottom: i < logs.length - 1 ? '1px solid #e1e3e5' : 'none'
                }}
              >
                <span style={{ fontSize: 16, lineHeight: 1.4, flexShrink: 0 }}>{icon}</span>
                <BlockStack gap="050" inlineAlign="start">
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={tone}>{actionLabel(entry.action)}</Badge>
                    {summary && (
                      <Text as="span" variant="bodySm" tone="subdued">{summary}</Text>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {new Date(entry.createdAt).toLocaleString()}
                  </Text>
                </BlockStack>
              </div>
            )
          })}
        </div>
      )}

      {/* Pagination */}
      {total > PAGE && (
        <InlineStack align="center" gap="300">
          <Button
            size="slim"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE))}
          >
            ← Previous
          </Button>
          <Text as="p" variant="bodySm" tone="subdued">
            {offset + 1}–{Math.min(offset + PAGE, total)} of {total}
          </Text>
          <Button
            size="slim"
            disabled={offset + PAGE >= total}
            onClick={() => setOffset(offset + PAGE)}
          >
            Next →
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  )
}
