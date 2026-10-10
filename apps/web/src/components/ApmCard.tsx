import { useEffect, useState } from 'react'
import {
  Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner, Button, Box, Divider
} from '@shopify/polaris'
import { apmApi, type ApmData } from '../api/client'

// Laravel-aware APM (read-only). Surfaces slow queries, slow requests and recent
// exceptions from the site's Laravel Telescope data. Degrades gracefully when
// Telescope isn't installed or the site is remote.
export function ApmCard({ siteId }: { siteId: number }) {
  const [data, setData] = useState<ApmData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try { setData(await apmApi.get(siteId)) }
    catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [siteId])

  const ms = (n: number | null) => (n === null ? '—' : `${Math.round(n)} ms`)
  const msTone = (n: number | null) => (n === null ? undefined : n >= 1000 ? 'critical' : n >= 300 ? 'warning' : 'success') as 'critical' | 'warning' | 'success' | undefined

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Performance (APM)</Text>
          <Button size="slim" onClick={load} loading={loading}>Refresh</Button>
        </InlineStack>

        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        {loading && !data && <InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="span" tone="subdued">Loading…</Text></InlineStack>}

        {data && !data.installed && (
          <Banner tone="info">{data.message ?? 'APM is not available for this site.'}</Banner>
        )}

        {data?.installed && (
          <BlockStack gap="400">
            <Text as="p" tone="subdued" variant="bodySm">Last {data.windowHours ?? 24}h, from Laravel Telescope.</Text>

            <InlineStack gap="400" wrap>
              <Stat label="Requests" value={data.counts?.requests ?? 0} />
              <Stat label="Queries" value={data.counts?.queries ?? 0} />
              <Stat label="Slow queries (>100ms)" value={data.counts?.slowQueries ?? 0} tone={(data.counts?.slowQueries ?? 0) > 0 ? 'warning' : undefined} />
              <Stat label="Exceptions" value={data.counts?.exceptions ?? 0} tone={(data.counts?.exceptions ?? 0) > 0 ? 'critical' : undefined} />
            </InlineStack>

            <Divider />
            <Text as="h3" variant="headingSm">Slowest queries</Text>
            {(data.slowQueries ?? []).length === 0
              ? <Text as="p" tone="subdued" variant="bodySm">None recorded.</Text>
              : (data.slowQueries ?? []).map((q, i) => (
                <InlineStack key={i} align="space-between" blockAlign="start" gap="200" wrap={false}>
                  <Box width="80%"><Text as="span" variant="bodySm" truncate>{q.query ?? '—'}</Text></Box>
                  <Badge tone={msTone(q.ms)}>{ms(q.ms)}</Badge>
                </InlineStack>
              ))}

            <Divider />
            <Text as="h3" variant="headingSm">Slowest requests</Text>
            {(data.slowRequests ?? []).length === 0
              ? <Text as="p" tone="subdued" variant="bodySm">None recorded.</Text>
              : (data.slowRequests ?? []).map((r, i) => (
                <InlineStack key={i} align="space-between" blockAlign="center" gap="200" wrap={false}>
                  <Box width="80%">
                    <Text as="span" variant="bodySm" truncate>
                      <Text as="span" fontWeight="semibold">{r.method ?? ''}</Text> {r.uri ?? '—'} {r.status ? `· ${r.status}` : ''}
                    </Text>
                  </Box>
                  <Badge tone={msTone(r.ms)}>{ms(r.ms)}</Badge>
                </InlineStack>
              ))}

            <Divider />
            <Text as="h3" variant="headingSm">Recent exceptions</Text>
            {(data.exceptions ?? []).length === 0
              ? <Text as="p" tone="subdued" variant="bodySm">None recorded. 🎉</Text>
              : (data.exceptions ?? []).map((e, i) => (
                <BlockStack key={i} gap="050">
                  <Text as="span" variant="bodySm" fontWeight="semibold" tone="critical">{e.class ?? 'Exception'}</Text>
                  <Text as="span" variant="bodySm" truncate>{e.message ?? ''}</Text>
                </BlockStack>
              ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warning' | 'critical' }) {
  return (
    <BlockStack gap="050">
      <Text as="span" tone="subdued" variant="bodySm">{label}</Text>
      <Text as="span" variant="headingLg" tone={tone === 'critical' ? 'critical' : undefined}>{value}</Text>
    </BlockStack>
  )
}
