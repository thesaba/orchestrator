import { BlockStack, InlineStack, Text, Badge, Button, Banner, DataTable, Spinner, Modal } from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { failedJobsApi, FailedJob } from '../api/client'
import { useToast } from '../context/toast'

// Best-effort short job class name from either the column or the payload.
function jobClassOf(j: FailedJob): string {
  let c = j.class ?? ''
  if (!c && j.payload) { try { c = JSON.parse(j.payload)?.displayName ?? '' } catch { /* ignore */ } }
  return (c.split('\\').pop() || c || 'unknown')
}

export function FailedJobsTab({ siteId }: { siteId: number }) {
  const [jobs,      setJobs]      = useState<FailedJob[]>([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [retrying,  setRetrying]  = useState<string | null>(null)
  const [deleting,  setDeleting]  = useState<string | null>(null)
  const [flushing,  setFlushing]  = useState(false)
  const [showJob,   setShowJob]   = useState<FailedJob | null>(null)
  const [stats,     setStats]     = useState<{ pending: number | null; failed: number | null } | null>(null)
  const showToast = useToast()

  const load = () => {
    setLoading(true); setError('')
    failedJobsApi.queueStats(siteId).then(setStats).catch(() => setStats(null))
    failedJobsApi.list(siteId)
      .then((r) => setJobs(r.jobs))
      .catch((e) => setError(e.message ?? 'Failed to list failed jobs'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [siteId]) // eslint-disable-line

  const retry = async (jobId: string) => {
    setRetrying(jobId)
    try {
      await failedJobsApi.retry(siteId, jobId)
      showToast('Job queued for retry')
      load()
    } catch (e: unknown) { showToast((e as Error).message, { error: true }) }
    finally { setRetrying(null) }
  }

  const retryAll = async () => {
    setRetrying('all')
    try {
      await failedJobsApi.retryAll(siteId)
      showToast('All jobs queued for retry')
      load()
    } catch (e: unknown) { showToast((e as Error).message, { error: true }) }
    finally { setRetrying(null) }
  }

  const del = async (jobId: string) => {
    setDeleting(jobId)
    try {
      await failedJobsApi.delete(siteId, jobId)
      setJobs((p) => p.filter((j) => String(j.id) !== jobId))
    } catch (e: unknown) { showToast((e as Error).message, { error: true }) }
    finally { setDeleting(null) }
  }

  const flush = async () => {
    setFlushing(true)
    try {
      await failedJobsApi.flush(siteId)
      setJobs([])
      showToast('All failed jobs cleared')
    } catch (e: unknown) { showToast((e as Error).message, { error: true }) }
    finally { setFlushing(false) }
  }

  return (
    <BlockStack gap="500">
      <InlineStack align="space-between" blockAlign="center">
        <InlineStack gap="300" blockAlign="center">
          <Text as="h2" variant="headingMd">Queue</Text>
          {stats?.pending != null && <Badge tone={stats.pending > 0 ? 'attention' : 'success'}>{`${stats.pending} pending`}</Badge>}
          <Badge tone={jobs.length > 0 ? 'critical' : 'success'}>{`${stats?.failed ?? jobs.length} failed`}</Badge>
        </InlineStack>
        <InlineStack gap="200">
          <Button onClick={load} loading={loading}>Refresh</Button>
          {jobs.length > 0 && (
            <>
              <Button onClick={retryAll} loading={retrying === 'all'}>Retry All</Button>
              <Button tone="critical" onClick={flush} loading={flushing}>Flush All</Button>
            </>
          )}
        </InlineStack>
      </InlineStack>

      {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}

      {jobs.length > 0 && (() => {
        const byClass = new Map<string, number>()
        for (const j of jobs) byClass.set(jobClassOf(j), (byClass.get(jobClassOf(j)) ?? 0) + 1)
        const top = [...byClass.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
        return (
          <InlineStack gap="150" wrap>
            <Text as="span" variant="bodySm" tone="subdued">Failing by class:</Text>
            {top.map(([cls, n]) => <Badge key={cls}>{`${cls} ×${n}`}</Badge>)}
          </InlineStack>
        )
      })()}

      {loading ? (
        <InlineStack align="center"><Spinner size="small" /></InlineStack>
      ) : jobs.length === 0 ? (
        <Banner tone="success">No failed jobs. Queue is healthy.</Banner>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <DataTable
            columnContentTypes={['text', 'text', 'text', 'text', 'text']}
            headings={['ID', 'Job Class', 'Queue', 'Failed At', 'Actions']}
            rows={jobs.map((j) => {
              const id = String(j.id)
              return [
                <Text as="span" variant="bodySm" fontWeight="semibold">{id}</Text>,
                <Text as="span" variant="bodySm">{jobClassOf(j)}</Text>,
                j.queue ?? 'default',
                j.failed_at ? new Date(j.failed_at).toLocaleString() : '—',
                <InlineStack gap="200">
                  <Button size="micro" onClick={() => setShowJob(j)}>Details</Button>
                  <Button size="micro" onClick={() => retry(id)} loading={retrying === id}>Retry</Button>
                  <Button size="micro" tone="critical" onClick={() => del(id)} loading={deleting === id}>Delete</Button>
                </InlineStack>
              ]
            })}
          />
        </div>
      )}

      {/* Job detail modal */}
      <Modal
        open={!!showJob}
        onClose={() => setShowJob(null)}
        title={showJob ? `Failed Job #${showJob.id}` : ''}
        size="large"
      >
        <Modal.Section>
          {showJob && (
            <BlockStack gap="400">
              {showJob.exception && (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Exception</Text>
                  <pre className="oc-terminal" style={{ maxHeight: 300, color: '#f85149' }}>{showJob.exception}</pre>
                </BlockStack>
              )}
              {showJob.payload && (
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">Payload</Text>
                  <pre className="oc-terminal" style={{ maxHeight: 200 }}>
                    {(() => { try { return JSON.stringify(JSON.parse(showJob.payload!), null, 2) } catch { return showJob.payload } })()}
                  </pre>
                </BlockStack>
              )}
            </BlockStack>
          )}
        </Modal.Section>
      </Modal>
    </BlockStack>
  )
}
