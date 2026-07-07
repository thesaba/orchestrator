import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Page, Card, BlockStack, InlineStack, Text, Badge, Spinner } from '@shopify/polaris'
import { PublicStatus } from '../api/client'

/**
 * Public, shareable status page for one site (no auth). Fetches the token-scoped
 * public endpoint and renders a 90-day uptime strip + recent incidents.
 */
export function StatusPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<PublicStatus | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'notfound'>('loading')

  useEffect(() => {
    if (!token) return
    fetch(`/api/public/status/${encodeURIComponent(token)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => { setData(d); setState('ok') })
      .catch(() => setState('notfound'))
  }, [token])

  if (state === 'loading') {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner /></div>
  }
  if (state === 'notfound' || !data) {
    return (
      <Page>
        <Card><Text as="p" tone="subdued">This status page isn't available.</Text></Card>
      </Page>
    )
  }

  const isUp = data.current === 'up'
  return (
    <Page title={data.name || data.domain} subtitle={data.domain}>
      <BlockStack gap="400">
        <Card>
          <InlineStack align="space-between" blockAlign="center" wrap>
            <InlineStack gap="200" blockAlign="center">
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: isUp ? '#3fb950' : data.current === 'down' ? '#ff6b6b' : '#8b949e', display: 'inline-block' }} />
              <Text as="h2" variant="headingMd">{isUp ? 'All systems operational' : data.current === 'down' ? 'Service disruption' : 'Status unknown'}</Text>
            </InlineStack>
            <InlineStack gap="300">
              <Badge tone={data.overallPct != null && data.overallPct >= 99 ? 'success' : 'attention'}>
                {data.overallPct != null ? `${data.overallPct}% uptime (90d)` : 'no data'}
              </Badge>
              {data.avgMs != null && <Badge>{`${data.avgMs} ms avg`}</Badge>}
            </InlineStack>
          </InlineStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">Last 90 days</Text>
            <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              {data.days.length === 0 && <Text as="span" tone="subdued">No history yet.</Text>}
              {data.days.map((d) => (
                <div
                  key={d.date}
                  title={`${d.date}: ${d.upPct}%`}
                  style={{
                    width: 6, height: 28, borderRadius: 2,
                    background: d.upPct >= 99.5 ? '#3fb950' : d.upPct >= 95 ? '#e3b341' : '#ff6b6b'
                  }}
                />
              ))}
            </div>
          </BlockStack>
        </Card>

        {data.incidents.length > 0 && (
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">Recent incidents</Text>
              {data.incidents.map((i, idx) => (
                <Text key={idx} as="p" variant="bodySm" tone="subdued">
                  🔴 {new Date(i.from).toLocaleString()} → {new Date(i.to).toLocaleString()}
                </Text>
              ))}
            </BlockStack>
          </Card>
        )}

        <Text as="p" variant="bodySm" tone="subdued" alignment="center">Powered by Orchestrator</Text>
      </BlockStack>
    </Page>
  )
}
