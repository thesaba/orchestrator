import { CSSProperties, useEffect, useMemo, useRef } from 'react'
import { LOG_COLORS, classifyLogLine } from '../utils/logColors'

const ANSI = /\x1b\[[0-9;]*m/g

// Flatten incoming SSE chunks (which may each hold several "\n"-separated lines
// or partial lines) into clean individual display lines, stripping ANSI color
// codes and carriage returns and dropping empty lines.
function toLines(entries: string[]): string[] {
  const out: string[] = []
  for (const entry of entries) {
    for (const part of entry.split('\n')) {
      const clean = part.replace(ANSI, '').replace(/\r/g, '')
      if (clean.length) out.push(clean)
    }
  }
  return out
}

interface Props {
  /** Raw log entries (SSE chunks or whole lines). */
  lines: string[]
  minHeight?: number
  maxHeight?: number
  /** Show a blinking cursor at the end (while a job is streaming). */
  running?: boolean
  /** Placeholder shown when there are no lines yet. */
  emptyText?: string
  style?: CSSProperties
}

/**
 * Shared terminal/log viewer. Two jobs:
 *  1. Colors each line via the common {@link LOG_COLORS} scheme.
 *  2. Sticks to the bottom as new lines arrive WITHOUT dragging the page — it
 *     scrolls only its own container (never `scrollIntoView`, which walks up
 *     every scrollable ancestor including the page) and pauses auto-scroll
 *     while the user has scrolled up to read earlier output.
 */
export function LogConsole({ lines, minHeight = 200, maxHeight = 440, running, emptyText, style }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  const display = useMemo(() => toLines(lines), [lines])

  useEffect(() => {
    const el = boxRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [display, running])

  const onScroll = () => {
    const el = boxRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div
      ref={boxRef}
      onScroll={onScroll}
      className="oc-terminal"
      style={{ minHeight, maxHeight, wordBreak: 'break-all', ...style }}
    >
      {display.length === 0 && emptyText && (
        <span style={LOG_COLORS.muted}>{emptyText}</span>
      )}
      {display.map((line, i) => (
        <div key={i} style={LOG_COLORS[classifyLogLine(line)]}>{line}</div>
      ))}
      {running && <span style={{ opacity: 0.6, animation: 'blink 1s step-end infinite' }}>▋</span>}
    </div>
  )
}
