import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, Text, Checkbox, Banner, Link, InlineStack, Button } from '@shopify/polaris'
import { api, StatusPageConfig } from '../api/client'
import { useToast } from '../context/toast'

/**
 * Toggle a shareable public status page for a site. Read-only for visitors;
 * generates a stable token the first time it's enabled.
 */
export function StatusPageCard({ siteId }: { siteId: number }) {
  const [cfg, setCfg] = useState<StatusPageConfig | null>(null)
  const [busy, setBusy] = useState(false)
  const showToast = useToast()

  const load = useCallback(() => { api.statusPage.get(siteId).then(setCfg).catch(() => {}) }, [siteId])
  useEffect(() => { load() }, [load])

  const toggle = async (enabled: boolean) => {
    setBusy(true)
    try { setCfg(await api.statusPage.toggle(siteId, enabled)) }
    catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Failed', { error: true }) }
    finally { setBusy(false) }
  }

  return (
    <Card>
      <BlockStack gap="300">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Public status page</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            A shareable read-only uptime page for this site (90-day history + incidents). Served from the panel domain — no changes to the site itself.
          </Text>
        </BlockStack>

        <Checkbox label="Enable public status page" checked={!!cfg?.enabled} onChange={toggle} disabled={busy} />

        {cfg?.enabled && cfg.url && (
          <Banner tone="info">
            <InlineStack gap="200" blockAlign="center" wrap>
              <Link url={cfg.url} external>{cfg.url}</Link>
              <Button size="micro" onClick={() => { navigator.clipboard?.writeText(cfg.url!); showToast('Link copied') }}>Copy</Button>
            </InlineStack>
          </Banner>
        )}
      </BlockStack>
    </Card>
  )
}
