import { BlockStack, Select, TextField, Text, Badge, InlineStack, Button } from '@shopify/polaris'
import { useEffect, useRef, useState } from 'react'
import { Site } from '../api/client'
import { consumeSSE } from '../utils/sse'

const LOG_LEVEL_STYLES: Record<string, React.CSSProperties> = {
  error:   { color: '#ff6b6b', fontWeight: 'bold' },
  critical:{ color: '#ff4444', fontWeight: 'bold' },
  warning: { color: '#ffd93d' },
  alert:   { color: '#ffa500' },
  debug:   { color: '#6b8aaa' },
  info:    { color: '#98c379' },
  default: { color: '#e6edf3' }
}

function detectLevel(line: string): keyof typeof LOG_LEVEL_STYLES {
  const upper = line.toUpperCase()
  if (upper.includes('.CRITICAL') || upper.includes('CRITICAL:')) return 'critical'
  if (upper.includes('.ERROR') || upper.includes('ERROR:') || upper.includes('EXCEPTION') || upper.includes('SQLSTATE')) return 'error'
  if (upper.includes('.ALERT')) return 'alert'
  if (upper.includes('.WARNING')) return 'warning'
  if (upper.includes('.DEBUG')) return 'debug'
  if (upper.includes('.INFO')) return 'info'
  return 'default'
}

interface Props {
  sites: Site[]
}

export function LogTailViewer({ sites }: Props) {
  const [siteId, setSiteId] = useState('')
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!siteId) return
    setLines([])
    setConnected(false)

    const ctrl = new AbortController()

    consumeSSE(
      `/api/monitor/logs/${siteId}/stream`,
      (msg) => {
        if (msg.line && !pausedRef.current) {
          setLines((prev) => [...prev.slice(-800), msg.line as string])
        }
        if (msg.error) {
          setLines((prev) => [...prev, `[stream error] ${msg.error as string}\n`])
        }
        setConnected(true)
      },
      ctrl.signal
    ).catch(() => setConnected(false))

    return () => ctrl.abort()
  }, [siteId])

  // Auto-scroll unless paused
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, paused])

  const displayLines = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines

  const siteOptions = [
    { label: 'Select a site…', value: '' },
    ...sites
      .filter((s) => s.status === 'active')
      .map((s) => ({ label: s.domain, value: String(s.id) }))
  ]

  return (
    <BlockStack gap="400">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '12px',
          alignItems: 'end'
        }}
      >
        <Select
          label="Site"
          options={siteOptions}
          value={siteId}
          onChange={(v) => { setSiteId(v); setFilter('') }}
        />
        <TextField
          label="Filter"
          value={filter}
          onChange={setFilter}
          placeholder="error, exception, …"
          autoComplete="off"
          disabled={!siteId}
        />
        <div style={{ paddingTop: '22px' }}>
          <Button onClick={() => setPaused((p) => !p)} disabled={!siteId}>
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      {siteId && (
        <div
          style={{
            background: '#0d1117',
            borderRadius: '8px',
            border: '1px solid #21262d',
            height: '480px',
            overflowY: 'auto',
            fontFamily: '"JetBrains Mono", "Fira Code", monospace',
            fontSize: '12px',
            lineHeight: '1.7',
            padding: '12px 16px'
          }}
        >
          {!connected && (
            <Text as="p" tone="subdued">
              Connecting to {sites.find((s) => String(s.id) === siteId)?.domain} log…
            </Text>
          )}
          {displayLines.map((line, i) => {
            const level = detectLevel(line)
            return (
              <div key={i} style={LOG_LEVEL_STYLES[level]}>
                {line}
              </div>
            )
          })}
          {!paused && <div ref={bottomRef} />}
        </div>
      )}

      {!siteId && (
        <div
          style={{
            background: '#0d1117',
            borderRadius: '8px',
            border: '1px solid #21262d',
            height: '200px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Text as="p" tone="subdued">
            Select an active site to start tailing its Laravel log
          </Text>
        </div>
      )}

      {siteId && (
        <InlineStack gap="300">
          {connected && <Badge tone="success">Live</Badge>}
          {paused && <Badge tone="warning">Paused</Badge>}
          <Text as="p" variant="bodySm" tone="subdued">
            {displayLines.length} line{displayLines.length !== 1 ? 's' : ''}
            {filter ? ` matching "${filter}"` : ' (last 800)'}
          </Text>
          <Button size="micro" variant="plain" onClick={() => setLines([])}>
            Clear
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  )
}
