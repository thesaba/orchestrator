import {
  Page, Card, ResourceList, ResourceItem, Text, Badge,
  BlockStack, InlineStack, Button, Banner, Modal, TextField, Select
} from '@shopify/polaris'
import { useEffect, useState, useCallback, useMemo } from 'react'
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
  const [search,       setSearch]      = useState('')
  const [sortBy,       setSortBy]      = useState('recent')
  // Clone modal
  const [cloneSource,  setCloneSource] = useState<Site | null>(null)
  const [cloneName,    setCloneName]   = useState('')
  const [cloneDomain,  setCloneDomain] = useState('')
  const [cloning,      setCloning]     = useState(false)
  const [selectedItems, setSelectedItems] = useState<string[]>([])
  const [bulkBusy,     setBulkBusy]    = useState(false)
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

  // ── Bulk actions ───────────────────────────────────────────────────────────
  // All bulk operations reuse existing per-site endpoints (deploy queues if one
  // is already running; artisan is allowlisted), so nothing new touches the
  // hosted sites' behaviour — it's the same actions, just fanned out.
  const selectedSites = useMemo(
    () => sites.filter((s) => selectedItems.includes(String(s.id))),
    [sites, selectedItems]
  )

  const bulkDeploy = useCallback(async () => {
    setBulkBusy(true)
    let started = 0, queued = 0, skipped = 0
    await Promise.all(selectedSites.map(async (s) => {
      try {
        const r = await api.deploy.trigger(s.id)
        if ('queued' in r && r.queued) queued++; else started++
      } catch { skipped++ }
    }))
    showToast(
      `Deploy — ${started} started${queued ? `, ${queued} queued` : ''}${skipped ? `, ${skipped} skipped (no repo / inactive)` : ''}`,
      { error: skipped > 0 && started === 0 && queued === 0 }
    )
    setSelectedItems([]); setBulkBusy(false); load()
  }, [selectedSites, showToast, load])

  const bulkClearCache = useCallback(async () => {
    setBulkBusy(true)
    let ok = 0, failed = 0
    await Promise.all(selectedSites.map(async (s) => {
      try { await api.artisan.run(s.id, 'optimize:clear'); ok++ } catch { failed++ }
    }))
    showToast(`Clear cache — ${ok} ok${failed ? `, ${failed} skipped/busy` : ''}`, { error: failed > 0 && ok === 0 })
    setSelectedItems([]); setBulkBusy(false)
  }, [selectedSites, showToast])

  const bulkPin = useCallback(async (pinned: boolean) => {
    setBulkBusy(true)
    await Promise.all(selectedSites.map((s) => api.sites.update(s.id, { pinned }).catch(() => {})))
    showToast(pinned ? 'Pinned' : 'Unpinned')
    setSelectedItems([]); setBulkBusy(false); load()
  }, [selectedSites, showToast, load])

  const displayed = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = sites.filter((s) => {
      if (filterTag && !parseTags(s.tags).includes(filterTag)) return false
      if (q && !s.name.toLowerCase().includes(q) && !s.domain.toLowerCase().includes(q)) return false
      return true
    })
    // Pinned sites always float to the top; the chosen sort orders the rest.
    return [...list].sort((a, b) => {
      if (a.pinned !== b.pinned) return Number(b.pinned) - Number(a.pinned)
      switch (sortBy) {
        case 'name':   return a.name.localeCompare(b.name)
        case 'domain': return a.domain.localeCompare(b.domain)
        case 'status': return a.status.localeCompare(b.status)
        case 'ssl':    return (a.sslDaysLeft ?? Infinity) - (b.sslDaysLeft ?? Infinity)
        default:       return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      }
    })
  }, [sites, filterTag, search, sortBy])

  return (
    <Page
      title="Sites"
      primaryAction={
        <Button variant="primary" onClick={() => navigate('/sites/new')}>Add site</Button>
      }
    >
      {/* Search + sort */}
      {sites.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <InlineStack gap="300" align="start" blockAlign="center" wrap={false}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <TextField
                label="Search sites"
                labelHidden
                value={search}
                onChange={setSearch}
                placeholder="Search by name or domain…"
                clearButton
                onClearButtonClick={() => setSearch('')}
                autoComplete="off"
              />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select
                label="Sort by"
                labelHidden
                value={sortBy}
                onChange={setSortBy}
                options={[
                  { label: 'Most recent', value: 'recent' },
                  { label: 'Name (A–Z)', value: 'name' },
                  { label: 'Domain (A–Z)', value: 'domain' },
                  { label: 'Status', value: 'status' },
                  { label: 'SSL expiry', value: 'ssl' }
                ]}
              />
            </div>
          </InlineStack>
        </div>
      )}

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
          selectable
          selectedItems={selectedItems}
          onSelectionChange={(sel) => setSelectedItems(sel === 'All' ? displayed.map((s) => String(s.id)) : sel)}
          promotedBulkActions={[
            { content: 'Deploy', onAction: bulkDeploy, disabled: bulkBusy },
            { content: 'Clear cache', onAction: bulkClearCache, disabled: bulkBusy }
          ]}
          bulkActions={[
            { content: 'Pin', onAction: () => bulkPin(true), disabled: bulkBusy },
            { content: 'Unpin', onAction: () => bulkPin(false), disabled: bulkBusy }
          ]}
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
