import { Text, Badge } from '@shopify/polaris'
import { Deployment } from '../api/client'

interface Props { deployments: Deployment[] }

const TONE: Record<string, string> = {
  success: '#47c1bf',
  failed: '#de3618',
  running: '#458fff',
  pending: '#f49342'
}

const DOT_SIZE = 12

export function DeployTimeline({ deployments }: Props) {
  if (deployments.length === 0) return null

  return (
    <div style={{ position: 'relative', paddingLeft: 28 }}>
      {/* Vertical line */}
      <div style={{
        position: 'absolute', left: DOT_SIZE / 2 - 1, top: 8,
        width: 2, height: `calc(100% - 16px)`,
        background: 'var(--p-color-border, #e1e3e5)'
      }} />

      {deployments.slice(0, 10).map((d, i) => {
        const color = TONE[d.status] ?? '#8c9196'
        const date  = new Date(d.createdAt)
        return (
          <div key={d.id} style={{ display: 'flex', gap: 16, marginBottom: i < deployments.length - 1 ? 20 : 0, position: 'relative' }}>
            {/* Dot */}
            <div style={{
              position: 'absolute', left: -(28 - DOT_SIZE / 2 + 1),
              top: 4,
              width: DOT_SIZE, height: DOT_SIZE, borderRadius: '50%',
              background: color, flexShrink: 0,
              boxShadow: d.status === 'running' ? `0 0 0 4px ${color}44` : 'none',
              animation: d.status === 'running' ? 'pulse 1.5s ease-in-out infinite' : 'none'
            }} />

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div>
                  <Badge tone={
                    d.status === 'success' ? 'success' :
                    d.status === 'failed'  ? 'critical' :
                    d.status === 'running' ? 'info' : 'warning'
                  }>{d.status}</Badge>
                  {' '}
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {d.branch}
                  </Text>
                  {d.commit && (
                    <Text as="span" variant="bodySm" tone="subdued">
                      {' '}@ <code style={{ fontSize: 11 }}>{d.commit.slice(0, 7)}</code>
                    </Text>
                  )}
                </div>
                <Text as="p" variant="bodySm" tone="subdued" breakWord={false}>
                  {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </Text>
              </div>
              {d.comment && (
                <Text as="p" variant="bodySm" tone="subdued">{d.comment}</Text>
              )}
            </div>
          </div>
        )
      })}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1 }
          50% { opacity: 0.4 }
        }
      `}</style>
    </div>
  )
}
