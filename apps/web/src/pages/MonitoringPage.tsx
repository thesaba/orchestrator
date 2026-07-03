import { Page, Layout, Card, BlockStack, Text, DataTable, Badge } from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { api, Site, ServiceStatus } from '../api/client'
import { SystemStatsCard }    from '../components/SystemStatsCard'
import { MetricsHistoryCard } from '../components/MetricsHistoryCard'
import { ServiceControlCard } from '../components/ServiceControlCard'
import { LogTailViewer }      from '../components/LogTailViewer'
import { ActivityLog }        from '../components/ActivityLog'
import { SslExpiryCard }      from '../components/SslExpiryCard'
import { UptimeCard }         from '../components/UptimeCard'
import { UptimeCalendar }     from '../components/UptimeCalendar'
import { EmptyState }         from '../components/EmptyState'

const DEPLOY_TONE: Record<string, 'success' | 'critical' | 'info' | 'warning'> = {
  success: 'success',
  failed: 'critical',
  running: 'info',
  pending: 'warning'
}

export function MonitoringPage() {
  const [sites, setSites]       = useState<Site[]>([])
  const [services, setServices] = useState<ServiceStatus[]>([])

  useEffect(() => {
    api.sites.list().then(setSites).catch(() => {})
  }, [])

  const refreshServices = useCallback(() => {
    api.monitor.services().then(setServices).catch(() => {})
  }, [])

  useEffect(() => { refreshServices() }, [refreshServices])

  const recentDeploys = sites
    .flatMap((s) => s.deployments.map((d) => ({ ...d, domain: s.domain })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8)

  return (
    <Page title="Monitoring">
      <Layout>
        {/* ── Resource history chart ──────────────────────────────────── */}
        <Layout.Section>
          <MetricsHistoryCard />
        </Layout.Section>

        {/* ── Row 1: System stats + Site stats ────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <SystemStatsCard />
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Sites</Text>
              <BlockStack gap="200">
                {[
                  { label: 'Total',           value: sites.length },
                  { label: 'Active',          value: sites.filter((s) => s.status === 'active').length },
                  { label: 'SSL enabled',     value: sites.filter((s) => s.sslEnabled).length },
                  { label: 'Pending / Error', value: sites.filter((s) => ['pending', 'error'].includes(s.status)).length }
                ].map(({ label, value }) => (
                  <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">{value}</Text>
                  </div>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Row 2: Uptime monitor + SSL expiry ──────────────────────── */}
        <Layout.Section variant="oneHalf">
          <UptimeCard />
        </Layout.Section>

        <Layout.Section variant="oneHalf">
          <SslExpiryCard />
        </Layout.Section>

        {/* ── Row 2b: Uptime calendars per monitored site ─────────────── */}
        {sites.filter((s) => s.uptimeMonitor).length === 0 ? (
          <Layout.Section>
            <EmptyState
              icon="📡"
              title="No sites being monitored"
              body="Enable uptime monitoring on individual sites to track availability, response times, and view the 90-day uptime calendar here."
            />
          </Layout.Section>
        ) : (
          sites.filter((s) => s.uptimeMonitor).map((site) => (
            <Layout.Section key={site.id}>
              <Card>
                <UptimeCalendar siteId={site.id} domain={site.domain} />
              </Card>
            </Layout.Section>
          ))
        )}

        {/* ── Row 3: Services — full width ────────────────────────────── */}
        <Layout.Section>
          <ServiceControlCard services={services} onRefresh={refreshServices} />
        </Layout.Section>

        {/* ── Row 4: Recent deployments ────────────────────────────────── */}
        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: '16px 20px 8px' }}>
              <Text as="h2" variant="headingMd">Recent Deployments</Text>
            </div>
            {recentDeploys.length > 0 ? (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text', 'text']}
                headings={['Site', 'Branch', 'Commit', 'Status', 'Time']}
                rows={recentDeploys.map((d) => [
                  d.domain,
                  d.branch,
                  d.commit ?? '—',
                  <Badge tone={DEPLOY_TONE[d.status] ?? 'info'}>{d.status}</Badge>,
                  new Date(d.createdAt).toLocaleString()
                ])}
              />
            ) : (
              <div style={{ padding: '24px', textAlign: 'center' }}>
                <Text as="p" tone="subdued">No deployments yet.</Text>
              </div>
            )}
          </Card>
        </Layout.Section>

        {/* ── Row 5: Log tail ──────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Laravel Log — Live Tail</Text>
              <LogTailViewer sites={sites} />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Row 6: Audit / Activity log ──────────────────────────────── */}
        <Layout.Section>
          <Card>
            <ActivityLog sites={sites} />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  )
}
