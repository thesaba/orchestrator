import { useEffect, useState } from 'react'
import {
  Card, BlockStack, InlineStack, Text, Badge, Button, TextField, Spinner, Tooltip
} from '@shopify/polaris'
import { api, billingApi } from '../api/client'

type Econ = Awaited<ReturnType<typeof billingApi.serverEconomics>>['servers'][number]

// Read-only Server Economics report: per-server monthly cost vs revenue vs
// margin vs latest utilisation. Lets an admin set each server's monthly cost
// (the only write — Server.monthlyCostMinor) so margins are meaningful.
export function ServerEconomicsCard() {
  const [rows, setRows] = useState<Econ[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [costInput, setCostInput] = useState('')
  const [saving, setSaving] = useState(false)

  async function load() {
    try {
      const r = await billingApi.serverEconomics()
      setRows(r.servers)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => { load() }, [])

  async function saveCost(serverId: number, currency: string) {
    const major = parseFloat(costInput)
    if (isNaN(major) || major < 0) { setEditing(null); return }
    setSaving(true)
    try {
      await api.servers.update(serverId, { monthlyCostMinor: Math.round(major * 100), costCurrency: currency })
      setEditing(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (error) return <Card><Text as="p" tone="critical">Server economics: {error}</Text></Card>
  if (!rows) return <Card><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="p" tone="subdued">Loading server economics…</Text></InlineStack></Card>

  const util = (n: number) => (
    <Badge tone={n >= 90 ? 'critical' : n >= 75 ? 'warning' : 'success'}>{`${n}%`}</Badge>
  )

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Server economics</Text>
        <Text as="p" tone="subdued" variant="bodySm">
          Monthly cost vs revenue from hosted sites vs margin, plus latest utilisation. Spot over/under-subscribed boxes.
        </Text>

        {rows.map((s) => {
          const marginPositive = s.marginMinor >= 0
          const revenue = s.revenueByCurrency.length
            ? s.revenueByCurrency.map(r => r.formatted).join(' + ')
            : '—'
          return (
            <Card key={s.serverId} background="bg-surface-secondary">
              <BlockStack gap="200">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <Text as="h3" variant="headingSm">{s.name}</Text>
                    <Badge tone={s.kind === 'local' ? 'info' : undefined}>{s.kind}</Badge>
                    <Text as="span" tone="subdued" variant="bodySm">
                      {s.billedSiteCount}/{s.siteCount} billed
                    </Text>
                  </InlineStack>
                  {s.utilization ? (
                    <InlineStack gap="150" blockAlign="center">
                      <Tooltip content="CPU"><span>{util(s.utilization.cpu)}</span></Tooltip>
                      <Tooltip content="RAM"><span>{util(s.utilization.ram)}</span></Tooltip>
                      <Tooltip content="Disk"><span>{util(s.utilization.disk)}</span></Tooltip>
                    </InlineStack>
                  ) : <Text as="span" tone="subdued" variant="bodySm">no metrics</Text>}
                </InlineStack>

                <InlineStack gap="400" wrap>
                  <BlockStack gap="050">
                    <Text as="span" tone="subdued" variant="bodySm">Cost / mo</Text>
                    {editing === s.serverId ? (
                      <InlineStack gap="150" blockAlign="center">
                        <div style={{ width: 90 }}>
                          <TextField label="" labelHidden type="number" value={costInput} onChange={setCostInput} autoComplete="off" prefix={s.costCurrency} />
                        </div>
                        <Button size="slim" variant="primary" loading={saving} onClick={() => saveCost(s.serverId, s.costCurrency)}>Save</Button>
                        <Button size="slim" onClick={() => setEditing(null)}>Cancel</Button>
                      </InlineStack>
                    ) : (
                      <InlineStack gap="150" blockAlign="center">
                        <Text as="span" variant="headingSm">{s.costFormatted}</Text>
                        <Button size="micro" onClick={() => { setEditing(s.serverId); setCostInput(String((s.costMinor / 100).toFixed(2))) }}>Edit</Button>
                      </InlineStack>
                    )}
                  </BlockStack>

                  <BlockStack gap="050">
                    <Text as="span" tone="subdued" variant="bodySm">Revenue / mo</Text>
                    <Text as="span" variant="headingSm">{revenue}</Text>
                  </BlockStack>

                  <BlockStack gap="050">
                    <Text as="span" tone="subdued" variant="bodySm">Margin / mo</Text>
                    <Text as="span" variant="headingSm" tone={marginPositive ? 'success' : 'critical'}>
                      {s.marginFormatted}
                    </Text>
                  </BlockStack>
                </InlineStack>
              </BlockStack>
            </Card>
          )
        })}
      </BlockStack>
    </Card>
  )
}
