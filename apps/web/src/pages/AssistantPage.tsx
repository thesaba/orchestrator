import { useEffect, useRef, useState, useCallback } from 'react'
import { Page, Card, BlockStack, InlineStack, Text, Button, Banner, Select, Spinner } from '@shopify/polaris'
import { useNavigate } from 'react-router-dom'
import { api, AiConfig, Site } from '../api/client'
import { Markdown } from '../utils/markdown'

type Msg = { role: 'user' | 'assistant'; content: string; error?: boolean }

const STARTERS = [
  'Why might a Laravel deploy fail after `composer install`?',
  'How do I safely roll back the last deployment?',
  'Recommended PHP-FPM pool settings for a busy Laravel site?',
  'How do I diagnose a 502 from nginx + PHP-FPM?'
]

/**
 * Free-form AI assistant. Admin-only, read-only/advisory. Optionally grounds
 * answers in a selected site's live context (status + recent unresolved errors,
 * all redacted server-side before leaving the panel).
 */
export function AssistantPage() {
  const navigate = useNavigate()
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [cfgLoaded, setCfgLoaded] = useState(false)
  const [sites, setSites] = useState<Pick<Site, 'id' | 'domain'>[]>([])
  const [siteId, setSiteId] = useState<string>('')
  const [msgs, setMsgs] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    api.ai.config().then(setCfg).catch(() => {}).finally(() => setCfgLoaded(true))
    api.sites.list().then((s) => setSites(s.map((x) => ({ id: x.id, domain: x.domain })))).catch(() => {})
  }, [])

  // Stick to bottom on new messages (scroll the box only, never the page).
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [msgs, busy])

  const send = useCallback(async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    setInput('')
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }))
    setMsgs((prev) => [...prev, { role: 'user', content: message }])
    setBusy(true)
    try {
      const r = await api.ai.chat(message, siteId ? Number(siteId) : undefined, history)
      setMsgs((prev) => [...prev, { role: 'assistant', content: r.reply }])
    } catch (e: unknown) {
      setMsgs((prev) => [...prev, { role: 'assistant', content: e instanceof Error ? e.message : 'AI request failed', error: true }])
    } finally {
      setBusy(false)
    }
  }, [busy, msgs, siteId])

  const notReady = cfgLoaded && (!cfg?.enabled || !cfg?.configured)

  return (
    <Page
      title="AI Assistant"
      subtitle="Ask about deploys, nginx, PHP-FPM, queues, SSL and errors. Read-only — it advises, never acts."
      secondaryActions={msgs.length ? [{ content: 'Clear chat', onAction: () => setMsgs([]) }] : undefined}
    >
      <BlockStack gap="400">
        {notReady && (
          <Banner tone="warning" title="AI assistant is not ready">
            <BlockStack gap="200">
              <Text as="p" variant="bodyMd">
                {cfg?.enabled ? 'No API key is configured yet.' : 'The AI assistant is currently disabled.'} Configure it in Settings → Integrations.
              </Text>
              <InlineStack>
                <Button onClick={() => navigate('/settings?tab=integrations')}>Open settings</Button>
              </InlineStack>
            </BlockStack>
          </Banner>
        )}

        <Card>
          <BlockStack gap="300">
            <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
              <div style={{ minWidth: 240 }}>
                <Select
                  label="Ground answers in a site (optional)"
                  labelInline
                  options={[{ label: 'No site context', value: '' }, ...sites.map((s) => ({ label: s.domain, value: String(s.id) }))]}
                  value={siteId}
                  onChange={setSiteId}
                />
              </div>
              {cfg && cfg.dailyLimit > 0 && (
                <Text as="span" variant="bodySm" tone="subdued">Usage today: {cfg.usageToday} / {cfg.dailyLimit}</Text>
              )}
            </InlineStack>

            {/* Conversation */}
            <div
              ref={scrollRef}
              style={{ maxHeight: '52vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 2px' }}
            >
              {msgs.length === 0 && (
                <div style={{ padding: '8px 2px' }}>
                  <Text as="p" variant="bodySm" tone="subdued">Try one of these to get started:</Text>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
                    {STARTERS.map((s) => (
                      <button
                        key={s}
                        onClick={() => send(s)}
                        disabled={notReady || busy}
                        style={{
                          textAlign: 'left', fontSize: 12.5, padding: '8px 10px', borderRadius: 8, cursor: notReady ? 'not-allowed' : 'pointer',
                          border: '1px solid var(--oc-border, #e1e3e5)', background: 'var(--oc-bg-secondary, #f6f6f7)', color: 'var(--oc-text, inherit)', maxWidth: 320
                        }}
                      >{s}</button>
                    ))}
                  </div>
                </div>
              )}

              {msgs.map((m, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                  <div
                    style={{
                      maxWidth: '85%', padding: '9px 12px', borderRadius: 12, fontSize: 13.5, lineHeight: 1.5,
                      background: m.role === 'user'
                        ? 'var(--oc-accent, #458fff)'
                        : m.error ? 'rgba(222,54,24,0.08)' : 'var(--oc-bg-secondary, #f6f6f7)',
                      color: m.role === 'user' ? '#fff' : m.error ? '#b02a1a' : 'var(--oc-text, inherit)',
                      border: m.role === 'user' ? 'none' : `1px solid ${m.error ? 'rgba(222,54,24,0.3)' : 'var(--oc-border, #e1e3e5)'}`,
                      whiteSpace: m.role === 'user' ? 'pre-wrap' : undefined
                    }}
                  >
                    {m.role === 'assistant' && !m.error ? <Markdown text={m.content} /> : m.content}
                  </div>
                </div>
              ))}

              {busy && (
                <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                  <div style={{ padding: '9px 12px', borderRadius: 12, background: 'var(--oc-bg-secondary, #f6f6f7)', border: '1px solid var(--oc-border, #e1e3e5)', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Spinner size="small" /> <Text as="span" variant="bodySm" tone="subdued">Thinking…</Text>
                  </div>
                </div>
              )}
            </div>

            {/* Composer */}
            <form
              onSubmit={(e) => { e.preventDefault(); send(input) }}
              style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}
            >
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
                placeholder={notReady ? 'Configure the AI assistant to start chatting…' : 'Ask anything… (Enter to send, Shift+Enter for a new line)'}
                disabled={notReady || busy}
                rows={2}
                style={{
                  flex: 1, resize: 'vertical', minHeight: 42, padding: '9px 12px', borderRadius: 8, fontSize: 13.5, fontFamily: 'inherit',
                  border: '1px solid var(--oc-border-input, #babfc3)', background: 'var(--oc-bg, #fff)', color: 'var(--oc-text, inherit)', outline: 'none'
                }}
              />
              <Button variant="primary" submit disabled={notReady || busy || !input.trim()}>Send</Button>
            </form>

            <Text as="p" variant="bodySm" tone="subdued">
              AI-generated advice — verify before applying. Content is redacted for secrets before it leaves the server, but review the privacy trade-off in Settings.
            </Text>
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  )
}
