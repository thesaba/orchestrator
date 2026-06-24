import { useEffect, useState } from 'react'
import { BlockStack, InlineStack, Text } from '@shopify/polaris'
import { heatmapApi } from '../api/client'

interface Props { siteId: number }

export function DeployHeatmap({ siteId }: Props) {
  const [days, setDays] = useState<Record<string, { total: number; success: number; failed: number }>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    heatmapApi.get(siteId).then(r => { setDays(r.days); setLoading(false) }).catch(() => setLoading(false))
  }, [siteId])

  // Build 52-week grid (Sun→Sat columns, 7 rows)
  const today = new Date()
  const weeks: { date: string; count: number; success: number; failed: number }[][] = []
  let week: { date: string; count: number; success: number; failed: number }[] = []
  for (let i = 363; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const data = days[key] ?? { total: 0, success: 0, failed: 0 }
    week.push({ date: key, count: data.total, success: data.success, failed: data.failed })
    if (week.length === 7) { weeks.push(week); week = [] }
  }
  if (week.length > 0) weeks.push(week)

  const color = (count: number, failed: number) => {
    if (count === 0) return 'var(--oc-bg-secondary)'
    if (failed > 0)  return failed === count ? '#ff6b6b' : '#ffa94d'
    if (count >= 3)  return '#37b24d'
    if (count >= 2)  return '#51cf66'
    return '#94d82d'
  }

  if (loading) return null

  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm">Deploy Activity (52 weeks)</Text>
        <InlineStack gap="200" blockAlign="center">
          {[['#94d82d','1 deploy'],['#37b24d','3+ deploys'],['#ff6b6b','failed']].map(([c, l]) => (
            <InlineStack key={l} gap="100" blockAlign="center">
              <div style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
              <Text as="span" variant="bodySm" tone="subdued">{l}</Text>
            </InlineStack>
          ))}
        </InlineStack>
      </InlineStack>
      <div style={{ display: 'flex', gap: 3, overflowX: 'auto', paddingBottom: 4 }}>
        {weeks.map((week, wi) => (
          <div key={wi} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {week.map((day) => (
              <div
                key={day.date}
                title={`${day.date}: ${day.count} deploy${day.count !== 1 ? 's' : ''}${day.failed > 0 ? `, ${day.failed} failed` : ''}`}
                style={{
                  width: 11, height: 11, borderRadius: 2,
                  background: color(day.count, day.failed),
                  cursor: day.count > 0 ? 'pointer' : 'default'
                }}
              />
            ))}
          </div>
        ))}
      </div>
    </BlockStack>
  )
}
