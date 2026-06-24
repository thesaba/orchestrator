import {
  Page,
  Card,
  ResourceList,
  ResourceItem,
  Text,
  Badge,
  BlockStack,
  EmptyState,
  Button,
  Banner
} from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Site } from '../api/client'

const STATUS_TONE: Record<string, 'success' | 'warning' | 'critical' | 'info'> = {
  success: 'success',
  running: 'info',
  pending: 'warning',
  failed: 'critical'
}

export function SitesPage() {
  const [sites, setSites] = useState<Site[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    api.sites
      .list()
      .then(setSites)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [])

  const lastDeployBadge = (site: Site) => {
    const d = site.deployments[0]
    if (!d) return null
    return <Badge tone={STATUS_TONE[d.status] ?? 'info'}>{d.status}</Badge>
  }

  return (
    <Page
      title="Sites"
      primaryAction={
        <Button variant="primary" onClick={() => navigate('/sites/new')}>
          Add site
        </Button>
      }
    >
      <Card padding="0">
        {error && (
          <div style={{ padding: '16px' }}>
            <Banner tone="critical">{error}</Banner>
          </div>
        )}
        <ResourceList
          loading={loading}
          items={sites}
          emptyState={
            <EmptyState
              heading="No sites yet"
              action={{
                content: 'Add your first site',
                onAction: () => navigate('/sites/new')
              }}
              image=""
            >
              <p>Provision a new Laravel site to get started.</p>
            </EmptyState>
          }
          renderItem={(site) => (
            <ResourceItem
              id={String(site.id)}
              onClick={() => navigate(`/sites/${site.id}`)}
              accessibilityLabel={`View ${site.domain}`}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <BlockStack gap="100">
                  <Text as="h3" variant="bodyMd" fontWeight="bold">
                    {site.domain}
                  </Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    PHP {site.phpVersion} · {site.sslEnabled ? 'SSL' : 'No SSL'}
                  </Text>
                </BlockStack>
                {lastDeployBadge(site)}
              </div>
            </ResourceItem>
          )}
        />
      </Card>
    </Page>
  )
}
