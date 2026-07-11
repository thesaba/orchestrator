import { useEffect, useState } from 'react'
import { healthApi } from '../api/client'

interface Props { siteId: number }

export function HealthScoreBadge({ siteId }: Props) {
  const [score, setScore] = useState<number | null>(null)
  const [suspended, setSuspended] = useState(false)
  const [breakdown, setBreakdown] = useState<{ uptime: number; deploy: number; ssl: number; maintenance: number } | null>(null)
  const [showTooltip, setShowTooltip] = useState(false)

  useEffect(() => {
    healthApi.score(siteId)
      .then(r => { setScore(r.score); setBreakdown(r.breakdown); setSuspended(!!r.suspended) })
      .catch(() => {})
  }, [siteId])

  if (score === null) return null

  // A billing-suspended site is shown as a plain red "Suspended" pill — never
  // a health score, so it can't read as green/healthy.
  if (suspended) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: '#ff6b6b22', color: '#ff6b6b', border: '1px solid #ff6b6b55',
        borderRadius: 20, padding: '2px 10px', fontSize: 12, fontWeight: 600, userSelect: 'none'
      }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#ff6b6b', display: 'inline-block' }} />
        Suspended — unpaid
      </span>
    )
  }

  const color = score >= 80 ? '#37b24d' : score >= 60 ? '#ffa94d' : '#ff6b6b'
  const label = score >= 80 ? 'Healthy' : score >= 60 ? 'Degraded' : 'Critical'

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          background: color + '22', color: color,
          border: `1px solid ${color}55`,
          borderRadius: 20, padding: '2px 10px',
          fontSize: 12, fontWeight: 600, cursor: 'default',
          userSelect: 'none'
        }}
      >
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: color, display: 'inline-block'
        }} />
        {score} — {label}
      </span>
      {showTooltip && breakdown && (
        <div style={{
          position: 'absolute', bottom: '100%', left: '50%',
          transform: 'translateX(-50%)', marginBottom: 6, zIndex: 999,
          background: '#1a1a2e', color: '#fff',
          fontSize: 12, padding: '8px 12px', borderRadius: 6,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          whiteSpace: 'nowrap'
        }}>
          <div>Uptime: {breakdown.uptime}/40</div>
          <div>Last deploy: {breakdown.deploy}/30</div>
          <div>SSL: {breakdown.ssl}/20</div>
          <div>Maintenance: {breakdown.maintenance}/10</div>
        </div>
      )}
    </span>
  )
}
