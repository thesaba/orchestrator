import { Card, BlockStack, InlineStack, Text, ProgressBar, SkeletonBodyText } from '@shopify/polaris'
import { api, SystemStats } from '../api/client'
import { usePolling } from '../hooks/usePolling'

function fmt(bytes: number): string {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB'
  return (bytes / 1e3).toFixed(0) + ' KB'
}

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function barTone(pct: number): 'success' | 'highlight' | 'critical' {
  if (pct >= 85) return 'critical'
  if (pct >= 65) return 'highlight'
  return 'success'
}

function StatRow({
  label,
  percent,
  detail
}: {
  label: string
  percent: number
  detail: string
}) {
  return (
    <BlockStack gap="100">
      <InlineStack align="space-between">
        <Text as="p" variant="bodySm" fontWeight="semibold">
          {label}
        </Text>
        <Text as="p" variant="bodySm" tone="subdued">
          {detail}
        </Text>
      </InlineStack>
      <ProgressBar size="small" progress={percent} tone={barTone(percent)} />
      <Text as="p" variant="bodySm" tone="subdued">
        {percent}%
      </Text>
    </BlockStack>
  )
}

export function SystemStatsCard() {
  const { data: stats } = usePolling<SystemStats>(api.monitor.system, 3000)

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            System Resources
          </Text>
          {stats && (
            <Text as="p" variant="bodySm" tone="subdued">
              Up {fmtUptime(stats.uptime)}
            </Text>
          )}
        </InlineStack>

        {!stats ? (
          <SkeletonBodyText lines={6} />
        ) : (
          <BlockStack gap="400">
            <StatRow
              label="CPU"
              percent={stats.cpu.percent}
              detail={`${stats.cpu.load1} · ${stats.cpu.load5} · ${stats.cpu.load15} (${stats.cpu.cores} cores)`}
            />
            <StatRow
              label="RAM"
              percent={stats.ram.percent}
              detail={`${fmt(stats.ram.used)} / ${fmt(stats.ram.total)}`}
            />
            <StatRow
              label="Disk"
              percent={stats.disk.percent}
              detail={`${fmt(stats.disk.used)} / ${fmt(stats.disk.total)}`}
            />
            <StatRow
              label="Swap"
              percent={stats.swap.percent}
              detail={
                stats.swap.total > 0
                  ? `${fmt(stats.swap.used)} / ${fmt(stats.swap.total)}`
                  : 'Not configured'
              }
            />
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  )
}
