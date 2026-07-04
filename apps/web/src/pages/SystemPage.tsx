import {
  Page, Layout, Card, BlockStack, InlineStack, Text, Button, Badge, Banner,
  TextField, Select, Modal, Divider
} from '@shopify/polaris'
import { RefreshIcon } from '@shopify/polaris-icons'
import { useCallback, useEffect, useState } from 'react'
import { api, SystemInfo } from '../api/client'
import { ProvisionLog } from '../components/ProvisionLog'

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ')
}

interface Pending { key: string; label: string; arg?: string; confirmBody?: string; danger?: boolean }

export function SystemPage() {
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [running, setRunning] = useState<{ endpoint: string; label: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<Pending | null>(null)

  const [ufwPort, setUfwPort] = useState('')
  const [ufwProto, setUfwProto] = useState('')

  const loadInfo = useCallback(() => { api.system.info().then(setInfo).catch(() => setInfo(null)) }, [])
  useEffect(() => { loadInfo() }, [loadInfo])

  // Kick off a streamed action (ProvisionLog consumes the SSE endpoint).
  const run = useCallback((key: string, label: string, arg?: string) => {
    const q = arg ? `?arg=${encodeURIComponent(arg)}` : ''
    setBusy(true)
    setRunning({ endpoint: `/api/system/run/${key}/stream${q}`, label })
  }, [])

  const request = useCallback((p: Pending) => {
    if (p.confirmBody) setConfirm(p)
    else run(p.key, p.label, p.arg)
  }, [run])

  const onComplete = useCallback(() => { setBusy(false); loadInfo() }, [loadInfo])

  const ufwArg = ufwPort.trim() + (ufwProto ? `/${ufwProto}` : '')
  const ufwValid = /^(ssh|http|https|ftp|smtp)$/.test(ufwPort.trim()) || /^\d{1,5}$/.test(ufwPort.trim())

  return (
    <Page title="System Control" subtitle="Server maintenance from the panel — packages, cleanup, firewall & power">
      <Layout>
        {/* ── System snapshot ─────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingMd">System</Text>
                <Button icon={RefreshIcon} onClick={loadInfo} accessibilityLabel="Refresh" />
              </InlineStack>

              {info?.rebootRequired && (
                <Banner tone="warning">A reboot is required to finish applying updates.</Banner>
              )}

              <InlineStack gap="600" wrap>
                <Info label="Host" value={info?.hostname ?? '—'} />
                <Info label="OS" value={info?.os || '—'} />
                <Info label="Kernel" value={info?.kernel || '—'} />
                <Info label="Uptime" value={info ? fmtUptime(info.uptimeSeconds) : '—'} />
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">Updates</Text>
                  {info == null ? <Text as="span">—</Text> : info.pendingUpdates < 0 ? (
                    <Text as="span" tone="subdued">unknown</Text>
                  ) : (
                    <Badge tone={info.pendingUpdates > 0 ? 'attention' : 'success'}>
                      {info.pendingUpdates > 0 ? `${info.pendingUpdates} pending` : 'up to date'}
                    </Badge>
                  )}
                </BlockStack>
                <BlockStack gap="050">
                  <Text as="span" variant="bodySm" tone="subdued">Firewall</Text>
                  {info?.ufwStatus == null ? <Text as="span" tone="subdued">n/a</Text> : (
                    <Badge tone={info.ufwStatus === 'active' ? 'success' : 'warning'}>{info.ufwStatus}</Badge>
                  )}
                </BlockStack>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Packages ────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Packages</Text>
              <Text as="p" variant="bodySm" tone="subdued">Update the package index, then apply upgrades.</Text>
              <InlineStack gap="200" wrap>
                <Button disabled={busy} onClick={() => request({ key: 'apt-update', label: 'apt-get update' })}>Check for updates</Button>
                <Button disabled={busy} variant="primary" onClick={() => request({ key: 'apt-upgrade', label: 'apt-get upgrade', confirmBody: 'Install all available package upgrades now? This runs apt-get upgrade -y and can take a few minutes.' })}>Upgrade</Button>
                <Button disabled={busy} onClick={() => request({ key: 'apt-dist-upgrade', label: 'apt-get dist-upgrade', confirmBody: 'Run a full dist-upgrade? This may add/remove packages and change the kernel. A reboot may be required afterward.' })}>Full upgrade</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Cleanup ─────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Cleanup</Text>
              <Text as="p" variant="bodySm" tone="subdued">Reclaim disk space from caches, old packages and logs.</Text>
              <InlineStack gap="200" wrap>
                <Button disabled={busy} onClick={() => request({ key: 'apt-autoremove', label: 'apt-get autoremove', confirmBody: 'Remove packages that were installed as dependencies and are no longer needed (autoremove --purge)?' })}>Autoremove</Button>
                <Button disabled={busy} onClick={() => request({ key: 'apt-clean', label: 'apt-get clean' })}>Clean apt cache</Button>
                <Button disabled={busy} onClick={() => request({ key: 'journal-vacuum', label: 'journalctl vacuum' })}>Vacuum logs (7d)</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Firewall ────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Firewall (ufw)</Text>
              <InlineStack gap="200" wrap>
                <Button disabled={busy} onClick={() => request({ key: 'ufw-status', label: 'ufw status' })}>Show status</Button>
                <Button disabled={busy} onClick={() => request({ key: 'ufw-enable', label: 'ufw enable', confirmBody: 'Enable the firewall now? Make sure SSH (port 22) is allowed first, or you could lock yourself out.' })}>Enable firewall</Button>
              </InlineStack>
              <Divider />
              <InlineStack gap="200" blockAlign="end" wrap>
                <div style={{ width: 160 }}>
                  <TextField label="Port or service" value={ufwPort} onChange={setUfwPort} autoComplete="off" placeholder="8080 or ssh/http/https" />
                </div>
                <div style={{ width: 120 }}>
                  <Select label="Protocol" options={[{ label: 'any', value: '' }, { label: 'tcp', value: 'tcp' }, { label: 'udp', value: 'udp' }]} value={ufwProto} onChange={setUfwProto} />
                </div>
                <Button disabled={busy || !ufwValid} onClick={() => request({ key: 'ufw-allow', label: `ufw allow ${ufwArg}`, arg: ufwArg })}>Allow</Button>
                <Button disabled={busy || !ufwValid} tone="critical" onClick={() => request({ key: 'ufw-deny', label: `ufw deny ${ufwArg}`, arg: ufwArg, confirmBody: `Deny traffic on ${ufwArg}?` })}>Deny</Button>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">Rule target must be a port (e.g. 8080) or one of ssh / http / https / ftp / smtp.</Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Output ──────────────────────────────────────────────────── */}
        {running && (
          <Layout.Section>
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Output — {running.label}</Text>
                <ProvisionLog key={running.endpoint} endpoint={running.endpoint} onComplete={onComplete} />
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* ── Power (danger) ──────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Power</Text>
              <InlineStack align="space-between" blockAlign="center" wrap>
                <Text as="p" variant="bodySm" tone="subdued">Reboot the server. Active connections and the panel itself will drop for a minute or two.</Text>
                <Button disabled={busy} tone="critical" onClick={() => request({ key: 'reboot', label: 'reboot', danger: true, confirmBody: 'Reboot the server now? The panel and all hosted sites will be briefly unavailable.' })}>Reboot server</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.label ?? 'Confirm'}
        primaryAction={{
          content: confirm?.danger ? 'Reboot' : 'Run',
          destructive: confirm?.danger,
          onAction: () => { if (confirm) run(confirm.key, confirm.label, confirm.arg); setConfirm(null) }
        }}
        secondaryActions={[{ content: 'Cancel', onAction: () => setConfirm(null) }]}
      >
        <Modal.Section>
          <Text as="p">{confirm?.confirmBody}</Text>
        </Modal.Section>
      </Modal>
    </Page>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <BlockStack gap="050">
      <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
      <Text as="span" fontWeight="semibold">{value}</Text>
    </BlockStack>
  )
}
