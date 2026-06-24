import { Page, Layout, Card, BlockStack, Text, DataTable, Badge } from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { api, Site, ServiceStatus } from '../api/client'
import { SystemStatsCard } from '../components/SystemStatsCard'
import { ServiceControlCard } from '../components/ServiceControlCard'
import { LogTailViewer } from '../components/LogTailViewer'
import { ActivityLog } from '../components/ActivityLog'

const DEPLOY_TONE: Record<string, 'success' | 'critical' | 'info' | 'warning'> = {
  success: 'success',
  failed: 'critical',
  running: 'info',
  pending: 'warning'
}

export function MonitoringPage() {
  const [sites, setSites] = useState<Site[]>([])
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
                  { label: 'Total', value: sites.length },
                  { label: 'Active', value: sites.filter((s) => s.status === 'active').length },
                  { label: 'SSL enabled', value: sites.filter((s) => s.sslEnabled).length },
                  {
                    label: 'Pending / Error',
                    value: sites.filter((s) => ['pending', 'error'].includes(s.status)).length
                  }
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                  >
                    <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                    <Text as="p" variant="bodyMd" fontWeight="semibold">{value}</Text>
                  </div>
                ))}
              </BlockStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Row 2: Services — full width so controls have space ──────── */}
        <Layout.Section>
          <ServiceControlCard services={services} onRefresh={refreshServices} />
        </Layout.Section>

        {/* ── Row 3: Recent deployments ────────────────────────────────── */}
        <Layout.Section>
          <Card padding="0">
            <div style={{ padding: '16px 20px 8px' }}>
              <Text as="h2" variant="headingMd">
                Recent Deployments
              </Text>
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
                <Text as="p" tone="subdued">
                  No deployments yet.
                </Text>
              </div>
            )}
          </Card>
        </Layout.Section>

        {/* ── Row 3: Log tail ──────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">
                Laravel Log — Live Tail
              </Text>
              <LogTailViewer sites={sites} />
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Row 4: Audit / Activity log ──────────────────────────────── */}
        <Layout.Section>
          <Card>
            <ActivityLog sites={sites} />
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  )
}
