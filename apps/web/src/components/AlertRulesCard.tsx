import { useEffect, useState, useCallback } from 'react'
import { Card, BlockStack, InlineStack, Text, Select, TextField, Button, Badge } from '@shopify/polaris'
import { api, AlertRule } from '../api/client'
import { useToast } from '../context/toast'

const METRICS = [
  { label: 'CPU', value: 'cpu' },
  { label: 'RAM', value: 'ram' },
  { label: 'Disk', value: 'disk' },
  { label: 'Swap', value: 'swap' }
]

/**
 * Manage system threshold alert rules. When a rule's condition holds, the
 * background alerts monitor raises a notification (bell) and fans out to the
 * configured channels. Admin-only (the /alerts API is role-gated).
 */
export function AlertRulesCard() {
  const [rules, setRules]         = useState<AlertRule[]>([])
  const [metric, setMetric]       = useState('cpu')
  const [operator, setOperator]   = useState('gt')
  const [threshold, setThreshold] = useState('85')
  const [busy, setBusy]           = useState(false)
  const showToast = useToast()

  const load = useCallback(() => { api.alerts.list().then((r) => setRules(r.rules)).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const add = async () => {
    const t = Number(threshold)
    if (!Number.isFinite(t) || t < 0 || t > 100) { showToast('Threshold must be 0–100', { error: true }); return }
    setBusy(true)
    try {
      const r = await api.alerts.create({ metric, operator, threshold: t })
      setRules((rs) => [...rs, r])
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed to add rule', { error: true })
    } finally { setBusy(false) }
  }

  const toggle = async (rule: AlertRule) => {
    const r = await api.alerts.update(rule.id, { enabled: !rule.enabled }).catch(() => null)
    if (r) setRules((rs) => rs.map((x) => (x.id === r.id ? r : x)))
  }

  const remove = async (id: number) => {
    await api.alerts.remove(id).catch(() => {})
    setRules((rs) => rs.filter((x) => x.id !== id))
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">Alert rules</Text>
          <Text as="p" variant="bodySm" tone="subdued">
            Raise a notification (and channel alert) when a metric crosses a threshold.
          </Text>
        </BlockStack>

        <InlineStack gap="200" blockAlign="end" wrap>
          <div style={{ width: 110 }}><Select label="Metric" options={METRICS} value={metric} onChange={setMetric} /></div>
          <div style={{ width: 100 }}><Select label="When" options={[{ label: 'above', value: 'gt' }, { label: 'below', value: 'lt' }]} value={operator} onChange={setOperator} /></div>
          <div style={{ width: 100 }}><TextField label="Threshold %" type="number" value={threshold} onChange={setThreshold} autoComplete="off" /></div>
          <Button onClick={add} loading={busy}>Add rule</Button>
        </InlineStack>

        {rules.length > 0 && (
          <BlockStack gap="150">
            {rules.map((r) => (
              <InlineStack key={r.id} align="space-between" blockAlign="center">
                <InlineStack gap="200" blockAlign="center">
                  <Badge tone={r.enabled ? 'success' : undefined}>{r.enabled ? 'on' : 'off'}</Badge>
                  <Text as="span" fontWeight="medium">{r.metric.toUpperCase()} {r.operator === 'lt' ? '<' : '>'} {r.threshold}%</Text>
                  <Text as="span" variant="bodySm" tone="subdued">· {r.cooldownMins}m cooldown</Text>
                </InlineStack>
                <InlineStack gap="150">
                  <Button size="micro" onClick={() => toggle(r)}>{r.enabled ? 'Disable' : 'Enable'}</Button>
                  <Button size="micro" tone="critical" variant="tertiary" onClick={() => remove(r.id)}>Delete</Button>
                </InlineStack>
              </InlineStack>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  )
}
