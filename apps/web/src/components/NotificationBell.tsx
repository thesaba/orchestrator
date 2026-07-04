import { useCallback, useEffect, useState } from 'react'
import { Popover, Text, InlineStack, Button, Scrollable } from '@shopify/polaris'
import { useNavigate } from 'react-router-dom'
import { api, AppNotification } from '../api/client'

const DOT: Record<string, string> = {
  info: '#79c0ff', success: '#3fb950', warning: '#e3b341', critical: '#ff6b6b'
}

/**
 * Top-bar notification bell: unread badge + a popover feed. Polls every 30s and
 * refreshes on open. Clicking an item marks it read and, when the notification
 * carries a siteId, jumps to that site.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const navigate = useNavigate()

  const load = useCallback(() => {
    api.notifications.list().then((r) => { setItems(r.notifications); setUnread(r.unread) }).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  const toggle = () => { const next = !open; setOpen(next); if (next) load() }
  const markAllRead = async () => { await api.notifications.readAll().catch(() => {}); load() }
  const clearAll = async () => { await api.notifications.clear().catch(() => {}); load() }

  const onClick = async (n: AppNotification) => {
    if (!n.read) await api.notifications.read(n.id).catch(() => {})
    let siteId: number | undefined
    try { siteId = n.meta ? JSON.parse(n.meta).siteId : undefined } catch { /* no meta */ }
    setOpen(false)
    if (siteId) navigate(`/sites/${siteId}`)
    load()
  }

  const activator = (
    <button
      onClick={toggle}
      aria-label="Notifications"
      style={{ position: 'relative', background: 'none', border: 'none', cursor: 'pointer', padding: '0 14px', height: '100%', fontSize: 18, lineHeight: 1 }}
    >
      🔔
      {unread > 0 && (
        <span style={{
          position: 'absolute', top: 8, right: 8, minWidth: 16, height: 16, padding: '0 4px',
          borderRadius: 8, background: '#d72c0d', color: '#fff', fontSize: 10, lineHeight: '16px',
          textAlign: 'center', fontWeight: 700
        }}>
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  )

  return (
    <Popover active={open} activator={activator} onClose={() => setOpen(false)} preferredAlignment="right">
      <div style={{ width: 360, maxWidth: '90vw' }}>
        <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--oc-border, #e1e3e5)' }}>
          <InlineStack align="space-between" blockAlign="center">
            <Text as="span" fontWeight="semibold">Notifications</Text>
            <InlineStack gap="150">
              <Button variant="plain" onClick={markAllRead} disabled={unread === 0}>Mark all read</Button>
              <Button variant="plain" tone="critical" onClick={clearAll} disabled={items.length === 0}>Clear</Button>
            </InlineStack>
          </InlineStack>
        </div>
        <Scrollable style={{ maxHeight: 380 }}>
          {items.length === 0 ? (
            <div style={{ padding: '24px 14px', textAlign: 'center' }}>
              <Text as="p" tone="subdued">No notifications</Text>
            </div>
          ) : items.map((n) => (
            <div
              key={n.id}
              onClick={() => onClick(n)}
              style={{
                display: 'flex', gap: 10, padding: '10px 14px', cursor: 'pointer',
                background: n.read ? 'transparent' : 'rgba(92,106,196,0.06)',
                borderBottom: '1px solid var(--oc-border, #f1f1f1)'
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: DOT[n.level] ?? DOT.info, marginTop: 5, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text as="p" variant="bodySm" fontWeight={n.read ? 'regular' : 'semibold'}>{n.title}</Text>
                {n.body && <Text as="p" variant="bodySm" tone="subdued">{n.body}</Text>}
                <Text as="p" variant="bodySm" tone="subdued">{new Date(n.createdAt).toLocaleString()}</Text>
              </div>
            </div>
          ))}
        </Scrollable>
      </div>
    </Popover>
  )
}
