import { FastifyInstance } from 'fastify'
import { readSecret } from './crypto'
import { getSetting } from './telegram'

export interface AiConfig {
  enabled: boolean
  provider: 'openai' | 'anthropic'
  model: string
  baseUrl: string
  apiKey: string
}

export async function getAiConfig(app: FastifyInstance): Promise<AiConfig> {
  const [enabled, provider, model, baseUrl, keyRaw] = await Promise.all([
    getSetting(app, 'ai_enabled'),
    getSetting(app, 'ai_provider'),
    getSetting(app, 'ai_model'),
    getSetting(app, 'ai_base_url'),
    getSetting(app, 'ai_api_key')
  ])
  const prov = provider === 'anthropic' ? 'anthropic' : 'openai'
  return {
    enabled: enabled === '1',
    provider: prov,
    model: model || (prov === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'),
    baseUrl: (baseUrl || (prov === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1')).replace(/\/+$/, ''),
    apiKey: readSecret(keyRaw)
  }
}

// ── Redaction ────────────────────────────────────────────────────────────────
// Scrub obvious secrets/PII BEFORE anything leaves the server for the LLM.
// Best-effort defence-in-depth — not a guarantee, so the feature stays opt-in.
export function redact(input: string): string {
  let s = input
  // Private key blocks.
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«REDACTED KEY»')
  // KEY=secret / KEY: secret where the key name looks sensitive.
  s = s.replace(/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|AUTH|CREDENTIAL)[A-Za-z0-9_]*)(\s*[:=]\s*)("?)([^\s"']+)\3/gi, '$1$2«REDACTED»')
  // JSON "password": "…" style.
  s = s.replace(/("(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization)"\s*:\s*)"[^"]*"/gi, '$1"«REDACTED»"')
  // Bearer tokens.
  s = s.replace(/\bBearer\s+[A-Za-z0-9._\-]{8,}/gi, 'Bearer «REDACTED»')
  // Credentials embedded in URLs (mysql://user:pass@…).
  s = s.replace(/(\/\/[^\s:@/]+):([^\s@/]+)@/g, '$1:«REDACTED»@')
  // AWS access key IDs.
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '«REDACTED»')
  // Mask email local parts.
  s = s.replace(/\b([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, '$1***@$2')
  return s
}

// Keep prompt input bounded (last N chars — the tail of a log is the useful bit).
export function clip(text: string, max = 6000): string {
  const t = text.length > max ? '…(truncated)…\n' + text.slice(-max) : text
  return t
}

// ── Usage / daily limit ──────────────────────────────────────────────────────
function today(): string { return new Date().toISOString().slice(0, 10) }

export async function todayUsage(app: FastifyInstance): Promise<number> {
  const row = await app.prisma.aiUsage.findUnique({ where: { date: today() } }).catch(() => null)
  return row?.count ?? 0
}

async function bumpUsage(app: FastifyInstance): Promise<void> {
  const d = today()
  await app.prisma.aiUsage.upsert({ where: { date: d }, create: { date: d, count: 1 }, update: { count: { increment: 1 } } }).catch(() => {})
}

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

// ── Provider call ────────────────────────────────────────────────────────────
export async function aiComplete(app: FastifyInstance, opts: { system: string; user?: string; messages?: ChatMessage[]; maxTokens?: number }): Promise<string> {
  const cfg = await getAiConfig(app)
  if (!cfg.enabled) throw Object.assign(new Error('AI assistant is disabled. Enable it in Settings → Integrations.'), { code: 400 })
  if (!cfg.apiKey) throw Object.assign(new Error('No AI API key configured.'), { code: 400 })

  const limit = Number((await getSetting(app, 'ai_daily_limit')) || '0')
  if (limit > 0 && (await todayUsage(app)) >= limit) {
    throw Object.assign(new Error(`Daily AI request limit reached (${limit}). Raise it in Settings → Integrations.`), { code: 429 })
  }

  const msgs: ChatMessage[] = opts.messages ?? [{ role: 'user', content: opts.user ?? '' }]
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45_000)
  try {
    let text: string
    if (cfg.provider === 'anthropic') {
      const res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: cfg.model, max_tokens: opts.maxTokens ?? 700, system: opts.system, messages: msgs })
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message ?? `AI request failed (${res.status})`)
      text = (data?.content?.[0]?.text ?? '').trim()
    } else {
      // OpenAI-compatible (OpenAI, Ollama, LocalAI, groq, …).
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: opts.maxTokens ?? 700,
          temperature: 0.2,
          messages: [{ role: 'system', content: opts.system }, ...msgs]
        })
      })
      const data: any = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error?.message ?? `AI request failed (${res.status})`)
      text = (data?.choices?.[0]?.message?.content ?? '').trim()
    }
    await bumpUsage(app)
    return text || 'No response.'
  } finally {
    clearTimeout(timer)
  }
}

export const SYSTEM_PROMPT =
  'You are a senior Laravel / PHP / DevOps engineer helping triage issues from a self-hosted server control panel. ' +
  'Be concise and practical. Give: (1) the likely root cause, (2) concrete fix steps, (3) a short code/command example only if clearly safe. ' +
  'Never invent secrets. If the input is ambiguous, say what extra info is needed. ' +
  'End with a one-line reminder that this is AI-generated advice to verify before applying.'

export const CHAT_SYSTEM_PROMPT =
  'You are the assistant inside Orchestrator, a self-hosted server control panel for PHP/Laravel sites. ' +
  'Help the admin operate their servers and sites: deploys, nginx, PHP-FPM, queues, databases, SSL, performance and errors. ' +
  'Be concise and practical. Use any CONTEXT provided about a site (status, recent errors) to ground your answer. ' +
  'You are read-only: you cannot run commands — suggest what the admin should do. Never invent secrets or data. ' +
  'If asked to do something destructive, warn clearly and recommend a backup first.'
