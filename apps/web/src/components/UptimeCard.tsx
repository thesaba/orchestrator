import { useEffect, useState, useCallback } from 'react'
import { Card, Text, SkeletonBodyText, InlineStack, Button, Badge } from '@shopify/polaris'
import { uptimeApi, type UptimeSiteStatus } from '../api/client'

function StatusDot({ status }: { status: string }) {
  const color = status === 'up' ? '#36b37e' : status === 'down' ? '#de3618' : '#8c9196'
  const shadow = status === 'up' ? '0 0 0 3px rgba(54,179,126,.25)' : undefined
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
      background: color, boxShadow: shadow, flexShrink: 0
    }} />
  )
}

export function UptimeCard() {
  const [sites, setSites]     = useState<UptimeSiteStatus[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await uptimeApi.list()
      setSites(data.sites)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  // Auto-refresh every 2 minutes
  useEffect(() => {
    const t = setInterval(load, 2 * 60_000)
    return () => clearInterval(t)
  }, [load])

  const upCount   = sites?.filter((s) => s.status === 'up').length ?? 0
  const downCount = sites?.filter((s) => s.status === 'down').length ?? 0

  return (
    <Card>
      <InlineStack gap="400" align="space-between" blockAlign="center">
        <InlineStack gap="200" blockAlign="center">
          <Text as="h2" variant="headingMd">Uptime Monitor</Text>
          {!loading && sites && (
            <InlineStack gap="100">
              {upCount > 0   && <Badge tone="success">{`${upCount} up`}</Badge>}
              {downCount > 0 && <Badge tone="critical">{`${downCount} down`}</Badge>}
            </InlineStack>
          )}
        </InlineStack>
        <Button size="slim" onClick={load} loading={loading}>Refresh</Button>
      </InlineStack>

      <div style={{ marginTop: 12 }}>
        {loading && !sites ? (
          <SkeletonBodyText lines={3} />
        ) : sites && sites.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sites.map((s) => (
              <div
                key={s.siteId}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 8px', borderRadius: 6,
                  background: s.status === 'down' ? '#fff4f4' : undefined
                }}
              >
                <StatusDot status={s.status} />
                <Text as="span" variant="bodyMd" fontWeight="semibold">{s.domain}</Text>
                <div style={{ flex: 1 }} />
                {s.responseMs !== null && (
                  <Text as="span" tone="subdued" variant="bodySm">{`${s.responseMs}ms`}</Text>
                )}
                <Text as="span" tone="subdued" variant="bodySm">
                  {s.checkedAt ? new Date(s.checkedAt).toLocaleTimeString() : '—'}
                </Text>
              </div>
            ))}
          </div>
        ) : (
          <Text as="p" tone="subdued">No active sites are being monitored yet.</Text>
        )}
      </div>
    </Card>
  )
}
