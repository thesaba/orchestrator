import {
  Page, Card, Button, Modal, TextField, Select, BlockStack, InlineStack,
  Text, Banner, Badge, SkeletonBodyText, Checkbox, Tag, ButtonGroup
} from '@shopify/polaris'
import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  tasksApi, directoryApi, api, Task, TaskStatus, TaskPriority, DirectoryUser, Site
} from '../api/client'
import { useAuth } from '../context/AuthContext'

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: 'To Do' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' }
]

const PRIORITY_TONE: Record<TaskPriority, 'info' | 'attention' | 'warning' | 'critical'> = {
  low: 'info',
  medium: 'attention',
  high: 'warning',
  urgent: 'critical'
}

function parseTags(json: string): string[] {
  try { return JSON.parse(json) } catch { return [] }
}

export function TasksPage() {
  const { isAdmin, user } = useAuth()

  const [tasks, setTasks] = useState<Task[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [sites, setSites] = useState<Pick<Site, 'id' | 'domain' | 'name'>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scope, setScope] = useState<'mine' | 'all'>('mine')

  const [editing, setEditing] = useState<Task | null>(null) // null = closed, {} shape = new
  const [isNew, setIsNew] = useState(false)
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formStatus, setFormStatus] = useState<TaskStatus>('todo')
  const [formPriority, setFormPriority] = useState<TaskPriority>('medium')
  const [formDueDate, setFormDueDate] = useState('')
  const [formTags, setFormTags] = useState('')
  const [formSiteId, setFormSiteId] = useState<string>('')
  const [formAssigneeId, setFormAssigneeId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const [newChecklistText, setNewChecklistText] = useState('')
  const [newComment, setNewComment] = useState('')
  const [dragTaskId, setDragTaskId] = useState<number | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [t, u, s] = await Promise.all([
        tasksApi.list(scope === 'mine' ? { mine: true } : undefined),
        directoryApi.list(),
        api.sites.list()
      ])
      setTasks(t.tasks)
      setUsers(u.users)
      setSites(s.map(x => ({ id: x.id, domain: x.domain, name: x.name })))
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [scope])

  useEffect(() => { load() }, [load])

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, Task[]> = { todo: [], in_progress: [], review: [], done: [] }
    for (const t of tasks) g[t.status]?.push(t)
    for (const k of Object.keys(g) as TaskStatus[]) g[k].sort((a, b) => a.position - b.position)
    return g
  }, [tasks])

  const userOptions = [{ label: 'Unassigned', value: '' }, ...users.map(u2 => ({ label: u2.email, value: String(u2.id) }))]
  const siteOptions = [{ label: 'No site', value: '' }, ...sites.map(s => ({ label: s.domain, value: String(s.id) }))]

  const openNew = useCallback((status: TaskStatus) => {
    setIsNew(true)
    setEditing({} as Task)
    setFormTitle('')
    setFormDescription('')
    setFormStatus(status)
    setFormPriority('medium')
    setFormDueDate('')
    setFormTags('')
    setFormSiteId('')
    setFormAssigneeId(isAdmin ? '' : String(user?.id ?? ''))
    setFormError('')
  }, [isAdmin, user])

  const openEdit = useCallback(async (task: Task) => {
    setIsNew(false)
    setFormError('')
    try {
      const full = await tasksApi.get(task.id)
      setEditing(full)
      setFormTitle(full.title)
      setFormDescription(full.description ?? '')
      setFormStatus(full.status)
      setFormPriority(full.priority)
      setFormDueDate(full.dueDate ? full.dueDate.slice(0, 10) : '')
      setFormTags(parseTags(full.tags).join(', '))
      setFormSiteId(full.siteId ? String(full.siteId) : '')
      setFormAssigneeId(full.assigneeId ? String(full.assigneeId) : '')
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }, [])

  const closeModal = () => { setEditing(null); setNewChecklistText(''); setNewComment('') }

  const handleSave = useCallback(async () => {
    setSaving(true)
    setFormError('')
    const tags = formTags.split(',').map(t => t.trim()).filter(Boolean)
    try {
      if (isNew) {
        const created = await tasksApi.create({
          title: formTitle,
          description: formDescription || undefined,
          status: formStatus,
          priority: formPriority,
          dueDate: formDueDate || undefined,
          tags,
          siteId: formSiteId ? Number(formSiteId) : undefined,
          assigneeId: formAssigneeId ? Number(formAssigneeId) : undefined
        })
        setTasks(t => [...t, created])
      } else if (editing) {
        const updated = await tasksApi.update(editing.id, {
          title: formTitle,
          description: formDescription || null,
          status: formStatus,
          priority: formPriority,
          dueDate: formDueDate || null,
          tags,
          siteId: formSiteId ? Number(formSiteId) : null,
          assigneeId: formAssigneeId ? Number(formAssigneeId) : null
        })
        setTasks(t => t.map(x => x.id === updated.id ? { ...x, ...updated } : x))
      }
      closeModal()
    } catch (e: unknown) {
      setFormError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [isNew, editing, formTitle, formDescription, formStatus, formPriority, formDueDate, formTags, formSiteId, formAssigneeId])

  const handleDelete = useCallback(async () => {
    if (!editing || isNew) return
    if (!confirm('Delete this task?')) return
    try {
      await tasksApi.remove(editing.id)
      setTasks(t => t.filter(x => x.id !== editing.id))
      closeModal()
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, isNew])

  // ── Drag & drop between columns ──────────────────────────────────────────
  const handleDrop = useCallback(async (status: TaskStatus) => {
    if (dragTaskId == null) return
    const task = tasks.find(t => t.id === dragTaskId)
    setDragTaskId(null)
    if (!task || task.status === status) return
    const colTasks = grouped[status]
    const maxPos = colTasks.length ? Math.max(...colTasks.map(t => t.position)) : 0
    try {
      const updated = await tasksApi.update(task.id, { status, position: maxPos + 1 })
      setTasks(ts => ts.map(t => t.id === task.id ? { ...t, ...updated } : t))
    } catch (e: unknown) {
      setError((e as Error).message)
    }
  }, [dragTaskId, tasks, grouped])

  // ── Checklist ────────────────────────────────────────────────────────────
  const addChecklistItem = useCallback(async () => {
    if (!editing || isNew || !newChecklistText.trim()) return
    try {
      const item = await tasksApi.addChecklistItem(editing.id, newChecklistText.trim())
      setEditing(t => t ? { ...t, checklist: [...t.checklist, item] } : t)
      setNewChecklistText('')
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, isNew, newChecklistText])

  const toggleChecklistItem = useCallback(async (itemId: number, done: boolean) => {
    if (!editing) return
    try {
      const item = await tasksApi.updateChecklistItem(editing.id, itemId, { done })
      setEditing(t => t ? { ...t, checklist: t.checklist.map(c => c.id === itemId ? item : c) } : t)
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing])

  const removeChecklistItem = useCallback(async (itemId: number) => {
    if (!editing) return
    try {
      await tasksApi.removeChecklistItem(editing.id, itemId)
      setEditing(t => t ? { ...t, checklist: t.checklist.filter(c => c.id !== itemId) } : t)
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing])

  // ── Comments ─────────────────────────────────────────────────────────────
  const addComment = useCallback(async () => {
    if (!editing || isNew || !newComment.trim()) return
    try {
      const comment = await tasksApi.addComment(editing.id, newComment.trim())
      setEditing(t => t ? { ...t, comments: [...(t.comments ?? []), comment] } : t)
      setNewComment('')
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, isNew, newComment])

  return (
    <Page
      title="Tasks"
      subtitle="Kanban board for assigning and tracking work"
      primaryAction={{ content: 'New Task', onAction: () => openNew('todo') }}
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        <InlineStack gap="200">
          <ButtonGroup variant="segmented">
            <Button pressed={scope === 'mine'} onClick={() => setScope('mine')}>My Tasks</Button>
            {isAdmin && <Button pressed={scope === 'all'} onClick={() => setScope('all')}>All Tasks</Button>}
          </ButtonGroup>
        </InlineStack>

        {loading && <Card><SkeletonBodyText lines={6} /></Card>}

        {!loading && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 16, alignItems: 'start' }}>
            {COLUMNS.map(col => (
              <div
                key={col.key}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(col.key)}
              >
                <Card>
                  <BlockStack gap="300">
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="h2" variant="headingSm">{col.label}</Text>
                      <InlineStack gap="100" blockAlign="center">
                        <Badge>{String(grouped[col.key].length)}</Badge>
                        <Button size="micro" variant="plain" onClick={() => openNew(col.key)}>+ Add</Button>
                      </InlineStack>
                    </InlineStack>

                    <BlockStack gap="200">
                      {grouped[col.key].map(task => {
                        const tags = parseTags(task.tags)
                        const doneCount = task.checklist.filter(c => c.done).length
                        return (
                          <div
                            key={task.id}
                            draggable
                            onDragStart={() => setDragTaskId(task.id)}
                            onClick={() => openEdit(task)}
                            style={{ cursor: 'pointer' }}
                          >
                            <Card padding="300">
                              <BlockStack gap="150">
                                <Text as="span" fontWeight="semibold">{task.title}</Text>
                                <InlineStack gap="150" wrap>
                                  <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
                                  {task.dueDate && (
                                    <Badge tone={task.dueDate.slice(0, 10) < new Date().toISOString().slice(0, 10) && task.status !== 'done' ? 'critical' : undefined}>
                                      {new Date(task.dueDate).toLocaleDateString(undefined, { timeZone: 'UTC' })}
                                    </Badge>
                                  )}
                                  {task.checklist.length > 0 && <Badge>{`${doneCount}/${task.checklist.length}`}</Badge>}
                                </InlineStack>
                                {task.assignee && (
                                  <Text as="span" tone="subdued" variant="bodySm">→ {task.assignee.email}</Text>
                                )}
                                {task.site && (
                                  <Text as="span" tone="subdued" variant="bodySm">{task.site.domain}</Text>
                                )}
                                {tags.length > 0 && (
                                  <InlineStack gap="100" wrap>
                                    {tags.map(t => <Tag key={t}>{t}</Tag>)}
                                  </InlineStack>
                                )}
                              </BlockStack>
                            </Card>
                          </div>
                        )
                      })}
                      {grouped[col.key].length === 0 && (
                        <Text as="p" tone="subdued" variant="bodySm">No tasks</Text>
                      )}
                    </BlockStack>
                  </BlockStack>
                </Card>
              </div>
            ))}
          </div>
        )}
      </BlockStack>

      <Modal
        open={!!editing}
        onClose={closeModal}
        title={isNew ? 'New Task' : 'Edit Task'}
        primaryAction={{ content: 'Save', onAction: handleSave, loading: saving }}
        secondaryActions={!isNew ? [{ content: 'Delete', destructive: true, onAction: handleDelete }] : []}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {formError && <Banner tone="critical">{formError}</Banner>}
            <TextField label="Title" value={formTitle} onChange={setFormTitle} autoComplete="off" />
            <TextField label="Description" value={formDescription} onChange={setFormDescription} multiline={3} autoComplete="off" />
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <Select
                  label="Status"
                  options={COLUMNS.map(c => ({ label: c.label, value: c.key }))}
                  value={formStatus}
                  onChange={(v) => setFormStatus(v as TaskStatus)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Priority"
                  options={[
                    { label: 'Low', value: 'low' },
                    { label: 'Medium', value: 'medium' },
                    { label: 'High', value: 'high' },
                    { label: 'Urgent', value: 'urgent' }
                  ]}
                  value={formPriority}
                  onChange={(v) => setFormPriority(v as TaskPriority)}
                />
              </div>
            </InlineStack>
            <InlineStack gap="300">
              <div style={{ flex: 1 }}>
                <TextField label="Due date" type="date" value={formDueDate} onChange={setFormDueDate} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Assignee"
                  options={userOptions}
                  value={formAssigneeId}
                  onChange={setFormAssigneeId}
                  disabled={!isAdmin}
                  helpText={!isAdmin ? 'Only admins can reassign tasks.' : undefined}
                />
              </div>
            </InlineStack>
            <Select label="Site (optional)" options={siteOptions} value={formSiteId} onChange={setFormSiteId} />
            <TextField label="Tags (comma-separated)" value={formTags} onChange={setFormTags} autoComplete="off" />

            {!isNew && editing && (
              <>
                <Text as="h3" variant="headingSm">Checklist</Text>
                <BlockStack gap="150">
                  {editing.checklist.map(item => (
                    <InlineStack key={item.id} gap="200" blockAlign="center">
                      <Checkbox label={item.text} checked={item.done} onChange={(v) => toggleChecklistItem(item.id, v)} />
                      <Button size="micro" variant="plain" tone="critical" onClick={() => removeChecklistItem(item.id)}>Remove</Button>
                    </InlineStack>
                  ))}
                  <InlineStack gap="200">
                    <div style={{ flex: 1 }}>
                      <TextField label="" labelHidden placeholder="New checklist item" value={newChecklistText} onChange={setNewChecklistText} autoComplete="off" />
                    </div>
                    <Button onClick={addChecklistItem}>Add</Button>
                  </InlineStack>
                </BlockStack>

                <Text as="h3" variant="headingSm">Comments</Text>
                <BlockStack gap="150">
                  {(editing.comments ?? []).map(c => (
                    <Card key={c.id} padding="200">
                      <BlockStack gap="050">
                        <Text as="span" variant="bodySm" fontWeight="semibold">{c.user.email}</Text>
                        <Text as="span" variant="bodySm">{c.body}</Text>
                      </BlockStack>
                    </Card>
                  ))}
                  <InlineStack gap="200">
                    <div style={{ flex: 1 }}>
                      <TextField label="" labelHidden placeholder="Add a comment" value={newComment} onChange={setNewComment} autoComplete="off" />
                    </div>
                    <Button onClick={addComment}>Post</Button>
                  </InlineStack>
                </BlockStack>
              </>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
