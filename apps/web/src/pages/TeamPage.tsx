import {
  Page, Card, DataTable, Badge, Button, Modal,
  TextField, Select, BlockStack, InlineStack,
  Text, Banner, Checkbox, SkeletonBodyText
} from '@shopify/polaris'
import { useEffect, useState, useCallback } from 'react'
import { usersApi, UserRecord, api, Site } from '../api/client'
import { useAuth } from '../context/AuthContext'

const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  developer: 'Developer',
  viewer: 'Viewer'
}

const ROLE_TONES: Record<string, 'success' | 'info' | 'warning'> = {
  admin: 'success',
  developer: 'info',
  viewer: 'warning'
}

export function TeamPage() {
  const { user: currentUser } = useAuth()

  const [users,      setUsers]      = useState<UserRecord[]>([])
  const [sites,      setSites]      = useState<Pick<Site, 'id' | 'domain' | 'name'>[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')

  // Invite modal
  const [inviteOpen, setInviteOpen] = useState(false)
  const [inviteEmail,    setInviteEmail]    = useState('')
  const [invitePassword, setInvitePassword] = useState('')
  const [inviteRole,     setInviteRole]     = useState('developer')
  const [inviteSaving,   setInviteSaving]   = useState(false)
  const [inviteError,    setInviteError]    = useState('')

  // Edit role modal
  const [editUser,  setEditUser]  = useState<UserRecord | null>(null)
  const [editRole,  setEditRole]  = useState('developer')
  const [editSaving, setEditSaving] = useState(false)
  const [editError,  setEditError]  = useState('')

  // Delete confirm
  const [deleteUser,   setDeleteUser]   = useState<UserRecord | null>(null)
  const [deleteSaving, setDeleteSaving] = useState(false)

  // Site access modal
  const [accessUser,     setAccessUser]     = useState<UserRecord | null>(null)
  const [assignedSites,  setAssignedSites]  = useState<number[]>([])
  const [accessAllSites, setAccessAllSites] = useState(false)
  const [accessSaving,   setAccessSaving]   = useState(false)
  const [accessLoading,  setAccessLoading]  = useState(false)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [usersRes, sitesRes] = await Promise.all([
        usersApi.list(),
        api.sites.list()
      ])
      setUsers(usersRes.users)
      setSites(sitesRes.map(s => ({ id: s.id, domain: s.domain, name: s.name })))
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // ── Invite ──────────────────────────────────────────────────────────────
  const handleInvite = useCallback(async () => {
    setInviteSaving(true)
    setInviteError('')
    try {
      const user = await usersApi.create({ email: inviteEmail, password: invitePassword, role: inviteRole })
      setUsers(u => [...u, user])
      setInviteOpen(false)
      setInviteEmail('')
      setInvitePassword('')
      setInviteRole('developer')
      // Immediately prompt for site access on non-admin users — admins get
      // full access automatically and have nothing to configure here.
      if (user.role !== 'admin') {
        setAccessUser(user)
        setAssignedSites([])
        setAccessAllSites(false)
      }
    } catch (e: unknown) {
      setInviteError((e as Error).message)
    } finally {
      setInviteSaving(false)
    }
  }, [inviteEmail, invitePassword, inviteRole])

  // ── Edit role ────────────────────────────────────────────────────────────
  const openEdit = useCallback((user: UserRecord) => {
    setEditUser(user)
    setEditRole(user.role)
    setEditError('')
  }, [])

  const handleEditSave = useCallback(async () => {
    if (!editUser) return
    setEditSaving(true)
    setEditError('')
    try {
      const updated = await usersApi.update(editUser.id, { role: editRole })
      setUsers(u => u.map(x => x.id === updated.id ? updated : x))
      setEditUser(null)
    } catch (e: unknown) {
      setEditError((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }, [editUser, editRole])

  // ── Delete ───────────────────────────────────────────────────────────────
  const handleDelete = useCallback(async () => {
    if (!deleteUser) return
    setDeleteSaving(true)
    try {
      await usersApi.remove(deleteUser.id)
      setUsers(u => u.filter(x => x.id !== deleteUser.id))
      setDeleteUser(null)
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      setDeleteSaving(false)
    }
  }, [deleteUser])

  // ── Site Access ──────────────────────────────────────────────────────────
  const openAccess = useCallback(async (user: UserRecord) => {
    setAccessUser(user)
    setAccessLoading(true)
    try {
      const res = await usersApi.getSites(user.id)
      setAssignedSites(res.siteIds)
      setAccessAllSites(res.allSitesAccess)
    } catch {
      setAssignedSites([])
      setAccessAllSites(false)
    } finally {
      setAccessLoading(false)
    }
  }, [])

  const handleSaveAccess = useCallback(async () => {
    if (!accessUser) return
    setAccessSaving(true)
    try {
      const updated = await usersApi.update(accessUser.id, { allSitesAccess: accessAllSites })
      setUsers(u => u.map(x => x.id === updated.id ? updated : x))
      // The specific-site list is only the active grant when "all sites" is
      // off — but we still save it so toggling "all sites" back off later
      // restores the prior selection instead of leaving the user with none.
      if (!accessAllSites) {
        await usersApi.setSites(accessUser.id, assignedSites)
      }
      setAccessUser(null)
    } catch (e: unknown) {
      alert((e as Error).message)
    } finally {
      setAccessSaving(false)
    }
  }, [accessUser, assignedSites, accessAllSites])

  const toggleSite = (siteId: number) =>
    setAssignedSites(ids => ids.includes(siteId) ? ids.filter(x => x !== siteId) : [...ids, siteId])

  const roleOptions = [
    { label: 'Admin', value: 'admin' },
    { label: 'Developer', value: 'developer' },
    { label: 'Viewer', value: 'viewer' }
  ]

  return (
    <Page
      title="Team"
      subtitle="Manage users and their access to sites"
      primaryAction={{ content: 'Invite User', onAction: () => setInviteOpen(true) }}
    >
      <BlockStack gap="500">
        {error && <Banner tone="critical">{error}</Banner>}

        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingMd">Users</Text>

            {loading && <SkeletonBodyText lines={5} />}

            {!loading && users.length === 0 && (
              <Text as="p" tone="subdued">No users yet.</Text>
            )}

            {!loading && users.length > 0 && (
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text']}
                headings={['Email', 'Role', 'Joined', 'Actions']}
                rows={users.map(u => [
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="span">{u.email}</Text>
                    {u.id === currentUser?.id && <Badge tone="info">You</Badge>}
                  </InlineStack>,
                  <InlineStack gap="100" blockAlign="center">
                    <Badge tone={ROLE_TONES[u.role] ?? 'info'}>{ROLE_LABELS[u.role] ?? u.role}</Badge>
                    {u.role !== 'admin' && u.allSitesAccess && <Badge tone="attention">All sites</Badge>}
                  </InlineStack>,
                  new Date(u.createdAt).toLocaleDateString(),
                  <InlineStack gap="200">
                    {u.role !== 'admin' && (
                      <Button size="micro" onClick={() => openAccess(u)}>Sites</Button>
                    )}
                    {u.id !== currentUser?.id && (
                      <Button size="micro" onClick={() => openEdit(u)}>Edit Role</Button>
                    )}
                    {u.id !== currentUser?.id && (
                      <Button size="micro" tone="critical" onClick={() => setDeleteUser(u)}>Remove</Button>
                    )}
                  </InlineStack>
                ])}
              />
            )}
          </BlockStack>
        </Card>
      </BlockStack>

      {/* ── Invite Modal ── */}
      <Modal
        open={inviteOpen}
        onClose={() => { setInviteOpen(false); setInviteError('') }}
        title="Invite User"
        primaryAction={{ content: 'Create', onAction: handleInvite, loading: inviteSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => { setInviteOpen(false); setInviteError('') } }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {inviteError && <Banner tone="critical">{inviteError}</Banner>}
            <TextField
              label="Email"
              type="email"
              value={inviteEmail}
              onChange={setInviteEmail}
              autoComplete="off"
            />
            <TextField
              label="Password"
              type="password"
              value={invitePassword}
              onChange={setInvitePassword}
              autoComplete="new-password"
              helpText="Minimum 8 characters"
            />
            <Select
              label="Role"
              options={roleOptions}
              value={inviteRole}
              onChange={setInviteRole}
              helpText="Admin: full access. Developer: deploy + manage sites. Viewer: read-only."
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Edit Role Modal ── */}
      <Modal
        open={!!editUser}
        onClose={() => setEditUser(null)}
        title={`Edit Role — ${editUser?.email}`}
        primaryAction={{ content: 'Save', onAction: handleEditSave, loading: editSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setEditUser(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {editError && <Banner tone="critical">{editError}</Banner>}
            <Select
              label="Role"
              options={roleOptions}
              value={editRole}
              onChange={setEditRole}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Delete Confirm Modal ── */}
      <Modal
        open={!!deleteUser}
        onClose={() => setDeleteUser(null)}
        title="Remove User"
        primaryAction={{ content: 'Remove', onAction: handleDelete, loading: deleteSaving, destructive: true }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setDeleteUser(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            Remove <strong>{deleteUser?.email}</strong>? They will lose all access immediately.
          </Text>
        </Modal.Section>
      </Modal>

      {/* ── Site Access Modal ── */}
      <Modal
        open={!!accessUser}
        onClose={() => setAccessUser(null)}
        title={`Site Access — ${accessUser?.email}`}
        primaryAction={{ content: 'Save', onAction: handleSaveAccess, loading: accessSaving }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setAccessUser(null) }]}
      >
        <Modal.Section>
          {accessLoading && <SkeletonBodyText lines={5} />}
          {!accessLoading && (
            <BlockStack gap="300">
              <Text as="p" tone="subdued">
                {accessUser?.role === 'viewer' ? 'Viewer: read-only access.' : 'Developer: can deploy and manage.'}
              </Text>
              <Checkbox
                label="Access to all sites (including any created later)"
                helpText="Skips the per-site list below — this user will see every site in the panel."
                checked={accessAllSites}
                onChange={setAccessAllSites}
              />
              <Text as="p" tone="subdued" fontWeight="medium">
                Or select specific sites:
              </Text>
              {sites.length === 0 && <Text as="p" tone="subdued">No sites yet.</Text>}
              {sites.map(s => (
                <Checkbox
                  key={s.id}
                  label={`${s.domain}${s.name !== s.domain ? ` (${s.name})` : ''}`}
                  checked={assignedSites.includes(s.id)}
                  disabled={accessAllSites}
                  onChange={() => toggleSite(s.id)}
                />
              ))}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </Page>
  )
}
