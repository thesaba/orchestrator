import { Page, Card, BlockStack, Text, DataTable, Badge } from '@shopify/polaris'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, Site, ServiceStatus } from '../api/client'
import { SystemStatsCard }    from '../components/SystemStatsCard'
import { MetricsHistoryCard } from '../components/MetricsHistoryCard'
import { TopProcessesCard }   from '../components/TopProcessesCard'
import { AlertRulesCard }     from '../components/AlertRulesCard'
import { ApmCard }            from '../components/ApmCard'
import { useAuth }            from '../context/AuthContext'
import { ServiceControlCard } from '../components/ServiceControlCard'
import { LogTailViewer }      from '../components/LogTailViewer'
import { ActivityLog }        from '../components/ActivityLog'
import { SslExpiryCard }      from '../components/SslExpiryCard'
import { UptimeCard }         from '../components/UptimeCard'
import { UptimeCalendar }     from '../components/UptimeCalendar'
import { EmptyState }         from '../components/EmptyState'
import { DashboardGrid, WidgetDef } from '../components/dashboard/DashboardGrid'

const DEPLOY_TONE: Record<string, 'success' | 'critical' | 'info' | 'warning'> = {
  success: 'success',
  failed: 'critical',
  running: 'info',
  pending: 'warning'
}

export function MonitoringPage() {
  const { isAdmin } = useAuth()
  const [sites, setSites]       = useState<Site[]>([])
  const [services, setServices] = useState<ServiceStatus[]>([])

  useEffect(() => {
    api.sites.list().then(setSites).catch(() => {})
  }, [])

  const refreshServices = useCallback(() => {
    api.monitor.services().then(setServices).catch(() => {})
  }, [])

  useEffect(() => { refreshServices() }, [refreshServices])

  const recentDeploys = useMemo(() => sites
    .flatMap((s) => s.deployments.map((d) => ({ ...d, domain: s.domain })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8), [sites])

  const monitoredSites = useMemo(() => sites.filter((s) => s.uptimeMonitor), [sites])

  // Widget catalog: each entry is a self-contained card the DashboardGrid can
  // show/hide, resize and reorder. Data-dependent widgets close over `sites` /
  // `services`; the rest fetch their own data.
  const catalog: WidgetDef[] = useMemo(() => [
    { id: 'metrics-history', title: 'Resource history', defaultWidth: 'full', node: <MetricsHistoryCard /> },
    { id: 'system-stats',    title: 'System stats',     defaultWidth: 'half', node: <SystemStatsCard /> },
    {
      id: 'sites-summary', title: 'Sites summary', defaultWidth: 'half',
      node: (
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
      )
    },
    { id: 'uptime',         title: 'Uptime monitor', defaultWidth: 'half', node: <UptimeCard /> },
    { id: 'ssl',            title: 'SSL expiry',     defaultWidth: 'half', node: <SslExpiryCard /> },
    ...(isAdmin ? [{ id: 'alert-rules', title: 'Alert rules', defaultWidth: 'half' as const, node: <AlertRulesCard /> }] : []),
    { id: 'apm',            title: 'Performance (response times)', defaultWidth: 'full', node: <ApmCard /> },
    { id: 'top-processes',  title: 'Top services by resource use', defaultWidth: 'full', node: <TopProcessesCard /> },
    { id: 'services',       title: 'Service control', defaultWidth: 'full', node: <ServiceControlCard services={services} onRefresh={refreshServices} /> },
    {
      id: 'uptime-calendars', title: 'Uptime calendars', defaultWidth: 'full',
      node: monitoredSites.length === 0 ? (
        <EmptyState
          icon="📡"
          title="No sites being monitored"
          body="Enable uptime monitoring on individual sites to track availability, response times, and view the 90-day uptime calendar here."
        />
      ) : (
        <BlockStack gap="400">
          {monitoredSites.map((site) => (
            <Card key={site.id}>
              <UptimeCalendar siteId={site.id} domain={site.domain} />
            </Card>
          ))}
        </BlockStack>
      )
    },
    {
      id: 'recent-deploys', title: 'Recent deployments', defaultWidth: 'full',
      node: (
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
      )
    },
    {
      id: 'log-tail', title: 'Laravel log — live tail', defaultWidth: 'full',
      node: (
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Laravel Log — Live Tail</Text>
            <LogTailViewer sites={sites} />
          </BlockStack>
        </Card>
      )
    },
    {
      id: 'activity', title: 'Activity log', defaultWidth: 'full',
      node: <Card><ActivityLog sites={sites} /></Card>
    }
  ], [sites, services, refreshServices, recentDeploys, monitoredSites, isAdmin])

  return (
    <Page title="Monitoring" subtitle="Customizable dashboard — reorder, resize, hide widgets, and save presets">
      <DashboardGrid catalog={catalog} />
    </Page>
  )
}
