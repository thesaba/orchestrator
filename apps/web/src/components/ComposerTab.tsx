import { BlockStack, InlineStack, Text, Badge, Button, Banner, DataTable, Spinner, TextField, Modal } from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { composerApi, ComposerPackage } from '../api/client'
import { useToast } from '../context/toast'
import { LogConsole } from './LogConsole'

// "semver-safe-update" / "up-to-date" stay within the composer.json constraint;
// anything else (notably "update-possible") is a MAJOR jump outside it and needs
// a constraint bump, which can bring breaking changes.
const isMajor = (p: ComposerPackage) =>
  !!p['latest-status'] && p['latest-status'] !== 'semver-safe-update' && p['latest-status'] !== 'up-to-date'

export function ComposerTab({ siteId }: { siteId: number }) {
  const [packages, setPackages]   = useState<ComposerPackage[]>([])
  const [loading,  setLoading]    = useState(false)
  const [output,   setOutput]     = useState('')
  const [updating, setUpdating]   = useState<string | null>(null)
  const [error,    setError]      = useState('')
  const [filter,   setFilter]     = useState('')
  const [majorConfirm, setMajorConfirm] = useState<ComposerPackage | null>(null)
  const showToast = useToast()

  const load = () => {
    setLoading(true); setError('')
    composerApi.outdated(siteId)
      .then((r) => setPackages(r.packages))
      .catch((e) => setError(e.message ?? 'Failed to get outdated packages'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [siteId]) // eslint-disable-line

  const doUpdate = async (pkg?: string, targetVersion?: string) => {
    setUpdating(pkg ?? 'all'); setOutput(''); setError('')
    try {
      const r = await composerApi.update(siteId, pkg, targetVersion)
      setOutput(r.output)
      showToast(targetVersion ? `Upgraded ${pkg} to ^${targetVersion}` : pkg ? `Updated ${pkg}` : 'All packages updated')
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
                <code style={{ fontSize: 12, color: 'var(--oc-accent)' }}>{p.latest}</code>,
                <Badge tone={p['latest-status'] === 'up-to-date' ? 'success' : isMajor(p) ? 'attention' : 'warning'}>
                  {p['latest-status'] ?? 'outdated'}
                </Badge>,
                isMajor(p) ? (
                  <Button size="micro" tone="critical" variant="tertiary" onClick={() => setMajorConfirm(p)} loading={updating === p.name} disabled={!!updating}>
                    Upgrade (major)
                  </Button>
                ) : (
                  <Button size="micro" onClick={() => doUpdate(p.name)} loading={updating === p.name} disabled={!!updating}>
                    Update
                  </Button>
                )
              ])}
            />
          </div>
        </BlockStack>
      )}

      {output && (
        <BlockStack gap="200">
          <Text as="h3" variant="headingSm">Output</Text>
          <LogConsole lines={[output]} minHeight={120} maxHeight={300} />
        </BlockStack>
      )}

      <Modal
        open={!!majorConfirm}
        onClose={() => setMajorConfirm(null)}
        title={`Major upgrade — ${majorConfirm?.name ?? ''}`}
        primaryAction={{
          content: `Upgrade to ^${majorConfirm?.latest ?? ''}`,
          destructive: true,
          loading: !!updating,
          onAction: () => {
            const p = majorConfirm
            setMajorConfirm(null)
            if (p) doUpdate(p.name, p.latest)
          }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setMajorConfirm(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Banner tone="warning">
              This changes the version constraint in <code>composer.json</code> to a new major version, which can introduce <strong>breaking changes</strong>. Test the site afterwards, and roll back the deploy if needed.
            </Banner>
            <Text as="p">
              {majorConfirm?.name}: <code>{majorConfirm?.version}</code> → <code>^{majorConfirm?.latest}</code>
            </Text>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}
