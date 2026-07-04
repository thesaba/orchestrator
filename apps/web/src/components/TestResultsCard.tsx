import { useEffect, useState } from 'react'
import {
  Card, BlockStack, InlineStack, Text, Badge, Divider, DataTable, SkeletonBodyText
} from '@shopify/polaris'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend
} from 'recharts'
import { api, TestStats, Deployment } from '../api/client'

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

function resultBadge(result?: string | null) {
  if (result === 'passed') return <Badge tone="success">passed</Badge>
  if (result === 'failed') return <Badge tone="critical">failed</Badge>
  if (result === 'skipped') return <Badge tone="warning">skipped</Badge>
  return <Badge>—</Badge>
}

/**
 * Deploy-time test analytics for a site: latest run summary, pass-rate + average
 * duration over recent runs, a passed/failed trend chart, and a run history
 * table. Backed by GET /sites/:id/test-stats and the site's deployment list.
 */
export function TestResultsCard({ siteId, deployments }: { siteId: number; deployments: Deployment[] }) {
  const [stats, setStats] = useState<TestStats | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.sites.testStats(siteId)
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false))
  }, [siteId])

  const history = deployments.filter((d) => d.testResult === 'passed' || d.testResult === 'failed')

  if (loading) {
    return <Card><SkeletonBodyText lines={4} /></Card>
  }

  if (!stats || stats.totalRuns === 0) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">Test results</Text>
          <Text as="p" tone="subdued">
            No test runs recorded yet. Enable “Run tests during deploy” in Deploy Settings, then deploy.
          </Text>
        </BlockStack>
      </Card>
    )
  }

  const last = stats.lastRun
  const chartData = stats.trend.map((t, i) => ({
    name: `#${i + 1}`,
    passed: t.passed ?? 0,
    failed: t.failed ?? 0
  }))

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Test results</Text>
          {last && resultBadge(last.testResult)}
        </InlineStack>

        {/* Latest run + aggregate stats */}
        <InlineStack gap="600" wrap>
          <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">Latest run</Text>
            <Text as="span" variant="headingLg">
              {last?.testsPassed ?? '—'} <Text as="span" tone="success">✓</Text>
              {'  '}
              {last?.testsFailed ?? '—'} <Text as="span" tone="critical">✗</Text>
            </Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {last?.testsTotal != null ? `${last.testsTotal} tests · ` : ''}{fmtDuration(last?.testDurationMs)}
            </Text>
          </BlockStack>

          <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">Pass rate (last {stats.totalRuns})</Text>
            <Text as="span" variant="headingLg">{stats.passRate != null ? `${stats.passRate}%` : '—'}</Text>
          </BlockStack>

          <BlockStack gap="050">
            <Text as="span" variant="bodySm" tone="subdued">Avg duration</Text>
            <Text as="span" variant="headingLg">{fmtDuration(stats.avgDurationMs)}</Text>
          </BlockStack>
        </InlineStack>

        {/* Passed / failed trend */}
        {chartData.length >= 2 && (
          <div style={{ width: '100%', height: 200 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" vertical={false} />
                <XAxis dataKey="name" fontSize={11} />
                <YAxis allowDecimals={false} fontSize={11} />
                <Tooltip />
                <Legend />
                <Bar dataKey="passed" name="Passed" stackId="t" fill="#36a64f" isAnimationActive={false} />
                <Bar dataKey="failed" name="Failed" stackId="t" fill="#e01e5a" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <Divider />

        {/* Run history */}
        <Text as="h3" variant="headingSm">History</Text>
        <DataTable
          columnContentTypes={['text', 'text', 'numeric', 'numeric', 'numeric', 'text', 'text']}
          headings={['When', 'Commit', '✓', '✗', 'Total', 'Duration', 'Result']}
          rows={history.slice(0, 20).map((d) => [
            new Date(d.createdAt).toLocaleString(),
            d.commit ? d.commit.slice(0, 7) : '—',
            d.testsPassed ?? '—',
            d.testsFailed ?? '—',
            d.testsTotal ?? '—',
            fmtDuration(d.testDurationMs),
            resultBadge(d.testResult)
          ])}
        />
      </BlockStack>
    </Card>
  )
}
