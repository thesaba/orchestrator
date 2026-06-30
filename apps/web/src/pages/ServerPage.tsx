import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Modal,
  TextField,
  Banner,
  SkeletonBodyText,
  Divider,
  Select,
  Checkbox,
  DataTable,
  Spinner,
  EmptyState
} from '@shopify/polaris'
import { useEffect, useState, useCallback } from 'react'
import { api, ServerStatus, DODroplet, DOSize, DOAction, DOSnapshot, DOBackup, DOFirewall } from '../api/client'
import { useToast } from '../context/toast'
import { useAuth } from '../context/AuthContext'

function fmtBytes(mb: number): string {
  if (mb >= 1024) return (mb / 1024).toFixed(mb % 1024 === 0 ? 0 : 1) + ' GB'
  return mb + ' MB'
}

function statusTone(status: string): 'success' | 'critical' | 'info' | 'warning' {
  if (status === 'active') return 'success'
  if (status === 'off') return 'critical'
  if (status === 'new') return 'info'
  return 'warning'
}

const POWER_ACTIONS: { type: string; label: string; tone?: 'critical'; confirm?: string }[] = [
  { type: 'reboot', label: 'Reboot (soft)' },
  { type: 'power_cycle', label: 'Power Cycle (hard reset)', tone: 'critical', confirm: 'Power cycle forcibly restarts the droplet, like pulling the power cord and plugging it back in. Unsaved data in memory will be lost. Continue?' },
  { type: 'power_off', label: 'Power Off', tone: 'critical', confirm: 'This will power off the droplet immediately. All sites will go down until you power it back on. Continue?' },
  { type: 'power_on', label: 'Power On' },
  { type: 'shutdown', label: 'Shutdown (graceful)', tone: 'critical', confirm: 'This sends a graceful ACPI shutdown signal. The droplet will power off once the OS finishes shutting down. Continue?' }
]

export function ServerPage() {
  const showToast = useToast()
  const { isAdmin } = useAuth()

  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<ServerStatus | null>(null)
  const [allDroplets, setAllDroplets] = useState<DODroplet[]>([])
  const [error, setError] = useState<string | null>(null)

  const [actionBusy, setActionBusy] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: string; message: string } | null>(null)

  const [sizes, setSizes] = useState<DOSize[]>([])
  const [resizeTarget, setResizeTarget] = useState('')
  const [resizeDisk, setResizeDisk] = useState(false)
  const [resizeBusy, setResizeBusy] = useState(false)
  const [resizeModalOpen, setResizeModalOpen] = useState(false)

  const [renameModalOpen, setRenameModalOpen] = useState(false)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)

  const [snapshots, setSnapshots] = useState<DOSnapshot[]>([])
  const [snapshotName, setSnapshotName] = useState('')
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false)
  const [snapshotBusy, setSnapshotBusy] = useState(false)

  const [backups, setBackups] = useState<DOBackup[]>([])
  const [firewalls, setFirewalls] = useState<DOFirewall[]>([])
  const [recentActions, setRecentActions] = useState<DOAction[]>([])

  const droplet = status?.droplet ?? null

  const loadAll = useCallback(async () => {
    try {
      const s = await api.server.status()
      setStatus(s)
      setError(null)
      if (s.configured && s.droplet) {
        const [snaps, bks, fws, acts] = await Promise.all([
          api.server.snapshots().catch(() => []),
          api.server.backups().catch(() => []),
          api.server.firewalls().catch(() => []),
          api.server.actions().catch(() => [])
        ])
        setSnapshots(snaps)
        setBackups(bks)
        setFirewalls(fws)
        setRecentActions(acts)
        setResizeTarget(s.droplet.size_slug)
      }
      if (s.configured && s.needsDropletSelection) {
        const droplets = await api.server.listDroplets().catch(() => [])
        setAllDroplets(droplets)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load server status')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  useEffect(() => {
    if (status?.configured && status.droplet) {
      api.server.sizes().then(setSizes).catch(() => {})
    }
  }, [status?.configured, status?.droplet])

  // Poll while any recent action is in-progress (resize/snapshot take a while)
  useEffect(() => {
    const hasPending = recentActions.some((a) => a.status === 'in-progress')
    if (!hasPending) return
    const t = setInterval(() => loadAll(), 5000)
    return () => clearInterval(t)
  }, [recentActions, loadAll])

  const runAction = async (type: string) => {
    setActionBusy(type)
    try {
      await api.server.action(type)
      showToast(`${type.replace(/_/g, ' ')} started`)
      await loadAll()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Action failed', { error: true })
    } finally {
      setActionBusy(null)
      setConfirmAction(null)
    }
  }

  const handlePowerClick = (action: { type: string; confirm?: string }) => {
    if (action.confirm) setConfirmAction({ type: action.type, message: action.confirm })
    else runAction(action.type)
  }

  const handleSelectDroplet = async (id: number) => {
    setLoading(true)
    try {
      await api.settings.update({ do_droplet_id: String(id) })
      showToast('Droplet selected')
      await loadAll()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Failed', { error: true })
    } finally {
      setLoading(false)
    }
  }

  const handleResize = async () => {
    setResizeBusy(true)
    try {
      await api.server.resize(resizeTarget, resizeDisk)
      showToast('Resize started — this can take a few minutes')
      setResizeModalOpen(false)
      await loadAll()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Resize failed', { error: true })
    } finally {
      setResizeBusy(false)
    }
  }

  const handleRename = async () => {
    setRenameBusy(true)
    try {
      await api.server.rename(renameValue)
      showToast('Rename started')
      setRenameModalOpen(false)
      await loadAll()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Rename failed', { error: true })
    } finally {
      setRenameBusy(false)
    }
  }

  const handleCreateSnapshot = async () => {
    setSnapshotBusy(true)
    try {
      await api.server.createSnapshot(snapshotName || `snapshot-${new Date().toISOString().slice(0, 10)}`)
      showToast('Snapshot started — this can take several minutes')
      setSnapshotModalOpen(false)
      setSnapshotName('')
      await loadAll()
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Snapshot failed', { error: true })
    } finally {
      setSnapshotBusy(false)
    }
  }

  const handleDeleteSnapshot = async (id: string) => {
    if (!window.confirm('Permanently delete this snapshot?')) return
    try {
      await api.server.deleteSnapshot(id)
      showToast('Snapshot deleted')
      setSnapshots((s) => s.filter((x) => x.id !== id))
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Delete failed', { error: true })
    }
  }

  if (!isAdmin) {
    return (
      <Page title="Server">
        <Banner tone="warning">Only admins can access server controls.</Banner>
      </Page>
    )
  }

  if (loading) {
    return (
      <Page title="Server">
        <Card><SkeletonBodyText lines={8} /></Card>
      </Page>
    )
  }

  // ── Not configured at all ──────────────────────────────────────────────
  if (!status?.configured) {
    return (
      <Page title="Server">
        <Layout>
          <Layout.Section>
            <Card>
              <EmptyState
                heading="Connect your DigitalOcean account"
                action={{ content: 'Go to Settings', url: '/settings' }}
                image=""
              >
                <p>
                  Add a DigitalOcean Personal Access Token in Settings to control this droplet
                  (reboot, resize, snapshots, backups, firewalls) directly from this panel.
                </p>
              </EmptyState>
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    )
  }

  // ── Token set, but no droplet chosen yet ──────────────────────────────
  if (status.needsDropletSelection) {
    return (
      <Page title="Server">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Select your droplet</Text>
                <Text as="p" tone="subdued" variant="bodySm">
                  Your DigitalOcean token is connected. Pick which droplet this panel should control.
                </Text>
                {allDroplets.length === 0 ? (
                  <Banner tone="warning">No droplets found on this account, or the token lacks read access.</Banner>
                ) : (
                  <BlockStack gap="200">
                    {allDroplets.map((d) => (
                      <InlineStack key={d.id} align="space-between" blockAlign="center">
                        <BlockStack gap="050">
                          <Text as="p" fontWeight="semibold">{d.name}</Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {d.region?.slug} · {d.size_slug} · {d.networks?.v4?.[0]?.ip_address ?? 'no IP'}
                          </Text>
                        </BlockStack>
                        <Button onClick={() => handleSelectDroplet(d.id)}>Use this droplet</Button>
                      </InlineStack>
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

  if (error || !droplet) {
    return (
      <Page title="Server">
        <Banner tone="critical">{error ?? 'Could not load droplet.'}</Banner>
      </Page>
    )
  }

  const ip4 = droplet.networks?.v4?.find((n) => n.type === 'public')?.ip_address ?? droplet.networks?.v4?.[0]?.ip_address
  const ip6 = droplet.networks?.v6?.[0]?.ip_address

  return (
    <Page
      title="Server"
      subtitle={droplet.name}
      titleMetadata={<Badge tone={statusTone(droplet.status)}>{droplet.status}</Badge>}
      secondaryActions={[
        { content: 'Rename', onAction: () => { setRenameValue(droplet.name); setRenameModalOpen(true) } },
        { content: 'Refresh', onAction: loadAll }
      ]}
    >
      <Layout>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Overview</Text>
              <InlineStack gap="600" wrap>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Region</Text><Text as="p" fontWeight="semibold">{droplet.region?.name ?? droplet.region?.slug}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Size</Text><Text as="p" fontWeight="semibold">{droplet.size_slug} (${droplet.size?.price_monthly}/mo)</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">vCPUs</Text><Text as="p" fontWeight="semibold">{droplet.vcpus}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Memory</Text><Text as="p" fontWeight="semibold">{fmtBytes(droplet.memory)}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Disk</Text><Text as="p" fontWeight="semibold">{droplet.disk} GB</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Image</Text><Text as="p" fontWeight="semibold">{droplet.image?.distribution} {droplet.image?.name}</Text></BlockStack>
              </InlineStack>
              <Divider />
              <InlineStack gap="600" wrap>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Public IPv4</Text><Text as="p" fontWeight="semibold">{ip4 ?? '—'}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Public IPv6</Text><Text as="p" fontWeight="semibold">{ip6 ?? 'Not enabled'}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Created</Text><Text as="p" fontWeight="semibold">{new Date(droplet.created_at).toLocaleDateString()}</Text></BlockStack>
                <BlockStack gap="050"><Text as="p" variant="bodySm" tone="subdued">Backups</Text><Text as="p" fontWeight="semibold">{droplet.features?.includes('backups') ? 'Enabled' : 'Disabled'}</Text></BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Power controls ───────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Power</Text>
              <BlockStack gap="200">
                {POWER_ACTIONS.map((a) => (
                  <Button
                    key={a.type}
                    tone={a.tone}
                    loading={actionBusy === a.type}
                    onClick={() => handlePowerClick(a)}
                  >
                    {a.label}
                  </Button>
                ))}
              </BlockStack>
              <Divider />
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm">Reset root password by email</Text>
                <Button loading={actionBusy === 'password_reset'} onClick={() => runAction('password_reset')}>Send</Button>
              </InlineStack>
              {!ip6 && (
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="p" variant="bodySm">Enable IPv6</Text>
                  <Button loading={actionBusy === 'enable_ipv6'} onClick={() => runAction('enable_ipv6')}>Enable</Button>
                </InlineStack>
              )}
              <InlineStack align="space-between" blockAlign="center">
                <Text as="p" variant="bodySm">Automated backups</Text>
                {droplet.features?.includes('backups') ? (
                  <Button tone="critical" loading={actionBusy === 'disable_backups'} onClick={() => runAction('disable_backups')}>Disable</Button>
                ) : (
                  <Button loading={actionBusy === 'enable_backups'} onClick={() => runAction('enable_backups')}>Enable</Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Resize ────────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Resize</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Vertically scale CPU/RAM. Most size changes require the droplet to be powered off first
                — DigitalOcean will report an error here if it isn't.
              </Text>
              <Text as="p" variant="bodySm">Current: <b>{droplet.size_slug}</b> · {droplet.vcpus} vCPU · {fmtBytes(droplet.memory)} · {droplet.disk}GB disk</Text>
              <Button onClick={() => setResizeModalOpen(true)}>Change size…</Button>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Snapshots ─────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">Snapshots</Text>
                <Button onClick={() => setSnapshotModalOpen(true)}>Create snapshot</Button>
              </InlineStack>
              {snapshots.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">No snapshots yet.</Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'text']}
                  headings={['Name', 'Created', 'Size', '']}
                  rows={snapshots.map((s) => [
                    s.name,
                    new Date(s.created_at).toLocaleString(),
                    `${s.size_gigabytes} GB`,
                    <Button key={s.id} tone="critical" variant="plain" onClick={() => handleDeleteSnapshot(s.id)}>Delete</Button>
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Backups ───────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Backups</Text>
              {backups.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">
                  {droplet.features?.includes('backups')
                    ? 'Enabled — first automated backup hasn\'t run yet.'
                    : 'Not enabled. Toggle it on in the Power card.'}
                </Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Name', 'Created', 'Size']}
                  rows={backups.map((b) => [b.name, new Date(b.created_at).toLocaleString(), `${b.size_gigabytes} GB`])}
                />
              )}
              {droplet.next_backup_window && (
                <Text as="p" variant="bodySm" tone="subdued">
                  Next window: {new Date(droplet.next_backup_window.start).toLocaleString()}
                </Text>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Firewalls ─────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Firewalls</Text>
              {firewalls.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">No firewall is attached to this droplet.</Text>
              ) : (
                firewalls.map((fw) => (
                  <BlockStack key={fw.id} gap="200">
                    <InlineStack align="space-between">
                      <Text as="p" fontWeight="semibold">{fw.name}</Text>
                      <Badge tone={fw.status === 'succeeded' ? 'success' : 'warning'}>{fw.status}</Badge>
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Inbound: {fw.inbound_rules.map((r) => `${r.protocol}/${r.ports}`).join(', ') || 'none'}
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      Outbound: {fw.outbound_rules.map((r) => `${r.protocol}/${r.ports}`).join(', ') || 'none'}
                    </Text>
                  </BlockStack>
                ))
              )}
              <Text as="p" variant="bodySm" tone="subdued">
                Rule editing for firewalls is intentionally not exposed here yet — misconfigured rules can lock you
                out over SSH. Manage detailed rules in the DigitalOcean console, or ask to add it here if needed.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Recent actions ────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Recent Actions</Text>
              {recentActions.length === 0 ? (
                <Text as="p" tone="subdued" variant="bodySm">No actions yet.</Text>
              ) : (
                <DataTable
                  columnContentTypes={['text', 'text', 'text']}
                  headings={['Action', 'Status', 'Started']}
                  rows={recentActions.slice(0, 10).map((a) => [
                    a.type.replace(/_/g, ' '),
                    <InlineStack key={a.id} gap="100" blockAlign="center">
                      {a.status === 'in-progress' && <Spinner size="small" />}
                      <Badge tone={a.status === 'completed' ? 'success' : a.status === 'errored' ? 'critical' : 'info'}>
                        {a.status}
                      </Badge>
                    </InlineStack>,
                    new Date(a.started_at).toLocaleString()
                  ])}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>

      {/* ── Confirm dangerous power action ─────────────────────────────── */}
      <Modal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        title="Are you sure?"
        primaryAction={{ content: 'Confirm', destructive: true, loading: !!actionBusy, onAction: () => confirmAction && runAction(confirmAction.type) }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirmAction(null) }]}
      >
        <Modal.Section><Text as="p">{confirmAction?.message}</Text></Modal.Section>
      </Modal>

      {/* ── Resize modal ──────────────────────────────────────────────── */}
      <Modal
        open={resizeModalOpen}
        onClose={() => setResizeModalOpen(false)}
        title="Resize droplet"
        primaryAction={{ content: 'Resize', loading: resizeBusy, onAction: handleResize }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setResizeModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Select
              label="New size"
              options={sizes.map((s) => ({
                label: `${s.slug} — ${s.vcpus} vCPU, ${fmtBytes(s.memory)}, ${s.disk}GB disk ($${s.price_monthly}/mo)`,
                value: s.slug
              }))}
              value={resizeTarget}
              onChange={setResizeTarget}
            />
            <Checkbox
              label="Also increase disk size (irreversible — cannot be undone later)"
              checked={resizeDisk}
              onChange={setResizeDisk}
            />
            <Banner tone="warning">
              Resizing usually requires the droplet to be powered off. If it's still on, power it off first
              from the Power card, then resize, then power it back on.
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Rename modal ──────────────────────────────────────────────── */}
      <Modal
        open={renameModalOpen}
        onClose={() => setRenameModalOpen(false)}
        title="Rename droplet"
        primaryAction={{ content: 'Rename', loading: renameBusy, onAction: handleRename }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setRenameModalOpen(false) }]}
      >
        <Modal.Section>
          <TextField label="Name" value={renameValue} onChange={setRenameValue} autoComplete="off" />
        </Modal.Section>
      </Modal>

      {/* ── Snapshot modal ────────────────────────────────────────────── */}
      <Modal
        open={snapshotModalOpen}
        onClose={() => setSnapshotModalOpen(false)}
        title="Create snapshot"
        primaryAction={{ content: 'Create', loading: snapshotBusy, onAction: handleCreateSnapshot }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setSnapshotModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField
              label="Snapshot name"
              value={snapshotName}
              onChange={setSnapshotName}
              autoComplete="off"
              placeholder={`snapshot-${new Date().toISOString().slice(0, 10)}`}
            />
            <Banner tone="info">
              For a fully consistent disk image, DigitalOcean recommends powering off the droplet before
              snapshotting — but live snapshots work too and are usually fine for routine backups.
            </Banner>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
