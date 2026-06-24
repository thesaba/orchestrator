import {
  Page, Layout, Card, BlockStack, InlineStack,
  Text, Badge, Button, SkeletonBodyText
} from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid
} from 'recharts'
import { api, Site, statsApi } from '../api/client'
import { SystemStatsCard } from '../components/SystemStatsCard'
import { ServicesCard } from '../components/ServicesCard'
import { OnboardingWizard } from '../components/OnboardingWizard'
import { EmptyState } from '../components/EmptyState'

const DEPLOY_TONE: Record<string, 'success' | 'critical' | 'info' | 'warning'> = {
  success: 'success', failed: 'critical', running: 'info', pending: 'warning'
}

export function DashboardPage() {
  const [sites,        setSites]       = useState<Site[]>([])
  const [history,      setHistory]     = useState<{ date: string; success: number; failed: number }[]>([])
  const [loading,      setLoading]     = useState(true)
  const navigate = useNavigate()

  useEffect(() => {
    Promise.all([api.sites.list(), statsApi.history()])
      .then(([s, h]) => { setSites(s); setHistory(h.days) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const activeSites   = sites.filter((s) => s.status === 'active')
  const recentDeploys = sites
    .flatMap((s) => s.deployments.map((d) => ({ ...d, domain: s.domain })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 5)

  const chartData = history.map((d) => ({
    date: d.date.slice(5),  // MM-DD
    Success: d.success,
    Failed: d.failed
  }))

  return (
    <Page title="Dashboard">
      <OnboardingWizard />
      <Layout>
        {/* ── Stats row ─────────────────────────────────────────────────── */}
        <Layout.Section variant="oneThird">
          <SystemStatsCard />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <ServicesCard />
        </Layout.Section>
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Quick Stats</Text>
              {loading ? <SkeletonBodyText lines={3} /> : (
                <BlockStack gap="200">
                  {[
                    { label: 'Active sites', value: activeSites.length },
                    { label: 'Total sites',  value: sites.length },
                    { label: 'SSL secured',  value: sites.filter((s) => s.sslEnabled).length },
                    { label: 'Pinned',       value: sites.filter((s) => s.pinned).length }
                  ].map(({ label, value }) => (
                    <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                      <Text as="p" variant="bodyMd" fontWeight="semibold">{String(value)}</Text>
                    </div>
                  ))}
                </BlockStack>
              )}
              <Button onClick={() => navigate('/sites/new')} variant="primary" fullWidth>
                + New site
              </Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Deploy history chart ──────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Deployments — Last 7 Days</Text>
              {loading ? <SkeletonBodyText lines={5} /> : (
                <div style={{ height: 220 }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} margin={{ top: 4, right: 4, left: -10, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--oc-border)" />
                      <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                      <Tooltip />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="Success" fill="#47c1bf" radius={[3, 3, 0, 0]} />
                      <Bar dataKey="Failed"  fill="#de3618" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Recent deployments ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Recent Deployments</Text>
                <Button variant="plain" onClick={() => navigate('/monitoring')}>View all →</Button>
              </InlineStack>
              {loading ? <SkeletonBodyText lines={4} /> : recentDeploys.length === 0 ? (
                <Text as="p" tone="subdued">No deployments yet.</Text>
              ) : (
                <BlockStack gap="200">
                  {recentDeploys.map((d) => (
                    <div key={d.id} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 0', borderBottom: '1px solid var(--oc-border)'
                    }}>
                      <BlockStack gap="100">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">{d.domain}</Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {d.branch}{d.commit ? ` @ ${d.commit}` : ''}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200" align="end">
                        <Badge tone={DEPLOY_TONE[d.status] ?? 'info'}>{d.status}</Badge>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {new Date(d.createdAt).toLocaleTimeString()}
                        </Text>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Sites list ───────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Sites</Text>
                <Button variant="plain" onClick={() => navigate('/sites')}>Manage →</Button>
              </InlineStack>
              {loading ? <SkeletonBodyText lines={3} /> : sites.length === 0 ? (
                <EmptyState
                  icon="🌐"
                  title="No sites yet"
                  body="Add your first Laravel site to get started."
                  action={{ label: 'Add site', onAction: () => navigate('/sites/new') }}
                />
              ) : (
                <BlockStack gap="200">
                  {sites.map((s) => (
                    <div key={s.id} onClick={() => navigate(`/sites/${s.id}`)} style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '8px 0', borderBottom: '1px solid var(--oc-border)', cursor: 'pointer'
                    }}>
                      <InlineStack gap="200" align="start">
                        {s.pinned && <Text as="span" variant="bodySm">📌</Text>}
                        <Text as="p" variant="bodyMd">{s.domain}</Text>
                        {s.tags && JSON.parse(s.tags).map((tag: string) => (
                          <Badge key={tag} tone="info">{tag}</Badge>
                        ))}
                      </InlineStack>
                      <InlineStack gap="200">
                        {s.sslEnabled && <Text as="span" variant="bodySm" tone="subdued">🔒</Text>}
                        <Badge tone={DEPLOY_TONE[s.status] ?? 'info'}>{s.status}</Badge>
                      </InlineStack>
                    </div>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  )
}
