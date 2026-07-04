import { useState } from 'react'
import {
  Button, Modal, BlockStack, InlineStack, Text, Badge, Banner, TextField, Spinner
} from '@shopify/polaris'
import { api, PendingChanges } from '../api/client'

/**
 * "Review & deploy": shows the commits on the remote branch that haven't been
 * deployed yet (or the latest commits when the range can't be computed), plus
 * an optional ref field to deploy a specific tag/branch/commit. Delegates the
 * actual deploy to the parent's handler so streaming/UI stays in one place.
 */
export function DeployReview({ siteId, onDeploy, disabled }: {
  siteId: number
  onDeploy: (opts?: { ref?: string }) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState<PendingChanges | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  const [ref, setRef] = useState('')

  const load = async () => {
    setOpen(true); setLoading(true); setErr(''); setData(null); setRef('')
    try { setData(await api.deploy.pending(siteId)) }
    catch (e: unknown) { setErr(e instanceof Error ? e.message : 'Failed to read the remote') }
    finally { setLoading(false) }
  }

  const deploy = () => { onDeploy(ref.trim() ? { ref: ref.trim() } : undefined); setOpen(false) }

  return (
    <>
      <Button onClick={load} disabled={disabled}>Review changes</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Review & deploy"
        primaryAction={{ content: ref.trim() ? `Deploy ${ref.trim()}` : 'Deploy latest', onAction: deploy }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setOpen(false) }]}
      >
        <Modal.Section>
          {loading ? (
            <InlineStack align="center"><Spinner size="small" /></InlineStack>
          ) : err ? (
            <Banner tone="critical">{err}</Banner>
          ) : data ? (
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" wrap>
                <Badge>{`branch: ${data.branch}`}</Badge>
                <Text as="span" variant="bodySm" tone="subdued">
                  {(data.currentCommit ?? 'none')} → {data.remoteCommit}
                </Text>
                {data.upToDate && <Badge tone="success">up to date</Badge>}
              </InlineStack>

              <Text as="h3" variant="headingSm">
                {data.range
                  ? `${data.commits.length} commit${data.commits.length !== 1 ? 's' : ''} to deploy`
                  : 'Latest commits (range unavailable)'}
              </Text>

              <div className="oc-terminal" style={{ maxHeight: 280, fontSize: 12.5 }}>
                {data.commits.length === 0 ? (
                  <span style={{ color: '#8b949e' }}>No new commits since the last deploy.</span>
                ) : data.commits.map((c) => (
                  <div key={c.hash} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    <span style={{ color: '#d2a8ff' }}>{c.hash}</span>{' '}
                    <span style={{ color: '#e6edf3' }}>{c.subject}</span>{' '}
                    <span style={{ color: '#8b949e' }}>— {c.author}</span>
                  </div>
                ))}
              </div>

              <TextField
                label="Deploy a specific ref (optional)"
                value={ref}
                onChange={setRef}
                autoComplete="off"
                placeholder="tag, branch or commit — blank deploys the latest"
                helpText="e.g. v1.4.0 or a feature branch. Leave blank to deploy branch HEAD."
              />
            </BlockStack>
          ) : null}
        </Modal.Section>
      </Modal>
    </>
  )
}
