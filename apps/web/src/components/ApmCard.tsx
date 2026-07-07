import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, Button, ButtonGroup, DataTable, Badge, SkeletonBodyText } from '@shopify/polaris'
import { RefreshIcon } from '@shopify/polaris-icons'
import { api, ApmSite } from '../api/client'

const WINDOWS = [{ label: '6h', value: 6 }, { label: '24h', value: 24 }, { label: '7d', value: 168 }]

function ms(n: number | null): string { return n == null ? '—' : `${n} ms` }

/**
 * Performance insights derived from synthetic uptime checks: response-time
 * percentiles (p50/p95/p99) and uptime % per monitored site, slowest first.
 */
export function ApmCard() {
  const [sites, setSites] = useState<ApmSite[] | null>(null)
  const [hours, setHours] = useState(24)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    api.monitor.apm(hours).then((r) => setSites(r.sites)).catch(() => setSites([])).finally(() => setLoading(false))
  }, [hours])
  useEffect(() => { load() }, [load])

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Performance (response times)</Text>
            <Text as="span" variant="bodySm" tone="subdued">Percentiles from uptime checks · slowest first</Text>
          </BlockStack>
          <InlineStack gap="200" blockAlign="center">
            <ButtonGroup variant="segmented">
              {WINDOWS.map((w) => (
                <Button key={w.value} pressed={hours === w.value} onClick={() => setHours(w.value)}>{w.label}</Button>
              ))}
            </ButtonGroup>
            <Button icon={RefreshIcon} onClick={load} accessibilityLabel="Refresh" />
          </InlineStack>
        </InlineStack>

        {loading && !sites && <SkeletonBodyText lines={4} />}

        {sites && sites.length === 0 && (
          <Text as="p" tone="subdued">No uptime data yet. Enable uptime monitoring on sites to collect response times.</Text>
        )}

        {sites && sites.length > 0 && (
          <DataTable
            columnContentTypes={['text', 'text', 'numeric', 'numeric', 'numeric', 'numeric']}
            headings={['Site', 'Uptime', 'p50', 'p95', 'p99', 'Samples']}
            rows={sites.map((s) => [
              <Text as="span" fontWeight="semibold">{s.domain}</Text>,
              s.uptimePct != null
                ? <Badge tone={s.uptimePct >= 99.9 ? 'success' : s.uptimePct >= 99 ? 'attention' : 'critical'}>{`${s.uptimePct}%`}</Badge>
                : '—',
              ms(s.p50),
              ms(s.p95),
              ms(s.p99),
              String(s.samples)
            ])}
          />
        )}
      </BlockStack>
    </Card>
  )
}
