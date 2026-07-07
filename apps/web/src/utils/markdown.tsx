import { ReactNode } from 'react'

/**
 * Minimal, safe Markdown renderer for AI output.
 *
 * Deliberately tiny and allow-list based: it builds React elements directly
 * (never dangerouslySetInnerHTML), so there is no HTML-injection surface even
 * though the text comes from an LLM. Supports: fenced code blocks, headings,
 * unordered/ordered lists, blockquotes, and inline `code` / **bold** / *italic*.
 */

let keySeq = 0
const k = () => `md-${keySeq++}`

// Inline: `code`, **bold**, *italic*. Processed in that precedence order.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  // Split on inline code first so its contents are never re-parsed.
  const parts = text.split(/(`[^`]+`)/g)
  for (const part of parts) {
    if (!part) continue
    if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
      nodes.push(
        <code key={k()} style={{ background: 'rgba(0,0,0,0.06)', borderRadius: 4, padding: '1px 5px', fontSize: '0.9em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
          {part.slice(1, -1)}
        </code>
      )
      continue
    }
    // Bold then italic on the remaining plain text.
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g)
    for (const bp of boldParts) {
      if (!bp) continue
      if (bp.startsWith('**') && bp.endsWith('**')) {
        nodes.push(<strong key={k()}>{bp.slice(2, -2)}</strong>)
        continue
      }
      const italicParts = bp.split(/(\*[^*]+\*)/g)
      for (const ip of italicParts) {
        if (!ip) continue
        if (ip.startsWith('*') && ip.endsWith('*') && ip.length >= 2) {
          nodes.push(<em key={k()}>{ip.slice(1, -1)}</em>)
        } else {
          nodes.push(<span key={k()}>{ip}</span>)
        }
      }
    }
  }
  return nodes
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0

  const codeStyle: React.CSSProperties = {
    background: 'rgba(0,0,0,0.06)', borderRadius: 8, padding: 12, overflowX: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5, margin: '4px 0', whiteSpace: 'pre'
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block.
    if (/^```/.test(line.trim())) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) { buf.push(lines[i]); i++ }
      i++ // consume closing fence
      blocks.push(<pre key={k()} style={codeStyle}><code>{buf.join('\n')}</code></pre>)
      continue
    }

    // Heading.
    const h = line.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      blocks.push(
        <div key={k()} style={{ fontWeight: 600, fontSize: level <= 2 ? 15 : 13.5, margin: '6px 0 2px' }}>
          {renderInline(h[2])}
        </div>
      )
      i++
      continue
    }

    // Unordered list.
    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(<li key={k()}>{renderInline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>)
        i++
      }
      blocks.push(<ul key={k()} style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ul>)
      continue
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: ReactNode[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(<li key={k()}>{renderInline(lines[i].replace(/^\s*\d+\.\s+/, ''))}</li>)
        i++
      }
      blocks.push(<ol key={k()} style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ol>)
      continue
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
      blocks.push(
        <div key={k()} style={{ borderLeft: '3px solid rgba(0,0,0,0.2)', paddingLeft: 10, margin: '4px 0', color: 'var(--oc-text-subdued, #6d7175)' }}>
          {renderInline(buf.join(' '))}
        </div>
      )
      continue
    }

    // Blank line → spacing.
    if (line.trim() === '') { i++; continue }

    // Paragraph (gather consecutive plain lines).
    const buf: string[] = []
    while (
      i < lines.length && lines[i].trim() !== '' &&
      !/^```/.test(lines[i].trim()) && !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i])
    ) { buf.push(lines[i]); i++ }
    blocks.push(<p key={k()} style={{ margin: '4px 0', lineHeight: 1.5 }}>{renderInline(buf.join(' '))}</p>)
  }

  return <div>{blocks}</div>
}
