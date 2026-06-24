import { useState } from 'react'

interface Props { text: string }

export function HelpTooltip({ text }: Props) {
  const [visible, setVisible] = useState(false)

  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', verticalAlign: 'middle', marginLeft: 4 }}>
      <button
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
        onFocus={() => setVisible(true)}
        onBlur={() => setVisible(false)}
        style={{
          width: 16, height: 16, borderRadius: '50%',
          border: '1px solid var(--oc-border-input)',
          background: 'var(--oc-bg-secondary)',
          color: 'var(--oc-text-subdued)',
          fontSize: 10, fontWeight: 700,
          cursor: 'pointer', lineHeight: 1,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: 0
        }}
        aria-label="Help"
      >?</button>
      {visible && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%',
          transform: 'translateX(-50%)',
          marginBottom: 6, zIndex: 999,
          background: '#1a1a2e', color: '#fff',
          fontSize: 12, lineHeight: 1.5,
          padding: '6px 10px', borderRadius: 6,
          whiteSpace: 'nowrap', maxWidth: 260, wordBreak: 'break-word',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          pointerEvents: 'none'
        }}>
          {text}
        </div>
      )}
    </span>
  )
}
