import { Card, BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris'
import { RefreshIcon } from '@shopify/polaris-icons'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ServiceStatus } from '../api/client'
import { consumeSSE } from '../utils/sse'
import { LogConsole } from './LogConsole'

interface Props {
  services: ServiceStatus[]
  onRefresh: () => void
}

type Action = 'start' | 'stop' | 'restart'

function StatusDot({ active }: { active: boolean }) {
  return (
    <div
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: active ? '#00a047' : '#d72c0d',
        boxShadow: active ? '0 0 0 2px #c9f0d5' : '0 0 0 2px #ffd2cd'
      }}
    />
  )
}

function ServiceRow({ svc, onRefresh }: { svc: ServiceStatus; onRefresh: () => void }) {
  const [controlling, setControlling] = useState<Action | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [logLines, setLogLines] = useState<string[]>([])
  const sseAbortRef = useRef<AbortController | null>(null)

  const handleControl = useCallback(async (action: Action) => {
    setControlling(action)
    setResult(null)
    try {
      const res = await api.monitor.control(svc.key, action)
      setResult({ ok: res.ok, text: res.output || `${action} ${res.ok ? 'succeeded' : 'failed'}` })
      onRefresh()
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setControlling(null)
    }
  }, [svc.key, onRefresh])

  useEffect(() => {
    if (!showLogs) {
      sseAbortRef.current?.abort()
      sseAbortRef.current = null
      setLogLines([])
      return
    }
    const ctrl = new AbortController()
    sseAbortRef.current = ctrl
    consumeSSE(
      `/api/monitor/services/${encodeURIComponent(svc.key)}/logs`,
      (msg) => { if (msg.line) setLogLines(prev => [...prev.slice(-300), msg.line as string]) },
      ctrl.signal
    ).catch(() => {})
    return () => ctrl.abort()
  }, [showLogs, svc.key])

  const isActive = svc.status === 'active'

  return (
    <BlockStack gap="200">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 0',
          minWidth: 0
        }}
      >
        <StatusDot active={isActive} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {svc.name}
          </Text>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 6,
            flexShrink: 0,
            flexWrap: 'wrap',
            justifyContent: 'flex-end'
          }}
        >
          {isActive ? (
            <Button
              size="micro"
              tone="critical"
              loading={controlling === 'stop'}
              disabled={controlling !== null}
              onClick={() => handleControl('stop')}
            >
              Stop
            </Button>
          ) : (
            <Button
              size="micro"
              variant="primary"
              loading={controlling === 'start'}
              disabled={controlling !== null}
              onClick={() => handleControl('start')}
            >
              Start
            </Button>
          )}
          <Button
            size="micro"
            loading={controlling === 'restart'}
            disabled={controlling !== null}
            onClick={() => handleControl('restart')}
          >
            Restart
          </Button>
          <Button
            size="micro"
            variant={showLogs ? 'primary' : 'secondary'}
            onClick={() => setShowLogs(v => !v)}
          >
            {showLogs ? 'Hide logs' : 'Logs'}
          </Button>
        </div>
      </div>

      {result && (
        <Banner tone={result.ok ? 'success' : 'critical'} onDismiss={() => setResult(null)}>
          <pre style={{ margin: 0, fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
            {result.text || (result.ok ? 'Done.' : 'Failed.')}
          </pre>
        </Banner>
      )}

      {showLogs && (
        <LogConsole
          lines={logLines}
          minHeight={160}
          maxHeight={160}
          emptyText={`Connecting to journalctl -u ${svc.key}…`}
        />
      )}
    </BlockStack>
  )
}

export function ServiceControlCard({ services, onRefresh }: Props) {
  return (
    <Card>
      <BlockStack gap="200">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Services</Text>
          <Button
            icon={RefreshIcon}
            variant="plain"
            accessibilityLabel="Refresh services"
            onClick={onRefresh}
          />
        </InlineStack>

        {services.length === 0 ? (
          <Text as="p" tone="subdued">Loading…</Text>
        ) : (
          <div>
            {services.map((svc, i) => (
              <div
                key={svc.key}
                style={{ borderTop: i > 0 ? '1px solid #e1e3e5' : undefined }}
              >
                <ServiceRow svc={svc} onRefresh={onRefresh} />
              </div>
            ))}
          </div>
        )}
      </BlockStack>
    </Card>
  )
}
