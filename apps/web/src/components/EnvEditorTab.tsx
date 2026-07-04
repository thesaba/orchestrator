import { BlockStack, InlineStack, Text, Button, Banner, TextField, Card, Badge, Modal, Spinner } from '@shopify/polaris'
import { useEffect, useState, useCallback } from 'react'
import { api, EnvVersionMeta } from '../api/client'
import { useToast } from '../context/toast'

interface EnvVar { key: string; value: string; comment?: string }

type DiffEntry = { type: 'same' | 'add' | 'del'; text: string }

// Minimal LCS line diff of `current` → `version`: `del` = lines only in the
// current file (removed on restore), `add` = lines the version would bring in.
function diffLines(current: string, version: string): DiffEntry[] {
  const a = current.split('\n'), b = version.split('\n')
  const m = a.length, n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: DiffEntry[] = []
  let i = 0, j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i++ }
    else { out.push({ type: 'add', text: b[j] }); j++ }
  }
  while (i < m) out.push({ type: 'del', text: a[i++] })
  while (j < n) out.push({ type: 'add', text: b[j++] })
  return out
}

function parseEnv(raw: string): EnvVar[] {
  return raw.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return null
    const eq = trimmed.indexOf('=')
    if (eq < 0) return null
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^["'](.*)["']$/, '$1')
    return { key, value: val }
  }).filter(Boolean) as EnvVar[]
}

function serializeEnv(vars: EnvVar[], original: string): string {
  // Preserve comments and blank lines from original, update values
  const lookup: Record<string, string> = {}
  for (const v of vars) lookup[v.key] = v.value

  const lines = original.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    const eq = trimmed.indexOf('=')
    if (eq < 0) return line
    const key = trimmed.slice(0, eq).trim()
    if (key in lookup) {
      const val = lookup[key]
      const needsQuote = val.includes(' ') || val.includes('#') || val.includes('"') || val === ''
      return `${key}=${needsQuote ? `"${val.replace(/"/g, '\\"')}"` : val}`
    }
    return line
  })

  // Append new keys that weren't in the original
  const originalKeys = new Set(
    original.split('\n').map((line) => {
      const eq = line.indexOf('=')
      return eq >= 0 ? line.slice(0, eq).trim() : null
    }).filter(Boolean)
  )
  for (const v of vars) {
    if (!originalKeys.has(v.key)) {
      lines.push(`${v.key}=${v.value}`)
    }
  }

  return lines.join('\n')
}

const SENSITIVE_KEYS = new Set(['APP_KEY', 'DB_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'MAIL_PASSWORD', 'JWT_SECRET', 'SECRET'])

export function EnvEditorTab({ siteId }: { siteId: number }) {
  const [raw,       setRaw]       = useState('')
  const [vars,      setVars]      = useState<EnvVar[]>([])
  const [loading,   setLoading]   = useState(true)
  const [saving,    setSaving]    = useState(false)
  const [error,     setError]     = useState('')
  const [search,    setSearch]    = useState('')
  const [revealed,  setRevealed]  = useState<Set<string>>(new Set())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [versions,  setVersions]  = useState<EnvVersionMeta[]>([])
  const [loadingV,  setLoadingV]  = useState(false)
  const [diff,      setDiff]      = useState<{ vid: number; entries: DiffEntry[] } | null>(null)
  const [restoring, setRestoring] = useState(false)
  const showToast = useToast()

  useEffect(() => {
    api.config.getEnv(siteId)
      .then((r) => { setRaw(r.content); setVars(parseEnv(r.content)) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [siteId])

  const updateVar = useCallback((key: string, value: string) => {
    setVars((prev) => prev.map((v) => v.key === key ? { ...v, value } : v))
  }, [])

  const addVar = () => {
    setVars((prev) => [...prev, { key: 'NEW_KEY', value: '' }])
  }

  const removeVar = (key: string) => {
    setVars((prev) => prev.filter((v) => v.key !== key))
    setRaw((prev) => prev.split('\n').filter((l) => !l.startsWith(key + '=')).join('\n'))
  }

  const save = async () => {
    setSaving(true); setError('')
    try {
      const content = serializeEnv(vars, raw)
      await api.config.saveEnv(siteId, content)
      setRaw(content)
      showToast('.env saved')
    } catch (e: unknown) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  const openHistory = async () => {
    setHistoryOpen(true); setDiff(null); setLoadingV(true)
    try { const r = await api.config.envVersions(siteId); setVersions(r.versions) }
    catch { showToast('Failed to load history', { error: true }) }
    finally { setLoadingV(false) }
  }

  const viewDiff = async (vid: number) => {
    try {
      const r = await api.config.envVersion(siteId, vid)
      setDiff({ vid, entries: diffLines(raw, r.content) })
    } catch { showToast('Failed to load version', { error: true }) }
  }

  const restore = async (vid: number) => {
    if (!confirm('Restore this .env version? Current values are replaced (a snapshot of the current file is saved first). Re-deploy to apply.')) return
    setRestoring(true)
    try {
      const r = await api.config.restoreEnvVersion(siteId, vid)
      setRaw(r.content); setVars(parseEnv(r.content))
      showToast('.env restored — re-deploy to apply')
      setHistoryOpen(false); setDiff(null)
    } catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Restore failed', { error: true }) }
    finally { setRestoring(false) }
  }

  const toggleReveal = (key: string) => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const filtered = search
    ? vars.filter((v) => v.key.toLowerCase().includes(search.toLowerCase()) || v.value.toLowerCase().includes(search.toLowerCase()))
    : vars

  const isSensitive = (key: string) => SENSITIVE_KEYS.has(key) || key.toLowerCase().includes('secret') || key.toLowerCase().includes('password') || key.toLowerCase().includes('key')

  const groups: Record<string, EnvVar[]> = {}
  for (const v of filtered) {
    const g = v.key.split('_')[0] ?? 'OTHER'
    ;(groups[g] ??= []).push(v)
  }

  if (loading) return <Text as="p" tone="subdued">Loading .env…</Text>

  return (
    <BlockStack gap="500">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">.env Visual Editor</Text>
        <InlineStack gap="200">
          <Button onClick={openHistory}>History</Button>
          <Button onClick={addVar}>Add Variable</Button>
          <Button variant="primary" onClick={save} loading={saving}>Save .env</Button>
        </InlineStack>
      </InlineStack>

      <Text as="p" variant="bodySm" tone="subdued">
        Changes take effect on the next deploy. Sensitive values are masked by default.
      </Text>

      {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

      <TextField label="" placeholder="Search variables…" value={search} onChange={setSearch} autoComplete="off" />

      {Object.entries(groups).map(([group, groupVars]) => (
        <Card key={group}>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm" tone="subdued">{group}</Text>
            {groupVars.map((v) => {
              const sensitive = isSensitive(v.key)
              const show = !sensitive || revealed.has(v.key)
              return (
                <div key={v.key} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                  <div style={{ flex: '0 0 220px' }}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">
                      {v.key}
                      {sensitive && <Badge tone="warning" size="small"> sensitive</Badge>}
                    </Text>
                  </div>
                  <div style={{ flex: 1 }}>
                    <input
                      type={show ? 'text' : 'password'}
                      value={v.value}
                      onChange={(e) => updateVar(v.key, e.target.value)}
                      className="oc-env-input"
                    />
                  </div>
                  {sensitive && (
                    <button
                      onClick={() => toggleReveal(v.key)}
                      title={show ? 'Hide' : 'Show'}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', fontSize: 16 }}
                    >
                      {show ? '🙈' : '👁'}
                    </button>
                  )}
                  <button
                    onClick={() => removeVar(v.key)}
                    title="Remove"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '6px', fontSize: 16, color: 'var(--oc-remove-color)' }}
                  >
                    ✕
                  </button>
                </div>
              )
            })}
          </BlockStack>
        </Card>
      ))}

      {filtered.length === 0 && (
        <Text as="p" tone="subdued">No variables match "{search}"</Text>
      )}

      <Modal
        open={historyOpen}
        onClose={() => { setHistoryOpen(false); setDiff(null) }}
        title={diff ? 'Changes if restored' : '.env history'}
        secondaryActions={diff
          ? [{ content: '← Back', onAction: () => setDiff(null) }]
          : [{ content: 'Close', onAction: () => { setHistoryOpen(false); setDiff(null) } }]}
        primaryAction={diff ? { content: 'Restore this version', destructive: true, loading: restoring, onAction: () => restore(diff.vid) } : undefined}
      >
        <Modal.Section>
          {loadingV ? (
            <InlineStack align="center"><Spinner size="small" /></InlineStack>
          ) : diff ? (
            diff.entries.every((e) => e.type === 'same') ? (
              <Text as="p" tone="subdued">Identical to the current .env — nothing would change.</Text>
            ) : (
              <div className="oc-terminal" style={{ maxHeight: 360, fontSize: 12.5 }}>
                {diff.entries.map((e, i) => (
                  <div key={i} style={{
                    color: e.type === 'add' ? '#3fb950' : e.type === 'del' ? '#ff6b6b' : '#8b949e',
                    background: e.type === 'add' ? 'rgba(63,185,80,0.08)' : e.type === 'del' ? 'rgba(255,107,107,0.08)' : 'transparent',
                    whiteSpace: 'pre-wrap', wordBreak: 'break-all'
                  }}>
                    {e.type === 'add' ? '+ ' : e.type === 'del' ? '- ' : '  '}{e.text}
                  </div>
                ))}
              </div>
            )
          ) : versions.length === 0 ? (
            <Text as="p" tone="subdued">No saved versions yet. Each time you save the .env from here, a snapshot is kept.</Text>
          ) : (
            <BlockStack gap="200">
              {versions.map((v) => (
                <InlineStack key={v.id} align="space-between" blockAlign="center" wrap>
                  <BlockStack gap="050">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" fontWeight="semibold">{new Date(v.createdAt).toLocaleString()}</Text>
                      {v.note && <Badge>{v.note}</Badge>}
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued">{v.createdBy?.email ?? 'system'}</Text>
                  </BlockStack>
                  <InlineStack gap="150">
                    <Button size="micro" onClick={() => viewDiff(v.id)}>View changes</Button>
                    <Button size="micro" tone="critical" variant="tertiary" onClick={() => restore(v.id)}>Restore</Button>
                  </InlineStack>
                </InlineStack>
              ))}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}
