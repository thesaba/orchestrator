import { BlockStack, InlineStack, Text, Badge, Button, Banner, DataTable, Spinner, TextField } from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { composerApi, ComposerPackage } from '../api/client'
import { useToast } from '../context/toast'

export function ComposerTab({ siteId }: { siteId: number }) {
  const [packages, setPackages]   = useState<ComposerPackage[]>([])
  const [loading,  setLoading]    = useState(false)
  const [output,   setOutput]     = useState('')
  const [updating, setUpdating]   = useState<string | null>(null)
  const [error,    setError]      = useState('')
  const [filter,   setFilter]     = useState('')
  const showToast = useToast()

  const load = () => {
    setLoading(true); setError('')
    composerApi.outdated(siteId)
      .then((r) => setPackages(r.packages))
      .catch((e) => setError(e.message ?? 'Failed to get outdated packages'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [siteId]) // eslint-disable-line

  const doUpdate = async (pkg?: string) => {
    setUpdating(pkg ?? 'all'); setOutput(''); setError('')
    try {
      const r = await composerApi.update(siteId, pkg)
      setOutput(r.output)
      showToast(pkg ? `Updated ${pkg}` : 'All packages updated')
      load()
    } catch (e: unknown) {
      setError((e as Error).message)
    } finally { setUpdating(null) }
  }

  const filtered = filter
    ? packages.filter((p) => p.name.toLowerCase().includes(filter.toLowerCase()))
    : packages

  return (
    <BlockStack gap="500">
      <InlineStack align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">Composer — Outdated Packages</Text>
        <InlineStack gap="200">
          <Button onClick={load} loading={loading}>Refresh</Button>
          {packages.length > 0 && (
            <Button variant="primary" onClick={() => doUpdate()} loading={updating === 'all'}>
              Update All
            </Button>
          )}
        </InlineStack>
      </InlineStack>

      {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

      {loading ? (
        <InlineStack align="center"><Spinner size="small" /></InlineStack>
      ) : packages.length === 0 ? (
        <Banner tone="success">All packages are up to date.</Banner>
      ) : (
        <BlockStack gap="300">
          <TextField label="" placeholder="Filter packages…" value={filter} onChange={setFilter} autoComplete="off" />
          <div style={{ overflowX: 'auto' }}>
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text', 'text']}
              headings={['Package', 'Current', 'Latest', 'Status', 'Action']}
              rows={filtered.map((p) => [
                <Text as="span" variant="bodySm" fontWeight="semibold">{p.name}</Text>,
                <code style={{ fontSize: 12 }}>{p.version}</code>,
                <code style={{ fontSize: 12, color: '#47c1bf' }}>{p.latest}</code>,
                <Badge tone={p['latest-status'] === 'up-to-date' ? 'success' : 'warning'}>
                  {p['latest-status'] ?? 'outdated'}
                </Badge>,
                <Button size="micro" onClick={() => doUpdate(p.name)} loading={updating === p.name} disabled={!!updating}>
                  Update
                </Button>
              ])}
            />
          </div>
        </BlockStack>
      )}

      {output && (
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Output</Text>
          <pre style={{
            background: '#0d1117', color: '#e6edf3', fontFamily: 'monospace', fontSize: 12,
            padding: 16, borderRadius: 6, whiteSpace: 'pre-wrap', maxHeight: 300, overflowY: 'auto'
          }}>{output}</pre>
        </BlockStack>
      )}
    </BlockStack>
  )
}
