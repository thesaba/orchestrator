import { BlockStack, InlineStack, Text, Button, Banner, TextField, Card, Badge } from '@shopify/polaris'
import { useEffect, useState, useCallback } from 'react'
import { api } from '../api/client'
import { useToast } from '../context/toast'

interface EnvVar { key: string; value: string; comment?: string }

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
    </BlockStack>
  )
}
