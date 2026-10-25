import { Page, Card, BlockStack, InlineStack, Text, Badge, DataTable, Select, TextField, Button, Spinner, Box } from '@shopify/polaris'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { mcpActivityApi, McpActivityItem, McpActivitySummary } from '../api/client'

const TYPE_OPTS = [
  { label: 'All activity', value: '' },
  { label: 'Actions only', value: 'write' },
  { label: 'Reads only', value: 'read' }
]

export function AiActivityPage() {
  const [items, setItems]     = useState<McpActivityItem[]>([])
  const [summary, setSummary] = useState<McpActivitySummary | null>(null)
  const [tokens, setTokens]   = useState<Array<{ tokenId: number | null; tokenName: string | null }>>([])
  const [tools, setTools]     = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  // filters
  const [tokenId, setTokenId] = useState('')
  const [type, setType]       = useState('')
  const [tool, setTool]       = useState('')
  const [q, setQ]             = useState('')

  useEffect(() => {
    mcpActivityApi.filters().then((r) => { setTokens(r.tokens); setTools(r.tools) }).catch(() => {})
  }, [])

  const load = useCallback(() => {
    setLoading(true)
    mcpActivityApi.list({
      tokenId: tokenId ? Number(tokenId) : undefined,
      type: (type || undefined) as 'read' | 'write' | undefined,
      tool: tool || undefined,
      q: q.trim() || undefined,
      limit: 200
    })
      .then((r) => { setItems(r.items); setSummary(r.summary) })
      .catch(() => { setItems([]); setSummary(null) })
      .finally(() => setLoading(false))
  }, [tokenId, type, tool, q])

  useEffect(() => { load() }, [load])

  const tokenOpts = useMemo(() => [
    { label: 'All AIs / tokens', value: '' },
    ...tokens.map((t) => ({ label: t.tokenName ?? `#${t.tokenId}`, value: String(t.tokenId ?? '') }))
  ], [tokens])

  const toolOpts = useMemo(() => [
    { label: 'All tools', value: '' },
    ...tools.map((t) => ({ label: t, value: t }))
  ], [tools])

  const rows = items.map((a) => [
    new Date(a.createdAt).toLocaleString(),
    a.tokenName ?? '—',
    a.tool ? <code style={{ fontSize: 12 }}>{a.tool}</code> : <Text as="span" tone="subdued" variant="bodySm">(no tool)</Text>,
    <InlineStack gap="150" blockAlign="center">
      <Badge tone={a.method === 'GET' ? undefined : 'attention'}>{a.method}</Badge>
      <Text as="span" variant="bodySm" tone="subdued">{a.path}</Text>
    </InlineStack>,
    a.siteId != null ? String(a.siteId) : '—',
    <Badge tone={a.ok ? 'success' : 'critical'}>{String(a.status)}</Badge>,
    a.durationMs != null ? `${a.durationMs} ms` : '—'
  ])

  return (
    <Page
      title="AI Activity"
      subtitle="Everything MCP / AI clients did via Personal Access Tokens — reads and actions."
      primaryAction={{ content: 'Refresh', onAction: load, loading }}
    >
      <BlockStack gap="400">
        {summary && (
          <Card>
            <InlineStack gap="600" wrap>
              {[
                { label: 'Requests (24h)', value: summary.last24h },
                { label: 'Actions (24h)', value: summary.actions24h },
                { label: 'Errors (24h)', value: summary.errors24h }
              ].map((s) => (
                <BlockStack gap="050" key={s.label}>
                  <Text as="span" variant="bodySm" tone="subdued">{s.label}</Text>
                  <Text as="span" variant="headingLg">{s.value}</Text>
                </BlockStack>
              ))}
            </InlineStack>
          </Card>
        )}

        <Card>
          <InlineStack gap="300" wrap blockAlign="end">
            <div style={{ minWidth: 200 }}>
              <Select label="AI / token" options={tokenOpts} value={tokenId} onChange={setTokenId} />
            </div>
            <div style={{ minWidth: 160 }}>
              <Select label="Type" options={TYPE_OPTS} value={type} onChange={setType} />
            </div>
            <div style={{ minWidth: 180 }}>
              <Select label="Tool" options={toolOpts} value={tool} onChange={setTool} />
            </div>
            <div style={{ flex: 1, minWidth: 180 }}>
              <TextField label="Path contains" value={q} onChange={setQ} autoComplete="off" placeholder="/sites/5/deploy" clearButton onClearButtonClick={() => setQ('')} />
            </div>
            <Button onClick={() => { setTokenId(''); setType(''); setTool(''); setQ('') }}>Clear</Button>
          </InlineStack>
        </Card>

        <Card padding="0">
          {loading && items.length === 0 ? (
            <Box padding="600"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
          ) : items.length === 0 ? (
            <Box padding="600"><Text as="p" tone="subdued" alignment="center">No AI activity yet. It appears here once an MCP client makes requests with a Personal Access Token.</Text></Box>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <DataTable
                columnContentTypes={['text', 'text', 'text', 'text', 'numeric', 'text', 'numeric']}
                headings={['Time', 'AI', 'Tool', 'Action', 'Site', 'Status', 'Duration']}
                rows={rows}
              />
            </div>
          )}
        </Card>
      </BlockStack>
    </Page>
  )
}
