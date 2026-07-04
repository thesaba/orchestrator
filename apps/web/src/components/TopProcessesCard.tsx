import { useCallback, useEffect, useState } from 'react'
import {
  Card, BlockStack, InlineStack, Text, Badge, Button, ButtonGroup,
  DataTable, SkeletonBodyText, Tooltip
} from '@shopify/polaris'
import { RefreshIcon } from '@shopify/polaris-icons'
import { api, ProcessStats, ProcessService } from '../api/client'

function fmtBytes(n: number): string {
  if (!n) return '0 MB'
  const mb = n / (1024 * 1024)
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

type SortKey = 'cpu' | 'mem'

/**
 * Top resource-consuming services on the host, grouped by command (e.g. every
 * php-fpm worker summed into one "PHP-FPM" row). Sortable by CPU or memory and
 * self-refreshing. Backed by GET /monitor/processes.
 */
export function TopProcessesCard({ pollMs = 15_000 }: { pollMs?: number }) {
  const [data, setData] = useState<ProcessStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [sort, setSort] = useState<SortKey>('cpu')

  const load = useCallback(async () => {
    try {
      const d = await api.monitor.processes(12)
      setData(d)
    } catch { /* transient — keep last snapshot */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, pollMs)
    return () => clearInterval(t)
  }, [load, pollMs])

  const services: ProcessService[] = (data?.services ?? [])
    .slice()
    .sort((a, b) => (sort === 'cpu' ? b.cpuPercent - a.cpuPercent : b.rssBytes - a.rssBytes))

  const maxCpu = Math.max(1, ...services.map((s) => s.cpuPercent))
  const maxRss = Math.max(1, ...services.map((s) => s.rssBytes))

  const bar = (value: number, max: number, color: string) => (
    <div style={{ background: 'var(--p-color-bg-surface-secondary, #f1f1f1)', borderRadius: 4, height: 6, width: 90, overflow: 'hidden' }}>
      <div style={{ width: `${Math.min(100, (value / max) * 100)}%`, height: '100%', background: color }} />
    </div>
  )

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="050">
            <Text as="h2" variant="headingMd">Top services by resource use</Text>
            {data && (
              <Text as="span" variant="bodySm" tone="subdued">
                {data.cores} CPU cores · grouped by process
              </Text>
            )}
          </BlockStack>
          <InlineStack gap="200" blockAlign="center">
            <ButtonGroup variant="segmented">
              <Button pressed={sort === 'cpu'} onClick={() => setSort('cpu')}>CPU</Button>
              <Button pressed={sort === 'mem'} onClick={() => setSort('mem')}>Memory</Button>
            </ButtonGroup>
            <Button icon={RefreshIcon} onClick={load} accessibilityLabel="Refresh" />
          </InlineStack>
        </InlineStack>

        {loading && !data && <SkeletonBodyText lines={5} />}

        {data && services.length === 0 && (
          <Text as="p" tone="subdued">
            No process data available. (Process stats require a Linux host — this is expected on a local dev machine.)
          </Text>
        )}

        {services.length > 0 && (
          <DataTable
            columnContentTypes={['text', 'numeric', 'text', 'numeric', 'text', 'numeric']}
            headings={['Service', 'CPU %', '', 'Memory', '', 'Procs']}
            rows={services.map((s) => [
              <Text as="span" fontWeight="semibold">{s.name}</Text>,
              `${s.cpuPercent.toFixed(1)}%`,
              bar(s.cpuPercent, maxCpu, '#5c6ac4'),
              <Tooltip content={`${s.memPercent.toFixed(1)}% of RAM`}><span>{fmtBytes(s.rssBytes)}</span></Tooltip>,
              bar(s.rssBytes, maxRss, '#47c1bf'),
              <Badge>{String(s.count)}</Badge>
            ])}
          />
        )}
      </BlockStack>
    </Card>
  )
}
