import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, Checkbox, Select, Button, Badge, Divider } from '@shopify/polaris'
import { api, DigestConfig } from '../api/client'
import { useToast } from '../context/toast'

const DAYS = [
  { label: 'Sunday', value: '0' }, { label: 'Monday', value: '1' }, { label: 'Tuesday', value: '2' },
  { label: 'Wednesday', value: '3' }, { label: 'Thursday', value: '4' }, { label: 'Friday', value: '5' },
  { label: 'Saturday', value: '6' }
]

/**
 * Weekly digest: a once-a-week health summary (deploys, uptime, response time,
 * errors) fanned out to the configured channels. Off by default.
 */
export function DigestCard() {
  const showToast = useToast()
  const [cfg, setCfg] = useState<DigestConfig | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { api.digest.get().then(setCfg).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const setEnabled = async (enabled: boolean) => {
    setCfg((c) => (c ? { ...c, enabled } : c))
    await api.digest.update({ enabled }).catch(() => {})
  }
  const setDay = async (day: string) => {
    setCfg((c) => (c ? { ...c, day: Number(day) } : c))
    await api.digest.update({ day: Number(day) }).catch(() => {})
  }
  const sendNow = async () => {
    setBusy(true)
    try { const r = await api.digest.sendNow(); setCfg((c) => (c ? { ...c, preview: r.digest } : c)); showToast('Digest sent') }
    catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Failed', { error: true }) }
    finally { setBusy(false) }
  }

  const p = cfg?.preview
  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Weekly digest</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            A once-a-week summary sent to your configured channels (email, Telegram, …).
          </Text>
        </BlockStack>

        <Checkbox label="Send a weekly digest" checked={!!cfg?.enabled} onChange={setEnabled} />

        <InlineStack gap="300" blockAlign="end" wrap>
          <div style={{ width: 160 }}>
            <Select label="Day" options={DAYS} value={String(cfg?.day ?? 1)} onChange={setDay} disabled={!cfg?.enabled} />
          </div>
          <Button onClick={sendNow} loading={busy}>Send now</Button>
          {cfg?.lastSent && <Text as="span" variant="bodySm" tone="subdued">Last sent {cfg.lastSent}</Text>}
        </InlineStack>

        {p && (
          <>
            <Divider />
            <Text as="h3" variant="headingSm">This week so far</Text>
            <InlineStack gap="400" wrap>
              <Badge tone="success">{`${p.deploySuccess} deploys ✅`}</Badge>
              {p.deployFailed > 0 && <Badge tone="critical">{`${p.deployFailed} failed ❌`}</Badge>}
              <Badge>{p.uptimePct != null ? `${p.uptimePct}% uptime` : 'no uptime data'}</Badge>
              <Badge>{p.avgMs != null ? `${p.avgMs} ms avg` : '—'}</Badge>
              <Badge tone={p.errOpen > 0 ? 'attention' : undefined}>{`${p.errOpen} open errors`}</Badge>
            </InlineStack>
          </>
        )}
      </BlockStack>
    </Card>
  )
}
