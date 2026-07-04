import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Page, Card, BlockStack, InlineStack, Text, Badge, Button, TextField, Select,
  Modal, Spinner, Banner
} from '@shopify/polaris'
import { useNavigate } from 'react-router-dom'
import { api, LogErrorItem, LogErrorDetail, Site } from '../api/client'
import { EmptyState } from '../components/EmptyState'

function levelTone(level: string): 'critical' | 'warning' | 'attention' {
  if (level === 'warning') return 'warning'
  if (level === 'alert') return 'attention'
  return 'critical'
}

export function ErrorsPage() {
  const [errors, setErrors]     = useState<LogErrorItem[]>([])
  const [unresolved, setUnresolved] = useState(0)
  const [sites, setSites]       = useState<Pick<Site, 'id' | 'domain'>[]>([])
  const [loading, setLoading]   = useState(true)
  const [search, setSearch]     = useState('')
  const [siteId, setSiteId]     = useState('')
  const [status, setStatus]     = useState<'0' | '1' | '' | 'ig'>('0')
  const [detail, setDetail]     = useState<LogErrorDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const navigate = useNavigate()

  const load = useCallback(() => {
    setLoading(true)
    api.logErrors.list({
      search: search.trim() || undefined,
      siteId: siteId ? Number(siteId) : undefined,
      resolved: status === '0' || status === '1' ? status : undefined,
      ignored: status === 'ig' ? '1' : undefined
    })
      .then((r) => { setErrors(r.errors); setUnresolved(r.unresolved) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [search, siteId, status])

  useEffect(() => { load() }, [load])
  useEffect(() => { api.sites.list().then((s) => setSites(s.map((x) => ({ id: x.id, domain: x.domain })))).catch(() => {}) }, [])

  const openDetail = async (id: number) => {
    setDetailLoading(true); setDetail(null)
    try { setDetail(await api.logErrors.get(id)) } catch { /* ignore */ }
    finally { setDetailLoading(false) }
  }

  const setResolved = async (id: number, resolved: boolean) => {
    await api.logErrors.setResolved(id, resolved).catch(() => {})
    setDetail((d) => (d && d.id === id ? { ...d, resolved } : d))
    load()
  }

  const setIgnored = async (id: number, ignored: boolean) => {
    await api.logErrors.setIgnored(id, ignored).catch(() => {})
    setDetail((d) => (d && d.id === id ? { ...d, ignored } : d))
    load()
  }

  const remove = async (id: number) => {
    await api.logErrors.remove(id).catch(() => {})
    setDetail(null)
    load()
  }

  const siteOptions = useMemo(() => [
    { label: 'All sites', value: '' },
    ...sites.map((s) => ({ label: s.domain, value: String(s.id) }))
  ], [sites])

  return (
    <Page
      title="Errors"
      subtitle="Grouped application errors mined from your sites' Laravel logs"
      titleMetadata={unresolved > 0 ? <Badge tone="critical">{`${unresolved} unresolved`}</Badge> : undefined}
    >
      <BlockStack gap="400">
        <InlineStack gap="300" blockAlign="end" wrap>
          <div style={{ flex: 1, minWidth: 200 }}>
            <TextField label="Search" labelHidden value={search} onChange={setSearch} placeholder="Search message or exception…" autoComplete="off" clearButton onClearButtonClick={() => setSearch('')} />
          </div>
          <div style={{ width: 200 }}>
            <Select label="Site" labelHidden options={siteOptions} value={siteId} onChange={setSiteId} />
          </div>
          <div style={{ width: 160 }}>
            <Select
              label="Status" labelHidden
              options={[{ label: 'Unresolved', value: '0' }, { label: 'Resolved', value: '1' }, { label: 'All', value: '' }, { label: 'Ignored', value: 'ig' }]}
              value={status}
              onChange={(v) => setStatus(v as '0' | '1' | '' | 'ig')}
            />
          </div>
        </InlineStack>

        {!loading && errors.length === 0 ? (
          <EmptyState
            icon="🐞"
            title="No errors 🎉"
            body="Nothing matching the current filter. Errors are collected from each active site's Laravel log every minute and grouped by type."
          />
        ) : (
          <Card padding="0">
            {loading ? (
              <div style={{ padding: 24 }}><Spinner size="small" /></div>
            ) : errors.map((e, i) => (
              <div
                key={e.id}
                onClick={() => openDetail(e.id)}
                style={{ padding: '12px 16px', cursor: 'pointer', borderTop: i > 0 ? '1px solid var(--oc-border, #e1e3e5)' : undefined }}
              >
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center" wrap>
                      <Badge tone={levelTone(e.level)}>{e.level}</Badge>
                      {e.exceptionClass && <Text as="span" fontWeight="semibold">{e.exceptionClass}</Text>}
                      {e.resolved && <Badge tone="success">resolved</Badge>}
                      {e.ignored && <Badge>ignored</Badge>}
                    </InlineStack>
                    <Text as="span" variant="bodySm" truncate>{e.message}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">
                      {e.site.domain} · last seen {new Date(e.lastSeenAt).toLocaleString()}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200" blockAlign="center">
                    <Badge tone={e.count > 1 ? 'attention' : undefined}>{`×${e.count}`}</Badge>
                    <div onClick={(ev) => ev.stopPropagation()}>
                      <Button size="micro" variant="tertiary" onClick={() => setIgnored(e.id, !e.ignored)}>
                        {e.ignored ? 'Un-ignore' : 'Ignore'}
                      </Button>
                    </div>
                  </InlineStack>
                </InlineStack>
              </div>
            ))}
          </Card>
        )}
      </BlockStack>

      {/* Detail modal */}
      <Modal
        open={!!detail || detailLoading}
        onClose={() => setDetail(null)}
        title={detail?.exceptionClass ?? 'Error detail'}
        primaryAction={detail ? { content: detail.resolved ? 'Reopen' : 'Mark resolved', onAction: () => setResolved(detail.id, !detail.resolved) } : undefined}
        secondaryActions={detail ? [
          { content: detail.ignored ? 'Un-ignore' : 'Ignore similar', onAction: () => setIgnored(detail.id, !detail.ignored) },
          { content: 'Open site', onAction: () => navigate(`/sites/${detail.siteId}?tab=logs`) },
          { content: 'Delete', destructive: true, onAction: () => remove(detail.id) }
        ] : []}
      >
        <Modal.Section>
          {detailLoading || !detail ? (
            <InlineStack align="center"><Spinner size="small" /></InlineStack>
          ) : (
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" wrap>
                <Badge tone={levelTone(detail.level)}>{detail.level}</Badge>
                <Badge>{detail.site.domain}</Badge>
                <Badge tone={detail.count > 1 ? 'attention' : undefined}>{`×${detail.count}`}</Badge>
                {detail.resolved && <Badge tone="success">resolved</Badge>}
                {detail.ignored && <Badge>ignored</Badge>}
              </InlineStack>

              <Text as="p" fontWeight="medium">{detail.message}</Text>

              <InlineStack gap="400" wrap>
                <Text as="span" variant="bodySm" tone="subdued">First seen: {new Date(detail.firstSeenAt).toLocaleString()}</Text>
                <Text as="span" variant="bodySm" tone="subdued">Last seen: {new Date(detail.lastSeenAt).toLocaleString()}</Text>
              </InlineStack>

              {detail.introducedBy && (
                <Banner tone="info">
                  Likely introduced around deploy of <b>{detail.introducedBy.branch}</b>
                  {detail.introducedBy.commit ? ` @ ${detail.introducedBy.commit}` : ''} on {new Date(detail.introducedBy.createdAt).toLocaleString()}.
                </Banner>
              )}

              {detail.sample && (
                <div className="oc-terminal" style={{ maxHeight: 260, fontSize: 12 }}>
                  {detail.sample}
                </div>
              )}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  )
}
