import { useEffect, useState } from 'react'
import { BlockStack, InlineStack, Text, Spinner } from '@shopify/polaris'
import { uptimeApi } from '../api/client'

interface Props { siteId: number; domain: string }

export function UptimeCalendar({ siteId, domain }: Props) {
  const [checks, setChecks] = useState<{ status: string; checkedAt: string }[]>([])
  const [uptime24h, setUptime24h] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    uptimeApi.history(siteId)
      .then(r => { setChecks(r.checks); setUptime24h(r.uptime24h ?? null) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [siteId])

  if (loading) return <Spinner size="small" />

  // Build 90-day grid: group checks by date, compute uptime %
  const byDate: Record<string, { up: number; total: number }> = {}
  for (const c of checks) {
    const d = c.checkedAt.slice(0, 10)
    if (!byDate[d]) byDate[d] = { up: 0, total: 0 }
    byDate[d].total++
    if (c.status === 'up') byDate[d].up++
  }

  const today = new Date()
  const days = Array.from({ length: 90 }, (_, i) => {
    const d = new Date(today); d.setDate(d.getDate() - (89 - i))
    const key = d.toISOString().slice(0, 10)
    const data = byDate[key]
    return { key, pct: data ? data.up / data.total : null }
  })

  const cellColor = (pct: number | null) => {
    if (pct === null) return 'var(--oc-bg-secondary)'
    if (pct >= 0.99) return '#37b24d'
    if (pct >= 0.95) return '#94d82d'
    if (pct >= 0.80) return '#ffa94d'
    return '#ff6b6b'
  }

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm">{domain} — 90-day uptime</Text>
        {uptime24h !== null && (
          <Text as="p" variant="bodySm" tone="subdued">
            24h: <strong>{uptime24h.toFixed(1)}%</strong>
          </Text>
        )}
      </InlineStack>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
        {days.map((d) => (
          <div
            key={d.key}
            title={`${d.key}: ${d.pct !== null ? (d.pct * 100).toFixed(1) + '%' : 'no data'}`}
            style={{
              width: 12, height: 12, borderRadius: 2,
              background: cellColor(d.pct),
              flexShrink: 0
            }}
          />
        ))}
      </div>
      <InlineStack gap="300">
        {[['#37b24d','100%'],['#94d82d','≥95%'],['#ffa94d','≥80%'],['#ff6b6b','<80%'],['var(--oc-bg-secondary)','No data']].map(([c,l]) => (
          <InlineStack key={l} gap="100" blockAlign="center">
            <div style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
            <Text as="span" variant="bodySm" tone="subdued">{l}</Text>
          </InlineStack>
        ))}
      </InlineStack>
    </BlockStack>
  )
}
