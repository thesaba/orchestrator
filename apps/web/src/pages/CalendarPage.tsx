import {
  Page, Card, Button, Modal, TextField, Select, BlockStack, InlineStack,
  Text, Banner, Badge, SkeletonBodyText, Checkbox
} from '@shopify/polaris'
import { ChevronLeftIcon, ChevronRightIcon } from '@shopify/polaris-icons'
import { useEffect, useState, useCallback, useMemo } from 'react'
import { calendarApi, directoryApi, api, CalendarEvent, DirectoryUser, Site } from '../api/client'
import { useAuth } from '../context/AuthContext'

const TYPE_COLOR: Record<string, string> = {
  custom: '#5c6ac4',
  reminder: '#47c1bf',
  maintenance: '#e4a11b',
  task_deadline: '#d72c0d'
}

function fmtDate(d: Date) {
  return d.toISOString().slice(0, 10)
}

function startOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth(), 1) }
function endOfMonth(d: Date) { return new Date(d.getFullYear(), d.getMonth() + 1, 0) }

function monthGridDays(monthAnchor: Date): Date[] {
  const first = startOfMonth(monthAnchor)
  const startWeekday = first.getDay() // 0 = Sun
  const gridStart = new Date(first)
  gridStart.setDate(first.getDate() - startWeekday)
  const days: Date[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart)
    d.setDate(gridStart.getDate() + i)
    days.push(d)
  }
  return days
}

export function CalendarPage() {
  const { isAdmin } = useAuth()

  const [anchor, setAnchor] = useState(new Date())
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [sites, setSites] = useState<Pick<Site, 'id' | 'domain' | 'name'>[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [editing, setEditing] = useState<CalendarEvent | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formType, setFormType] = useState('custom')
  const [formDate, setFormDate] = useState('')
  const [formAllDay, setFormAllDay] = useState(true)
  const [formRecurrence, setFormRecurrence] = useState('')
  const [formSiteId, setFormSiteId] = useState('')
  const [formAttendees, setFormAttendees] = useState<number[]>([])
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const rangeStart = useMemo(() => {
    const d = startOfMonth(anchor)
    d.setDate(d.getDate() - 7)
    return d
  }, [anchor])
  const rangeEnd = useMemo(() => {
    const d = endOfMonth(anchor)
    d.setDate(d.getDate() + 7)
    return d
  }, [anchor])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [e, u, s] = await Promise.all([
        calendarApi.list({ start: rangeStart.toISOString(), end: rangeEnd.toISOString() }),
        directoryApi.list(),
        api.sites.list()
      ])
      setEvents(e.events)
      setUsers(u.users)
      setSites(s.map(x => ({ id: x.id, domain: x.domain, name: x.name })))
    } catch (e2: unknown) {
      setError((e2 as Error).message)
    } finally {
      setLoading(false)
    }
  }, [rangeStart, rangeEnd])

  useEffect(() => { load() }, [load])

  const days = useMemo(() => monthGridDays(anchor), [anchor])

  const eventsByDay = useMemo(() => {
    const map: Record<string, CalendarEvent[]> = {}
    for (const e of events) {
      const key = fmtDate(new Date(e.startAt))
      if (!map[key]) map[key] = []
      map[key].push(e)
    }
    return map
  }, [events])

  const openNew = useCallback((date: Date) => {
    setIsNew(true)
    setEditing({} as CalendarEvent)
    setFormTitle('')
    setFormDescription('')
    setFormType('custom')
    setFormDate(fmtDate(date))
    setFormAllDay(true)
    setFormRecurrence('')
    setFormSiteId('')
    setFormAttendees([])
    setFormError('')
  }, [])

  const openEdit = useCallback((ev: CalendarEvent) => {
    if (!ev.editable) return // virtual / task-due entries aren't editable here
    setIsNew(false)
    setEditing(ev)
    setFormTitle(ev.title)
    setFormDescription(ev.description ?? '')
    setFormType(ev.type)
    setFormDate(fmtDate(new Date(ev.startAt)))
    setFormAllDay(ev.allDay)
    setFormRecurrence(ev.recurrence ?? '')
    setFormSiteId(ev.siteId ? String(ev.siteId) : '')
    setFormAttendees(ev.attendees.map(a => a.userId))
    setFormError('')
  }, [])

  const closeModal = () => setEditing(null)

  // Persisted events use a synthetic id like "event-12" or "event-12-3" (an
  // expanded recurrence occurrence) — the numeric DB id is always the first
  // number in the string.
  const dbId = (id: string) => Number(id.split('-')[1])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setFormError('')
    try {
      const payload = {
        title: formTitle,
        description: formDescription || undefined,
        type: formType,
        startAt: new Date(formDate).toISOString(),
        allDay: formAllDay,
        recurrence: (formRecurrence || undefined) as 'daily' | 'weekly' | 'monthly' | undefined,
        siteId: formSiteId ? Number(formSiteId) : undefined,
        attendeeIds: formAttendees
      }
      if (isNew) {
        await calendarApi.create(payload)
      } else if (editing) {
        await calendarApi.update(dbId(editing.id), payload)
      }
      closeModal()
      load()
    } catch (e: unknown) {
      setFormError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [isNew, editing, formTitle, formDescription, formType, formDate, formAllDay, formRecurrence, formSiteId, formAttendees, load])

  const handleDelete = useCallback(async () => {
    if (!editing || isNew) return
    if (!confirm('Delete this event?')) return
    try {
      await calendarApi.remove(dbId(editing.id))
      closeModal()
      load()
    } catch (e: unknown) {
      alert((e as Error).message)
    }
  }, [editing, isNew, load])

  const toggleAttendee = (id: number) =>
    setFormAttendees(a => a.includes(id) ? a.filter(x => x !== id) : [...a, id])

  const monthLabel = anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const todayKey = fmtDate(new Date())

  return (
    <Page
      title="Calendar"
      subtitle="Events, reminders, and task deadlines"
      primaryAction={isAdmin ? { content: 'New Event', onAction: () => openNew(new Date()) } : undefined}
    >
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Button icon={ChevronLeftIcon} onClick={() => setAnchor(d => new Date(d.getFullYear(), d.getMonth() - 1, 1))} accessibilityLabel="Previous month" />
            <Text as="h2" variant="headingMd">{monthLabel}</Text>
            <Button icon={ChevronRightIcon} onClick={() => setAnchor(d => new Date(d.getFullYear(), d.getMonth() + 1, 1))} accessibilityLabel="Next month" />
          </InlineStack>
          <Button onClick={() => setAnchor(new Date())}>Today</Button>
        </InlineStack>

        {loading && <Card><SkeletonBodyText lines={8} /></Card>}

        {!loading && (
          <Card padding="200">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => (
                <div key={d} style={{ textAlign: 'center', padding: 4 }}>
                  <Text as="span" variant="bodySm" tone="subdued">{d}</Text>
                </div>
              ))}
              {days.map(day => {
                const key = fmtDate(day)
                const inMonth = day.getMonth() === anchor.getMonth()
                const dayEvents = eventsByDay[key] ?? []
                return (
                  <div
                    key={key}
                    onClick={() => isAdmin && openNew(day)}
                    style={{
                      minHeight: 90, border: '1px solid var(--p-color-border-secondary, #e1e3e5)', borderRadius: 6,
                      padding: 6, opacity: inMonth ? 1 : 0.45, cursor: isAdmin ? 'pointer' : 'default',
                      background: key === todayKey ? 'rgba(92,106,196,0.08)' : undefined
                    }}
                  >
                    <Text as="span" variant="bodySm" fontWeight={key === todayKey ? 'bold' : 'regular'}>{day.getDate()}</Text>
                    <BlockStack gap="050">
                      {dayEvents.slice(0, 3).map(ev => (
                        <div
                          key={ev.id}
                          onClick={(e) => { e.stopPropagation(); openEdit(ev) }}
                          title={ev.title}
                          style={{
                            background: ev.color ?? TYPE_COLOR[ev.type] ?? '#5c6ac4',
                            color: 'white', borderRadius: 4, padding: '1px 4px', fontSize: 11,
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                            cursor: ev.editable ? 'pointer' : 'default'
                          }}
                        >
                          {ev.title}
                        </div>
                      ))}
                      {dayEvents.length > 3 && (
                        <Text as="span" variant="bodySm" tone="subdued">+{dayEvents.length - 3} more</Text>
                      )}
                    </BlockStack>
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingSm">Legend</Text>
            <InlineStack gap="300">
              <InlineStack gap="100" blockAlign="center"><Badge tone="info">●</Badge><Text as="span">Custom event</Text></InlineStack>
              <InlineStack gap="100" blockAlign="center"><Badge tone="critical">●</Badge><Text as="span">Task deadline (auto)</Text></InlineStack>
            </InlineStack>
          </BlockStack>
        </Card>
      </BlockStack>

      <Modal
        open={!!editing}
        onClose={closeModal}
        title={isNew ? 'New Event' : 'Edit Event'}
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
                <TextField label="Date" type="date" value={formDate} onChange={setFormDate} autoComplete="off" />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="Type"
                  options={[
                    { label: 'Custom', value: 'custom' },
                    { label: 'Reminder', value: 'reminder' },
                    { label: 'Maintenance', value: 'maintenance' }
                  ]}
                  value={formType}
                  onChange={setFormType}
                />
              </div>
            </InlineStack>
            <InlineStack gap="300">
              <Checkbox label="All day" checked={formAllDay} onChange={setFormAllDay} />
              <div style={{ flex: 1 }}>
                <Select
                  label="Repeats"
                  options={[
                    { label: 'Does not repeat', value: '' },
                    { label: 'Daily', value: 'daily' },
                    { label: 'Weekly', value: 'weekly' },
                    { label: 'Monthly', value: 'monthly' }
                  ]}
                  value={formRecurrence}
                  onChange={setFormRecurrence}
                />
              </div>
            </InlineStack>
            <Select
              label="Site (optional)"
              options={[{ label: 'No site', value: '' }, ...sites.map(s => ({ label: s.domain, value: String(s.id) }))]}
              value={formSiteId}
              onChange={setFormSiteId}
            />
            <Text as="h3" variant="headingSm">Attendees</Text>
            <BlockStack gap="100">
              {users.map(u => (
                <Checkbox key={u.id} label={u.email} checked={formAttendees.includes(u.id)} onChange={() => toggleAttendee(u.id)} />
              ))}
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  )
}
