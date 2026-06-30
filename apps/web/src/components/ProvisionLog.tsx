import { Banner, BlockStack, InlineStack, ProgressBar, Text } from '@shopify/polaris'
import { useEffect, useRef, useState } from 'react'
import { consumeSSE } from '../utils/sse'

type RunStatus = 'running' | 'success' | 'error'

interface StepInfo {
  current: number
  total: number
  label: string
}

// Matches "[N/M] Some label..." anywhere in a log line
function parseStep(line: string): StepInfo | null {
  const m = line.match(/\[(\d+)\/(\d+)\]\s+(.+)/)
  if (!m) return null
  return {
    current: parseInt(m[1], 10),
    total:   parseInt(m[2], 10),
    label:   m[3].trim().replace(/\.\.\.$/, '')
  }
}

interface Props {
  endpoint: string
  onComplete?: (status: string) => void
}

export function ProvisionLog({ endpoint, onComplete }: Props) {
  const [lines, setLines]       = useState<string[]>([])
  const [runStatus, setRunStatus] = useState<RunStatus>('running')
  const [step, setStep]         = useState<StepInfo | null>(null)
  const terminalRef = useRef<HTMLDivElement>(null)
  const abortRef  = useRef<AbortController | null>(null)
  // Whether the user is (still) scrolled to the bottom of the log. Drives
  // "stick to tail" auto-scroll — but only within the log box itself, never
  // the page around it, and never while the user has scrolled up to read
  // earlier output.
  const stickToBottomRef = useRef(true)

  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl

    consumeSSE(
      endpoint,
      (msg) => {
        if (msg.line) {
          setLines((prev) => [...prev, msg.line!])
          const s = parseStep(msg.line)
          if (s) setStep(s)
        }
        if (msg.done) {
          const s = msg.status === 'active' || msg.status === 'success' ? 'success' : 'error'
          setRunStatus(s)
          onComplete?.(msg.status ?? s)
        }
      },
      ctrl.signal
    ).catch((err: unknown) => {
      if ((err as Error)?.name !== 'AbortError') {
        setLines((prev) => [...prev, `[connection error] ${(err as Error).message}`])
        setRunStatus('error')
      }
    })

    return () => ctrl.abort()
  }, [endpoint, onComplete])

  useEffect(() => {
    const el = terminalRef.current
    if (!el || !stickToBottomRef.current) return
    // Scroll only this box's own scroll container — not scrollIntoView,
    // which walks up every scrollable ancestor (including the page itself)
    // and was dragging the whole panel down on every new log line.
    el.scrollTop = el.scrollHeight
  }, [lines])

  const handleTerminalScroll = () => {
    const el = terminalRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 40
  }

  const progress = step ? Math.round((step.current / step.total) * 100) : 0

  return (
    <BlockStack gap="300">
      {runStatus === 'running' && (
        <BlockStack gap="150">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="p" variant="bodySm" tone="subdued">
              {step
                ? `Step ${step.current} of ${step.total}: ${step.label}`
                : 'Starting…'}
            </Text>
            {step && (
              <Text as="p" variant="bodySm" tone="subdued">{progress}%</Text>
            )}
          </InlineStack>
          {step ? (
            <ProgressBar progress={progress} size="small" />
          ) : (
            <ProgressBar size="small" animated />
          )}
        </BlockStack>
      )}

      <div
        ref={terminalRef}
        onScroll={handleTerminalScroll}
        className="oc-terminal"
        style={{
          fontSize: '12.5px',
          lineHeight: '1.6',
          minHeight: '200px',
          maxHeight: '440px',
          wordBreak: 'break-all'
        }}
      >
        {lines.join('')}
        {runStatus === 'running' && (
          <span style={{ opacity: 0.6, animation: 'blink 1s step-end infinite' }}>▋</span>
        )}
      </div>

      {runStatus !== 'running' && (
        <Banner tone={runStatus === 'success' ? 'success' : 'critical'}>
          {runStatus === 'success'
            ? 'Completed successfully!'
            : 'Failed — check the log above for details.'}
        </Banner>
      )}
    </BlockStack>
  )
}
