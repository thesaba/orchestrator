import { useEffect, useRef, useState } from 'react'
import { Banner, Button, InlineStack, Text } from '@shopify/polaris'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

interface Props {
  siteId: number
}

export function WebTerminal({ siteId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const xtermRef    = useRef<XTerm | null>(null)
  const wsRef       = useRef<WebSocket | null>(null)
  const fitRef      = useRef<FitAddon | null>(null)
  const [connected, setConnected] = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  function connect() {
    const token = localStorage.getItem('orchestrator_token')
    if (!token || !containerRef.current) return

    setError(null)

    const xterm = new XTerm({
      theme: { background: '#1a1a2e', foreground: '#e2e8f0', cursor: '#63b3ed' },
      fontSize: 13,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
      cursorBlink: true,
      scrollback: 2000
    })

    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(containerRef.current)
    fit.fit()
    xtermRef.current = xterm
    fitRef.current   = fit

    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${protocol}://${location.host}/api/terminal/${siteId}?token=${encodeURIComponent(token)}`)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data)
        if (msg.type === 'output') xterm.write(msg.data)
        if (msg.type === 'exit') {
          xterm.write(`\r\n\x1b[33m[session ended — exit code ${msg.exitCode}]\x1b[0m\r\n`)
          setConnected(false)
        }
        if (msg.error) {
          setError(msg.error)
          ws.close()
        }
      } catch { /* non-JSON — ignore */ }
    }

    ws.onclose = () => setConnected(false)
    ws.onerror = () => { setError('WebSocket connection failed'); setConnected(false) }

    xterm.onData((data: string) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }))
    })

    const ro = new ResizeObserver(() => {
      fit.fit()
      if (ws.readyState === WebSocket.OPEN) {
        const { cols, rows } = xterm
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })
    if (containerRef.current) ro.observe(containerRef.current)
  }

  function disconnect() {
    wsRef.current?.close()
    xtermRef.current?.dispose()
    xtermRef.current = null
    wsRef.current    = null
    setConnected(false)
  }

  useEffect(() => () => { disconnect() }, [])

  return (
    <div>
      <InlineStack gap="300" align="space-between" blockAlign="center">
        <Text as="h3" variant="headingSm">Web Terminal</Text>
        {connected
          ? <Button tone="critical" size="slim" onClick={disconnect}>Disconnect</Button>
          : <Button variant="primary" size="slim" onClick={connect}>Connect</Button>
        }
      </InlineStack>

      {error && (
        <div style={{ marginTop: 8 }}>
          <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>
        </div>
      )}

      <div
        ref={containerRef}
        style={{
          marginTop: 12,
          height: 400,
          background: '#1a1a2e',
          borderRadius: 8,
          padding: 8,
          display: connected ? 'block' : 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px solid #2d3748'
        }}
      >
        {!connected && (
          <Text as="p" tone="subdued">Click Connect to open a bash session in the site's current/ directory.</Text>
        )}
      </div>
    </div>
  )
}
