import { useEffect, useState } from 'react'
import { sparklineApi } from '../api/client'

interface Props { siteId: number; width?: number; height?: number }

export function ResponseSparkline({ siteId, width = 80, height = 24 }: Props) {
  const [points, setPoints] = useState<{ ms: number | null; status: string }[]>([])

  useEffect(() => {
    sparklineApi.get(siteId).then(r => setPoints(r.points)).catch(() => {})
  }, [siteId])

  if (points.length < 2) return null

  const values = points.map(p => p.ms ?? 0)
  const max = Math.max(...values, 1)
  const w = width / points.length

  return (
    <svg width={width} height={height} style={{ verticalAlign: 'middle', overflow: 'visible' }}>
      {points.map((p, i) => {
        const h = Math.max(2, ((p.ms ?? 0) / max) * (height - 2))
        const fill = p.status === 'up' ? '#51cf66' : '#ff6b6b'
        return (
          <rect
            key={i}
            x={i * w + 1}
            y={height - h}
            width={Math.max(1, w - 2)}
            height={h}
            fill={fill}
            rx={1}
          />
        )
      })}
    </svg>
  )
}
