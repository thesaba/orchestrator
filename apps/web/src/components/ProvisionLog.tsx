import { Banner, BlockStack, InlineStack, ProgressBar, Text } from '@shopify/polaris'
import { useEffect, useRef, useState } from 'react'
import { consumeSSE } from '../utils/sse'
import { LogConsole } from './LogConsole'

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
  const abortRef  = useRef<AbortController | null>(null)
  // Keep onComplete in a ref so a changing callback identity (e.g. an inline
  // `() => load()`) does NOT re-run the effect. Otherwise onComplete → parent
  // re-render → new identity → effect re-runs → reconnect → the server replays
  // the whole buffer → done fires again → infinite reconnect loop that ends on a
  // stray `done: idle` and falsely shows "Failed".
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete
  const doneRef = useRef(false)

  useEffect(() => {
    const ctrl = new AbortController()
    abortRef.current = ctrl
    doneRef.current = false

    consumeSSE(
      endpoint,
      (msg) => {
        if (msg.line) {
          setLines((prev) => [...prev, msg.line!])
          const s = parseStep(msg.line)
          if (s) setStep(s)
        }
        if (msg.done && !doneRef.current) {
          // `idle` means we connected after the run already finished with no
          // buffered emitter — treat as neutral (don't flip a fresh run to error).
          if (msg.status === 'idle') return
          doneRef.current = true
          const s = msg.status === 'active' || msg.status === 'success' ? 'success' : 'error'
          setRunStatus(s)
          onCompleteRef.current?.(msg.status ?? s)
        }
      },
      ctrl.signal
    ).catch((err: unknown) => {
      if ((err as Error)?.name !== 'AbortError' && !doneRef.current) {
        setLines((prev) => [...prev, `[connection error] ${(err as Error).message}`])
        setRunStatus('error')
      }
    })

    return () => ctrl.abort()
  }, [endpoint])

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

      <LogConsole lines={lines} running={runStatus === 'running'} minHeight={200} maxHeight={440} />


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
