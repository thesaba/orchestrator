import { useCallback, useEffect, useState } from 'react'
import {
  Page, Card, BlockStack, InlineStack, Text, Badge, Button, TextField, Modal, Banner, Spinner
} from '@shopify/polaris'
import { api, ServerInfo, ServerProbe } from '../api/client'
import { useToast } from '../context/toast'

function statusBadge(s: ServerInfo) {
  if (s.kind === 'local') return <Badge tone="info">local</Badge>
  if (s.status === 'online') return <Badge tone="success">online</Badge>
  if (s.status === 'offline') return <Badge tone="critical">offline</Badge>
  return <Badge>unknown</Badge>
}

/**
 * Managed servers (multi-server). Admin-only. The local server is always
 * present and read-mostly; remote servers are reached over SSH. Adding a server
 * changes nothing for existing sites — they stay on the local server.
 */
export function ServersPage() {
  const showToast = useToast()
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ServerInfo | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  // form
  const [name, setName] = useState('')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [sshUser, setSshUser] = useState('root')
  const [sshKey, setSshKey] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<ServerProbe | null>(null)
  const [testing, setTesting] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    api.servers.list().then((r) => setServers(r.servers)).catch(() => {}).finally(() => setLoading(false))
  }, [])
  useEffect(() => { load() }, [load])

  const openAdd = () => {
    setEditing(null); setName(''); setHost(''); setPort('22'); setSshUser('root'); setSshKey(''); setNotes('')
    setTestResult(null); setModalOpen(true)
  }
  const openEdit = (s: ServerInfo) => {
    setEditing(s); setName(s.name); setHost(s.host ?? ''); setPort(String(s.port)); setSshUser(s.sshUser)
    setSshKey(''); setNotes(s.notes ?? ''); setTestResult(null); setModalOpen(true)
  }

  const save = async () => {
    setSaving(true)
    try {
      if (editing) {
        await api.servers.update(editing.id, {
          name, notes,
          ...(editing.kind === 'remote' ? { host, port: Number(port), sshUser, ...(sshKey ? { sshKey } : {}) } : {})
        })
        showToast('Server updated')
      } else {
        await api.servers.create({ name, host, port: Number(port), sshUser, sshKey, notes: notes || undefined })
        showToast('Server added')
      }
      setModalOpen(false); load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed', { error: true })
    } finally { setSaving(false) }
  }

  const testForm = async () => {
    setTesting(true); setTestResult(null)
    try {
      const r = editing && !sshKey && editing.kind === 'remote'
        ? await api.servers.test(editing.id)
        : await api.servers.testConnection({ host, port: Number(port), sshUser, sshKey })
      setTestResult(r)
    } catch (e: unknown) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : 'Failed' })
    } finally { setTesting(false) }
  }

  const testSaved = async (s: ServerInfo) => {
    setBusyId(s.id)
    try {
      const r = await api.servers.test(s.id)
      showToast(r.ok ? `Online — ${r.info ?? ''}`.trim() : `Offline — ${r.error ?? ''}`.trim(), { error: !r.ok })
      load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Test failed', { error: true })
    } finally { setBusyId(null) }
  }

  const remove = async (s: ServerInfo) => {
    if (!confirm(`Delete server "${s.name}"? This is only allowed if it hosts no sites.`)) return
    setBusyId(s.id)
    try {
      await api.servers.remove(s.id); showToast('Server deleted'); load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Delete failed', { error: true })
    } finally { setBusyId(null) }
  }

  return (
    <Page
      title="Servers"
      subtitle="Manage the servers this panel operates. New sites can be placed on any server; existing sites stay on the local server."
      primaryAction={{ content: 'Add server', onAction: openAdd }}
    >
      <BlockStack gap="400">
        <Banner tone="info">
          Remote servers are reached over SSH using a key you provide. The panel host is the “local” server and is always present. Adding remote servers does not affect any existing site.
        </Banner>

        {loading ? (
          <Card><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="span">Loading…</Text></InlineStack></Card>
        ) : (
          <BlockStack gap="300">
            {servers.map((s) => (
              <Card key={s.id}>
                <InlineStack align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="h3" variant="headingMd">{s.name}</Text>
                      {statusBadge(s)}
                      {s.siteCount > 0 && <Badge>{`${s.siteCount} site${s.siteCount === 1 ? '' : 's'}`}</Badge>}
                    </InlineStack>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {s.kind === 'local'
                        ? 'This panel host — runs sites locally.'
                        : `${s.sshUser}@${s.host}:${s.port}${s.lastSeenAt ? ` · last seen ${new Date(s.lastSeenAt).toLocaleString()}` : ''}`}
                    </Text>
                  </BlockStack>
                  <InlineStack gap="200">
                    {s.kind === 'remote' && (
                      <Button onClick={() => testSaved(s)} loading={busyId === s.id} disabled={!s.hasKey}>Test</Button>
                    )}
                    <Button onClick={() => openEdit(s)}>Edit</Button>
                    {s.kind === 'remote' && (
                      <Button tone="critical" variant="plain" onClick={() => remove(s)} disabled={busyId === s.id || s.siteCount > 0}>Delete</Button>
                    )}
                  </InlineStack>
                </InlineStack>
              </Card>
            ))}
          </BlockStack>
        )}
      </BlockStack>

      <Modal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? `Edit ${editing.name}` : 'Add server'}
        primaryAction={{ content: editing ? 'Save' : 'Add server', onAction: save, loading: saving, disabled: !name || (!editing && (!host || !sshKey)) }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
            {(!editing || editing.kind === 'remote') && (
              <>
                <InlineStack gap="300" wrap>
                  <div style={{ flex: 2, minWidth: 200 }}>
                    <TextField label="Host (IP or hostname)" value={host} onChange={setHost} autoComplete="off" placeholder="167.71.55.145" />
                  </div>
                  <div style={{ width: 100 }}>
                    <TextField label="Port" type="number" value={port} onChange={setPort} autoComplete="off" />
                  </div>
                  <div style={{ width: 140 }}>
                    <TextField label="SSH user" value={sshUser} onChange={setSshUser} autoComplete="off" />
                  </div>
                </InlineStack>
                <TextField
                  label="SSH private key (PEM)"
                  value={sshKey}
                  onChange={setSshKey}
                  autoComplete="off"
                  multiline={5}
                  placeholder={editing ? 'Leave blank to keep existing key' : '-----BEGIN OPENSSH PRIVATE KEY-----\n…'}
                  helpText="Stored encrypted. The matching public key must be in the server's ~/.ssh/authorized_keys."
                />
              </>
            )}
            <TextField label="Notes (optional)" value={notes} onChange={setNotes} autoComplete="off" multiline={2} />

            {(!editing || editing.kind === 'remote') && (
              <InlineStack gap="200" blockAlign="center">
                <Button onClick={testForm} loading={testing} disabled={!host || (!sshKey && !(editing && editing.hasKey))}>Test connection</Button>
                {testResult && (
                  <Text as="span" tone={testResult.ok ? 'success' : 'critical'} variant="bodySm">
                    {testResult.ok ? `✓ ${testResult.info ?? 'Connected'}` : `✗ ${testResult.error ?? 'Failed'}`}
                  </Text>
                )}
              </InlineStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
