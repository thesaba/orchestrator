import { useEffect, useState, useMemo } from 'react'
import { Text } from '@shopify/polaris'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'

interface Action {
  id: string
  label: string
  subtitle?: string
  icon: string
  onSelect: () => void
}

interface Props {
  open: boolean
  onClose: () => void
}

export function CommandPalette({ open, onClose }: Props) {
  const [query,   setQuery]   = useState('')
  const [sites,   setSites]   = useState<{ id: number; domain: string; name: string }[]>([])
  const [active,  setActive]  = useState(0)
  const navigate = useNavigate()

  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      api.sites.list().then((s) => setSites(s.map((x) => ({ id: x.id, domain: x.domain, name: x.name })))).catch(() => {})
    }
  }, [open])

  const staticActions: Action[] = useMemo(() => [
    { id: 'dash',       label: 'Dashboard',         icon: '🏠', onSelect: () => navigate('/') },
    { id: 'sites',      label: 'Sites',              icon: '🌐', onSelect: () => navigate('/sites') },
    { id: 'monitoring', label: 'Monitoring',         icon: '📊', onSelect: () => navigate('/monitoring') },
    { id: 'settings',   label: 'Settings',           icon: '⚙️', onSelect: () => navigate('/settings') },
    { id: 'new-site',   label: 'New Site',           subtitle: 'Create a new site', icon: '➕', onSelect: () => navigate('/sites/new') }
  ], [navigate])

  const siteActions: Action[] = useMemo(() =>
    sites.map((s) => ({
      id: `site-${s.id}`,
      label: s.name,
      subtitle: s.domain,
      icon: '🔗',
      onSelect: () => navigate(`/sites/${s.id}`)
    })),
    [sites, navigate]
  )

  const allActions = [...staticActions, ...siteActions]

  const filtered = query
    ? allActions.filter((a) =>
        a.label.toLowerCase().includes(query.toLowerCase()) ||
        (a.subtitle ?? '').toLowerCase().includes(query.toLowerCase())
      )
    : allActions

  useEffect(() => { setActive(0) }, [query])

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((p) => Math.min(p + 1, filtered.length - 1)) }
      if (e.key === 'ArrowUp')   { e.preventDefault(); setActive((p) => Math.max(p - 1, 0)) }
      if (e.key === 'Enter') {
        e.preventDefault()
        const item = filtered[active]
        if (item) { item.onSelect(); onClose() }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, filtered, active, onClose])

  if (!open) return null

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        paddingTop: '15vh'
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%', maxWidth: 560,
          background: 'var(--p-color-bg-surface)',
          borderRadius: 12, overflow: 'hidden',
          boxShadow: '0 25px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(0,0,0,0.08)',
          border: '1px solid var(--oc-border)'
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid var(--oc-border)' }}>
          <span style={{ fontSize: 18 }}>🔍</span>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search pages, sites, actions…"
            style={{
              flex: 1, border: 'none', outline: 'none', fontSize: 16,
              background: 'transparent',
              color: 'var(--p-color-text)'
            }}
          />
          <kbd style={{
            fontSize: 11, padding: '2px 6px', borderRadius: 4,
            background: 'var(--oc-bg-secondary)',
            border: '1px solid var(--oc-border)',
            color: 'var(--oc-text-subdued)'
          }}>ESC</kbd>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center' }}>
              <Text as="p" tone="subdued">No results for "{query}"</Text>
            </div>
          ) : (
            filtered.map((item, i) => (
              <div
                key={item.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 16px', cursor: 'pointer',
                  background: i === active ? 'var(--oc-bg-secondary)' : 'transparent',
                  borderLeft: i === active ? '3px solid var(--oc-accent)' : '3px solid transparent'
                }}
                onMouseEnter={() => setActive(i)}
                onClick={() => { item.onSelect(); onClose() }}
              >
                <span style={{ fontSize: 20, flexShrink: 0 }}>{item.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--p-color-text)' }}>
                    {item.label}
                  </div>
                  {item.subtitle && (
                    <div style={{ fontSize: 12, color: 'var(--p-color-text-subdued, #6d7175)', marginTop: 1 }}>
                      {item.subtitle}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div style={{
          padding: '8px 16px', borderTop: '1px solid var(--oc-border)',
          display: 'flex', gap: 16, fontSize: 11, color: 'var(--oc-text-subdued)'
        }}>
          <span><kbd>↑↓</kbd> Navigate</span>
          <span><kbd>↵</kbd> Open</span>
          <span><kbd>ESC</kbd> Close</span>
        </div>
      </div>
    </div>
  )
}
