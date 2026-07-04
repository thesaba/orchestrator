import { BlockStack, Select, TextField, Text, Badge, InlineStack, Button } from '@shopify/polaris'
import { useEffect, useRef, useState } from 'react'
import { Site } from '../api/client'
import { consumeSSE } from '../utils/sse'
import { LogConsole } from './LogConsole'

interface Props {
  sites: Site[]
}

export function LogTailViewer({ sites }: Props) {
  const [siteId, setSiteId] = useState('')
  const [filter, setFilter] = useState('')
  const [paused, setPaused] = useState(false)
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
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
        <LogConsole
          lines={displayLines}
          minHeight={480}
          maxHeight={480}
          emptyText={!connected ? `Connecting to ${sites.find((s) => String(s.id) === siteId)?.domain} log…` : undefined}
        />
      )}

      {!siteId && (
        <LogConsole lines={[]} minHeight={200} maxHeight={200} emptyText="Select an active site to start tailing its Laravel log" />
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
