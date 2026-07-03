import {
  Page, Card, ResourceList, ResourceItem, Text, Badge,
  BlockStack, InlineStack, Button, Banner, Modal, TextField
} from '@shopify/polaris'
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, Site } from '../api/client'
import { useToast } from '../context/toast'
import { EmptyState } from '../components/EmptyState'
import { ResponseSparkline } from '../components/ResponseSparkline'
import { HealthScoreBadge } from '../components/HealthScoreBadge'

const STATUS_TONE: Record<string, 'success' | 'warning' | 'critical' | 'info'> = {
  success: 'success', running: 'info', pending: 'warning', failed: 'critical'
}

function parseTags(tags: string | undefined): string[] {
  try { return JSON.parse(tags ?? '[]') } catch { return [] }
}

export function SitesPage() {
  const [sites,        setSites]       = useState<Site[]>([])
  const [loading,      setLoading]     = useState(true)
  const [error,        setError]       = useState('')
  const [filterTag,    setFilterTag]   = useState('')
  const [allTags,      setAllTags]     = useState<string[]>([])
  // Clone modal
  const [cloneSource,  setCloneSource] = useState<Site | null>(null)
  const [cloneName,    setCloneName]   = useState('')
  const [cloneDomain,  setCloneDomain] = useState('')
  const [cloning,      setCloning]     = useState(false)
  const navigate = useNavigate()
  const showToast = useToast()

  const load = useCallback(() => {
    api.sites.list()
      .then((s) => { setSites(s) })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
    api.sites.tags().then((r) => setAllTags(r.tags)).catch(() => {})
  }, [])

  useEffect(() => { load() }, [load])

  const togglePin = async (site: Site, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await api.sites.update(site.id, { pinned: !site.pinned })
      setSites((prev) => prev.map((s) =>
        s.id === site.id ? { ...s, pinned: !s.pinned } : s
      ).sort((a, b) => Number(b.pinned) - Number(a.pinned)))
      showToast(site.pinned ? 'Unpinned' : 'Pinned')
    } catch { showToast('Failed to pin site', { error: true }) }
  }

  const openClone = (site: Site, e: React.MouseEvent) => {
    e.stopPropagation()
    setCloneSource(site)
    setCloneName(site.name + ' (copy)')
    setCloneDomain('')
  }

  const doClone = async () => {
    if (!cloneSource || !cloneName || !cloneDomain) return
    setCloning(true)
    try {
      const newSite = await api.sites.clone(cloneSource.id, { name: cloneName, domain: cloneDomain })
      showToast(`Site cloned as ${newSite.domain}`)
      setCloneSource(null)
      load()
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Clone failed', { error: true })
    } finally { setCloning(false) }
  }

  const displayed = filterTag
    ? sites.filter((s) => parseTags(s.tags).includes(filterTag))
    : sites

  return (
    <Page
      title="Sites"
      primaryAction={
        <Button variant="primary" onClick={() => navigate('/sites/new')}>Add site</Button>
      }
    >
      {/* Tag filter chips */}
      {allTags.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            className={`oc-tag-chip${filterTag === '' ? ' active' : ''}`}
            onClick={() => setFilterTag('')}
          >All</button>
          {allTags.map((t) => (
            <button
              key={t}
              className={`oc-tag-chip${filterTag === t ? ' selected' : ''}`}
              onClick={() => setFilterTag(filterTag === t ? '' : t)}
            >{t}</button>
          ))}
        </div>
      )}

      {!loading && sites.length === 0 && (
        <EmptyState
          icon="🌐"
          title="No sites yet"
          body="Add your first Laravel site to start deploying. The panel will provision Nginx, PHP-FPM, and a MySQL database automatically."
          action={{ label: 'Add first site', onAction: () => navigate('/sites/new') }}
        />
      )}

      <Card padding="0">
        {error && <div style={{ padding: 16 }}><Banner tone="critical">{error}</Banner></div>}
        <ResourceList
          loading={loading}
          items={displayed}
          renderItem={(site) => {
            const tags = parseTags(site.tags)
            const lastDeploy = site.deployments[0]
            return (
              <ResourceItem
                id={String(site.id)}
                onClick={() => navigate(`/sites/${site.id}`)}
                accessibilityLabel={`View ${site.domain}`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <BlockStack gap="100">
                    <InlineStack gap="200" align="start">
                      <Text as="h3" variant="bodyMd" fontWeight="bold">
                        {site.pinned ? '📌 ' : ''}{site.domain}
                      </Text>
                      {tags.map((t) => <Badge key={t} tone="info">{t}</Badge>)}
                      {typeof site.sslDaysLeft === 'number' && site.sslDaysLeft <= 14 && (
                        <Badge tone={site.sslDaysLeft <= 3 ? 'critical' : 'warning'}>
                          {site.sslDaysLeft <= 0 ? 'SSL expired' : `SSL expires in ${site.sslDaysLeft}d`}
                        </Badge>
                      )}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      PHP {site.phpVersion} · {site.sslEnabled ? '🔒 SSL' : 'No SSL'}
                      {site.maintenanceMode ? ' · 🔧 Maintenance' : ''}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200" align="end">
                    <ResponseSparkline siteId={site.id} />
                    <HealthScoreBadge siteId={site.id} />
                    {site.disabled && <Badge tone="critical">Disabled</Badge>}
                    {lastDeploy && (
                      <Badge tone={STATUS_TONE[lastDeploy.status] ?? 'info'}>{lastDeploy.status}</Badge>
                    )}
                    <button
                      title={site.pinned ? 'Unpin' : 'Pin to top'}
                      onClick={(e) => togglePin(site, e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontSize: 16 }}
                    >
                      {site.pinned ? '⭐' : '☆'}
                    </button>
                    <button
                      title="Clone site"
                      onClick={(e) => openClone(site, e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, fontSize: 16 }}
                    >
                      📋
                    </button>
                  </InlineStack>
                </div>
              </ResourceItem>
            )
          }}
        />
      </Card>

      {/* Clone modal */}
      <Modal
        open={!!cloneSource}
        onClose={() => setCloneSource(null)}
        title={`Clone "${cloneSource?.domain}"`}
        primaryAction={{ content: 'Clone', onAction: doClone, loading: cloning, disabled: !cloneName || !cloneDomain }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setCloneSource(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <TextField label="New site name" value={cloneName} onChange={setCloneName} autoComplete="off" />
            <TextField label="New domain" value={cloneDomain} onChange={setCloneDomain} autoComplete="off" placeholder="example.com" />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
