import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

export function QuickActionsFab() {
  const [open, setOpen] = useState(false)
  const navigate = useNavigate()

  const actions = [
    { label: 'Add site',    emoji: '🌐', path: '/sites/new' },
    { label: 'Monitoring',  emoji: '📊', path: '/monitoring' },
    { label: 'Settings',    emoji: '⚙️',  path: '/settings' },
  ]

  return (
    <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 500 }}>
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8, alignItems: 'flex-end' }}>
          {actions.map((a) => (
            <button
              key={a.path}
              onClick={() => { setOpen(false); navigate(a.path) }}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: 'var(--p-color-bg-surface)',
                border: '1px solid var(--oc-border)',
                borderRadius: 20, padding: '6px 14px',
                cursor: 'pointer', fontSize: 13, fontWeight: 500,
                boxShadow: '0 2px 8px rgba(0,0,0,.12)',
                whiteSpace: 'nowrap'
              }}
            >
              <span>{a.emoji}</span>
              {a.label}
            </button>
          ))}
        </div>
      )}
      <button
        onClick={() => setOpen((p) => !p)}
        title="Quick actions"
        style={{
          width: 48, height: 48, borderRadius: '50%',
          background: 'var(--oc-accent)', color: '#fff',
          border: 'none', cursor: 'pointer', fontSize: 22,
          boxShadow: '0 4px 12px rgba(69,143,255,.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'transform .15s',
          transform: open ? 'rotate(45deg)' : 'rotate(0deg)'
        }}
      >
        +
      </button>
    </div>
  )
}
