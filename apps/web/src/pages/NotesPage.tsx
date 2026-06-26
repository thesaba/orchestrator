import {
  Page, Card, Button, Modal, TextField, BlockStack, InlineStack,
  Text, Banner, Badge, SkeletonBodyText, Checkbox, Tag, ButtonGroup, Icon
} from '@shopify/polaris'
import { PinFilledIcon, ShareIcon } from '@shopify/polaris-icons'
import { useEffect, useState, useCallback, useMemo, MouseEvent } from 'react'
import { notesApi, directoryApi, Note, DirectoryUser } from '../api/client'
import { useAuth } from '../context/AuthContext'

function parseTags(json: string): string[] {
  try { return JSON.parse(json) } catch { return [] }
}

export function NotesPage() {
  const { user } = useAuth()

  const [notes, setNotes] = useState<Note[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'mine' | 'shared' | 'pinned'>('all')

  const [editing, setEditing] = useState<Note | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [formTitle, setFormTitle] = useState('')
  const [formBody, setFormBody] = useState('')
  const [formTags, setFormTags] = useState('')
  const [formPinned, setFormPinned] = useState(false)
  const [formPublic, setFormPublic] = useState(false)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [shareOpen, setShareOpen] = useState(false)
  const [shareSelections, setShareSelections] = useState<Record<number, boolean>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [n, u] = await Promise.all([
        notesApi.list(search ? { search } : undefined),
        directoryApi.list()
      ])
      setNotes(n.notes)
      setUsers(u.users)
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [search])

  useEffect(() => { load() }, [load])

  const visible = useMemo(() => {
    return notes.filter(n => {
      if (filter === 'mine') return n.ownerId === user?.id
      if (filter === 'shared') return n.ownerId !== user?.id
      if (filter === 'pinned') return n.pinned
      return true
    })
  }, [notes, filter, user])

  const openNew = useCallback(() => {
    setIsNew(true)
    setEditing({} as Note)
    setFormTitle('')
    setFormBody('')
    setFormTags('')
    setFormPinned(false)
    setFormPublic(false)
    setFormError('')
  }, [])

  const openEdit = useCallback((note: Note) => {
    setIsNew(false)
    setEditing(note)
    setFormTitle(note.title)
    setFormBody(note.body)
    setFormTags(parseTags(note.tags).join(', '))
    setFormPinned(note.pinned)
    setFormPublic(note.isPublic)
    setFormError('')
  }, [])

  const closeModal = () => setEditing(null)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setFormError('')
    const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)
    try {
      if (isNew) {
        const created = await notesApi.create({ title: formTitle, body: formBody, tags, pinned: formPinned, isPublic: formPublic })
        setNotes(n => [created, ...n])
      } else if (editing) {
        const updated = await notesApi.update(editing.id, { title: formTitle, body: formBody, tags, pinned: formPinned, isPublic: formPublic })
        setNotes(n => n.map(x => x.id === updated.id ? updated : x))
      }
      closeModal()
    } catch (e: unknown) {
      setFormError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [isNew, editing, formTitle, formBody, formTags, formPinned, formPublic])

  const handleDelete = useCallback(async () => {
    if (!editing || isNew) return
    if (!confirm('Delete this note?')) return
    try {
      await notesApi.remove(editing.id)
      setNotes(n => n.filter(x => x.id !== editing.id))
      closeModal()
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, isNew])

  const togglePin = useCallback(async (note: Note, e: MouseEvent) => {
    e.stopPropagation()
    try {
      const updated = await notesApi.update(note.id, { pinned: !note.pinned })
      setNotes(n => n.map(x => x.id === updated.id ? updated : x))
    } catch (e2: unknown) {
      alert((e2 as Error).message)
    }
  }, [])

  const openShare = useCallback((note: Note, e: MouseEvent) => {
    e.stopPropagation()
    setEditing(note)
    const sel: Record<number, boolean> = {}
    for (const s of note.shares) sel[s.userId] = s.canEdit
    setShareSelections(sel)
    setShareOpen(true)
  }, [])

  const handleShareSave = useCallback(async () => {
    if (!editing) return
    try {
      const shares = Object.entries(shareSelections)
        .filter(([, v]) => v !== undefined)
        .map(([userId]) => ({ userId: Number(userId), canEdit: !!shareSelections[Number(userId)] }))
      const updated = await notesApi.setShares(editing.id, shares)
      setNotes(n => n.map(x => x.id === updated.id ? updated : x))
      setShareOpen(false)
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, shareSelections])

  const toggleShareUser = (userId: number) =>
    setShareSelections(s => {
      const next = { ...s }
      if (userId in next) delete next[userId]
      else next[userId] = false
      return next
    })

  const toggleShareEdit = (userId: number, canEdit: boolean) =>
    setShareSelections(s => ({ ...s, [userId]: canEdit }))

  return (
    <Page
      title="Notes"
      subtitle="Personal and shared notes, ideas, and journal entries"
      primaryAction={{ content: 'New Note', onAction: openNew }}
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        <InlineStack gap="300" align="space-between">
          <ButtonGroup variant="segmented">
            <Button pressed={filter === 'all'} onClick={() => setFilter('all')}>All</Button>
            <Button pressed={filter === 'mine'} onClick={() => setFilter('mine')}>Mine</Button>
            <Button pressed={filter === 'shared'} onClick={() => setFilter('shared')}>Shared with me</Button>
            <Button pressed={filter === 'pinned'} onClick={() => setFilter('pinned')}>Pinned</Button>
          </ButtonGroup>
          <div style={{ minWidth: 260 }}>
            <TextField label="" labelHidden placeholder="Search notes…" value={search} onChange={setSearch} autoComplete="off" />
          </div>
        </InlineStack>

        {loading && <Card><SkeletonBodyText lines={6} /></Card>}

        {!loading && visible.length === 0 && (
          <Card><Text as="p" tone="subdued">No notes found.</Text></Card>
        )}

        {!loading && visible.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
            {visible.map(note => {
              const tags = parseTags(note.tags)
              const isOwner = note.ownerId === user?.id
              return (
                <div key={note.id} onClick={() => openEdit(note)} style={{ cursor: 'pointer' }}>
                  <Card>
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="h3" variant="headingSm">{note.title}</Text>
                        <InlineStack gap="100">
                          <span onClick={(e) => togglePin(note, e)}>
                            <Icon source={PinFilledIcon} tone={note.pinned ? 'warning' : 'subdued'} />
                          </span>
                          {isOwner && (
                            <span onClick={(e) => openShare(note, e)}>
                              <Icon source={ShareIcon} tone="subdued" />
                            </span>
                          )}
                        </InlineStack>
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {note.body.slice(0, 140)}{note.body.length > 140 ? '…' : ''}
                      </Text>
                      <InlineStack gap="150" wrap>
                        {!isOwner && <Badge tone="info">{`by ${note.owner.email}`}</Badge>}
                        {note.isPublic && <Badge tone="success">Public</Badge>}
                        {note.shares.length > 0 && <Badge>{`Shared with ${note.shares.length}`}</Badge>}
                        {tags.map(t => <Tag key={t}>{t}</Tag>)}
                      </InlineStack>
                    </BlockStack>
                  </Card>
                </div>
              )
            })}
          </div>
        )}
      </BlockStack>

      <Modal
        open={!!editing && !shareOpen}
        onClose={closeModal}
        title={isNew ? 'New Note' : 'Edit Note'}
        primaryAction={{ content: 'Save', onAction: handleSave, loading: saving }}
        secondaryActions={!isNew && editing?.ownerId === user?.id ? [{ content: 'Delete', destructive: true, onAction: handleDelete }] : []}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {formError && <Banner tone="critical">{formError}</Banner>}
            <TextField label="Title" value={formTitle} onChange={setFormTitle} autoComplete="off" disabled={!isNew && !editing?.canEdit} />
            <TextField label="Body (Markdown supported)" value={formBody} onChange={setFormBody} multiline={10} autoComplete="off" disabled={!isNew && !editing?.canEdit} />
            <TextField label="Tags (comma-separated)" value={formTags} onChange={setFormTags} autoComplete="off" disabled={!isNew && !editing?.canEdit} />
            <InlineStack gap="400">
              <Checkbox label="Pinned" checked={formPinned} onChange={setFormPinned} />
              {(isNew || editing?.ownerId === user?.id) && (
                <Checkbox label="Visible to everyone (public)" checked={formPublic} onChange={setFormPublic} />
              )}
            </InlineStack>
          </BlockStack>
        </Modal.Section>
      </Modal>

      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title={`Share — ${editing?.title}`}
        primaryAction={{ content: 'Save', onAction: handleShareSave }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setShareOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" tone="subdued">Choose who can view this note, and who can also edit it.</Text>
            {users.filter(u2 => u2.id !== user?.id).map(u2 => (
              <InlineStack key={u2.id} gap="300" blockAlign="center" align="space-between">
                <Checkbox label={u2.email} checked={u2.id in shareSelections} onChange={() => toggleShareUser(u2.id)} />
                {u2.id in shareSelections && (
                  <Checkbox label="Can edit" checked={!!shareSelections[u2.id]} onChange={(v) => toggleShareEdit(u2.id, v)} />
                )}
              </InlineStack>
            ))}
            {users.length <= 1 && <Text as="p" tone="subdued">No other users to share with yet.</Text>}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
