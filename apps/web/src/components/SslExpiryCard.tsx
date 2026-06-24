import React, { useEffect, useState } from 'react'
import {
  Card, DataTable, SkeletonBodyText, Badge, Text, Button, InlineStack
} from '@shopify/polaris'
import { sslExpiryApi, type SslExpiry } from '../api/client'

function expiryBadge(days: number | null, error: string | null): React.ReactNode {
  if (error || days === null) return <Badge tone="attention">Error</Badge>
  if (days <= 0) return <Badge tone="critical">Expired</Badge>
  if (days <= 14) return <Badge tone="critical">{`${days}d left`}</Badge>
  if (days <= 30) return <Badge tone="warning">{`${days}d left`}</Badge>
  return <Badge tone="success">{`${days}d left`}</Badge>
}

export function SslExpiryCard() {
  const [sites, setSites]     = useState<SslExpiry[] | null>(null)
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    try {
      const data = await sslExpiryApi.all()
      setSites(data.sites)
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  return (
    <Card>
      <InlineStack gap="400" align="space-between" blockAlign="center">
        <Text as="h2" variant="headingMd">SSL Certificates</Text>
        <Button size="slim" onClick={load} loading={loading}>Refresh</Button>
      </InlineStack>

      <div style={{ marginTop: 12 }}>
        {loading && !sites ? (
          <SkeletonBodyText lines={3} />
        ) : sites && sites.length > 0 ? (
          <DataTable
            columnContentTypes={['text', 'text', 'text']}
            headings={['Domain', 'Expires', 'Status']}
            rows={sites.map((s) => [
              s.domain,
              s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '—',
              expiryBadge(s.daysLeft, s.error) as React.ReactNode
            ])}
          />
        ) : (
          <Text as="p" tone="subdued">No SSL-enabled sites found.</Text>
        )}
      </div>
    </Card>
  )
}
