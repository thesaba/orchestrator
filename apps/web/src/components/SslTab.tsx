import {
  BlockStack,
  InlineStack,
  Text,
  Badge,
  Button,
  Banner,
  Spinner,
  Divider
} from '@shopify/polaris'
import { useEffect, useRef, useState } from 'react'
import { api, SslStatus } from '../api/client'
import { consumeSSE } from '../utils/sse'
import { LogConsole } from './LogConsole'

interface Props {
  siteId: number
}

type Op = 'issue' | 'renew' | 'remove' | null

export function SslTab({ siteId }: Props) {
  const [status, setStatus]   = useState<SslStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [op, setOp]           = useState<Op>(null)
  const [logs, setLogs]       = useState<string[]>([])
  const [error, setError]     = useState('')
  const abortRef              = useRef<AbortController | null>(null)

  const loadStatus = () => {
    setLoading(true)
    api.ssl.status(siteId)
      .then(setStatus)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { loadStatus() }, [siteId]) // eslint-disable-line

  const startOp = async (kind: Op) => {
    setError('')
    setLogs([])
    setOp(kind)

    try {
      if (kind === 'issue')  await api.ssl.issue(siteId)
      if (kind === 'renew')  await api.ssl.renew(siteId)
      if (kind === 'remove') {
        await api.ssl.remove(siteId)
        setOp(null)
        loadStatus()
        return
      }
    } catch (e: unknown) {
      setError((e as Error).message)
      setOp(null)
      return
    }

    // Stream certbot output
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort

    consumeSSE(
      `/api/sites/${siteId}/ssl/stream`,
      (msg) => {
        if (msg.line !== undefined) {
          setLogs((prev) => [...prev, msg.line as string])
        }
        if (msg.done) {
          setOp(null)
          loadStatus()
        }
      },
      abort.signal
    )
  }

  const cancelStream = () => {
    abortRef.current?.abort()
    setOp(null)
  }

  if (loading) {
    return (
      <InlineStack align="center" blockAlign="center" gap="300">
        <Spinner size="small" />
        <Text as="p" tone="subdued">Loading SSL status…</Text>
      </InlineStack>
    )
  }

  if (!status) return null

  const certTone = status.active
    ? (status.daysLeft !== null && status.daysLeft < 14 ? 'warning' : 'success')
    : 'critical'

  const certLabel = status.active
    ? (status.daysLeft !== null && status.daysLeft < 14 ? `Expires in ${status.daysLeft}d` : 'Active')
    : 'No certificate'

  return (
    <BlockStack gap="500">
      {/* ── Status card ──────────────────────────────────── */}
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">Certificate Status</Text>
          <Badge tone={certTone}>{certLabel}</Badge>
        </InlineStack>

        {status.active && (
          <BlockStack gap="150">
            {[
              { label: 'Issuer',   value: status.issuer ?? '—' },
              { label: 'Expires',  value: status.expiresAt ?? '—' },
              { label: 'Days left', value: status.daysLeft !== null ? String(status.daysLeft) : '—' }
            ].map(({ label, value }) => (
              <div key={label} style={{ display: 'flex', gap: 16 }}>
                <div style={{ width: 90, flexShrink: 0 }}>
                  <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
                </div>
                <Text as="span" variant="bodySm">{value}</Text>
              </div>
            ))}
          </BlockStack>
        )}
      </BlockStack>

      <Divider />

      {/* ── Actions ──────────────────────────────────────── */}
      {error && (
        <Banner tone="critical" onDismiss={() => setError('')}>
          <Text as="p">{error}</Text>
        </Banner>
      )}

      <InlineStack gap="300">
        {!status.active && (
          <Button
            variant="primary"
            onClick={() => startOp('issue')}
            loading={op === 'issue'}
            disabled={op !== null && op !== 'issue'}
          >
            Issue Certificate
          </Button>
        )}
        {status.active && (
          <Button
            onClick={() => startOp('renew')}
            loading={op === 'renew'}
            disabled={op !== null && op !== 'renew'}
          >
            Force Renew
          </Button>
        )}
        {status.active && (
          <Button
            tone="critical"
            variant="plain"
            onClick={() => startOp('remove')}
            disabled={op !== null}
          >
            Remove Certificate
          </Button>
        )}
        {op && op !== 'remove' && (
          <Button variant="plain" onClick={cancelStream}>
            Cancel stream
          </Button>
        )}
        {!op && (
          <Button variant="plain" onClick={loadStatus}>
            Refresh
          </Button>
        )}
      </InlineStack>

      {/* ── Certbot output terminal ───────────────────────── */}
      {logs.length > 0 && (
        <LogConsole lines={logs} minHeight={120} maxHeight={360} />
      )}
    </BlockStack>
  )
}
