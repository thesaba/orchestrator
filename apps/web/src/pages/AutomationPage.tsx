import { useEffect, useState } from 'react'
import {
  Page, Card, BlockStack, InlineStack, Text, Badge, Button, Banner, Spinner, Box,
  Modal, TextField, Select, Checkbox, ChoiceList, Divider
} from '@shopify/polaris'
import {
  automationApi,
  type WebhookInfo, type AutomationRuleInfo
} from '../api/client'

export function AutomationPage() {
  const [webhooks, setWebhooks] = useState<WebhookInfo[]>([])
  const [rules, setRules] = useState<AutomationRuleInfo[]>([])
  const [events, setEvents] = useState<string[]>([])
  const [actions, setActions] = useState<string[]>([])
  const [error, setError] = useState('')
  const [flash, setFlash] = useState('')
  const [loading, setLoading] = useState(true)
  const [newHook, setNewHook] = useState(false)
  const [newRule, setNewRule] = useState(false)

  async function load() {
    setLoading(true)
    try {
      const [w, r, e] = await Promise.all([
        automationApi.listWebhooks(),
        automationApi.listRules(),
        automationApi.eventTypes()
      ])
      setWebhooks(w.webhooks); setRules(r.rules); setEvents(e.events); setActions(e.actions)
    } catch (err) { setError((err as Error).message) }
    finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  const note = (m: string) => { setFlash(m); setTimeout(() => setFlash(''), 3000) }

  if (loading) return <Page title="Automation"><Box padding="800"><InlineStack align="center"><Spinner /></InlineStack></Box></Page>

  return (
    <Page title="Automation & webhooks" subtitle="Outbound webhooks and event-driven rules. Everything is off until you enable it.">
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError('')}>{error}</Banner>}
        {flash && <Banner tone="success" onDismiss={() => setFlash('')}>{flash}</Banner>}

        {/* ── Webhooks ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Outbound webhooks</Text>
              <Button variant="primary" onClick={() => setNewHook(true)}>New webhook</Button>
            </InlineStack>
            {webhooks.length === 0
              ? <Text as="p" tone="subdued">No webhooks yet. Add one to POST panel events to an external URL.</Text>
              : webhooks.map((h) => (
                <Box key={h.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <BlockStack gap="150">
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" fontWeight="semibold">{h.name}</Text>
                        <Badge tone={h.active ? 'success' : undefined}>{h.active ? 'active' : 'off'}</Badge>
                        {h.hasSecret && <Badge tone="info">signed</Badge>}
                      </InlineStack>
                      <InlineStack gap="150">
                        <Button size="slim" onClick={async () => { const r = await automationApi.testWebhook(h.id); note(r.ok ? `Test OK (${r.statusCode})` : `Test failed: ${r.error ?? r.statusCode}`) }}>Test</Button>
                        <Button size="slim" onClick={async () => { await automationApi.updateWebhook(h.id, { active: !h.active }); load() }}>{h.active ? 'Disable' : 'Enable'}</Button>
                        <Button size="slim" tone="critical" onClick={async () => { await automationApi.deleteWebhook(h.id); load() }}>Delete</Button>
                      </InlineStack>
                    </InlineStack>
                    <Text as="span" variant="bodySm" tone="subdued" truncate>{h.url}</Text>
                    <Text as="span" variant="bodySm" tone="subdued">{h.events.length ? h.events.join(', ') : 'all events'}</Text>
                  </BlockStack>
                </Box>
              ))}
          </BlockStack>
        </Card>

        {/* ── Rules ── */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">Automation rules</Text>
              <Button variant="primary" onClick={() => setNewRule(true)}>New rule</Button>
            </InlineStack>
            <Text as="p" tone="subdued" variant="bodySm">
              When a trigger fires and conditions match, run an action. Actions are limited to notify / telegram / webhook —
              no rule can touch a hosted site. While “dry run” is on, matches are only logged.
            </Text>
            {rules.length === 0
              ? <Text as="p" tone="subdued">No rules yet.</Text>
              : rules.map((r) => (
                <Box key={r.id} padding="300" borderColor="border" borderWidth="025" borderRadius="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <BlockStack gap="050">
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="span" fontWeight="semibold">{r.name}</Text>
                        <Badge tone={r.enabled ? 'success' : undefined}>{r.enabled ? 'enabled' : 'off'}</Badge>
                        {r.enabled && r.dryRun && <Badge tone="attention">dry run</Badge>}
                      </InlineStack>
                      <Text as="span" variant="bodySm" tone="subdued">{r.trigger} → {r.actionType}</Text>
                    </BlockStack>
                    <InlineStack gap="150">
                      <Button size="slim" onClick={async () => { await automationApi.updateRule(r.id, { enabled: !r.enabled }); load() }}>{r.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button size="slim" onClick={async () => { await automationApi.updateRule(r.id, { dryRun: !r.dryRun }); load() }}>{r.dryRun ? 'Go live' : 'Dry run'}</Button>
                      <Button size="slim" tone="critical" onClick={async () => { await automationApi.deleteRule(r.id); load() }}>Delete</Button>
                    </InlineStack>
                  </InlineStack>
                </Box>
              ))}
          </BlockStack>
        </Card>
      </BlockStack>

      {newHook && <WebhookModal events={events} onClose={() => setNewHook(false)} onSaved={() => { setNewHook(false); load(); note('Webhook created') }} onError={setError} />}
      {newRule && <RuleModal events={events} actions={actions} onClose={() => setNewRule(false)} onSaved={() => { setNewRule(false); load(); note('Rule created') }} onError={setError} />}
    </Page>
  )
}

function WebhookModal({ events, onClose, onSaved, onError }: { events: string[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [active, setActive] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      await automationApi.createWebhook({ name, url, secret: secret || undefined, events: selected, active })
      onSaved()
    } catch (e) { onError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="New webhook" primaryAction={{ content: 'Create', onAction: save, loading: saving, disabled: !name || !url }} secondaryActions={[{ content: 'Cancel', onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="300">
          <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
          <TextField label="URL" value={url} onChange={setUrl} autoComplete="off" placeholder="https://webhook.site/<your-id>"
            helpText="Paste the delivery endpoint URL, not the dashboard/view URL. For webhook.site use https://webhook.site/<id> — NOT https://webhook.site/#!/view/<id> (that one 404s)." />
          {/\/#!\/view\//.test(url) && (
            <Banner tone="warning">That looks like a webhook.site <em>view</em> URL. Use the endpoint URL instead: <strong>{url.replace('/#!/view/', '/')}</strong></Banner>
          )}
          <TextField label="Secret (optional — HMAC signs deliveries)" value={secret} onChange={setSecret} autoComplete="off" />
          <Checkbox label="Active" checked={active} onChange={setActive} />
          <Divider />
          <ChoiceList allowMultiple title="Events (none = all)" choices={events.map((e) => ({ label: e, value: e }))} selected={selected} onChange={setSelected} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

function RuleModal({ events, actions, onClose, onSaved, onError }: { events: string[]; actions: string[]; onClose: () => void; onSaved: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState(events[0] ?? '')
  const [actionType, setActionType] = useState(actions[0] ?? 'notify')
  const [condField, setCondField] = useState('')
  const [condOp, setCondOp] = useState('eq')
  const [condValue, setCondValue] = useState('')
  const [cfgTitle, setCfgTitle] = useState('')
  const [cfgBody, setCfgBody] = useState('')
  const [cfgUrl, setCfgUrl] = useState('')
  const [saving, setSaving] = useState(false)

  async function save() {
    setSaving(true)
    try {
      const conditions = condField ? [{ field: condField, op: condOp, value: condValue }] : []
      const actionConfig: Record<string, unknown> =
        actionType === 'webhook' ? { url: cfgUrl }
          : actionType === 'telegram' ? { title: cfgTitle, message: cfgBody }
            : { title: cfgTitle, body: cfgBody }
      await automationApi.createRule({ name, trigger, actionType, conditions, actionConfig, enabled: false, dryRun: true })
      onSaved()
    } catch (e) { onError((e as Error).message) } finally { setSaving(false) }
  }

  return (
    <Modal open onClose={onClose} title="New rule" primaryAction={{ content: 'Create (off)', onAction: save, loading: saving, disabled: !name || !trigger }} secondaryActions={[{ content: 'Cancel', onAction: onClose }]}>
      <Modal.Section>
        <BlockStack gap="300">
          <TextField label="Name" value={name} onChange={setName} autoComplete="off" />
          <Select label="Trigger event" options={events.map((e) => ({ label: e, value: e }))} value={trigger} onChange={setTrigger} />
          <Divider />
          <Text as="h3" variant="headingSm">Condition (optional)</Text>
          <InlineStack gap="200">
            <TextField label="Field" labelHidden placeholder="field (e.g. status)" value={condField} onChange={setCondField} autoComplete="off" />
            <Select label="Op" labelHidden options={['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains'].map((o) => ({ label: o, value: o }))} value={condOp} onChange={setCondOp} />
            <TextField label="Value" labelHidden placeholder="value" value={condValue} onChange={setCondValue} autoComplete="off" />
          </InlineStack>
          <Divider />
          <Select label="Action" options={actions.map((a) => ({ label: a, value: a }))} value={actionType} onChange={setActionType} />
          {actionType === 'webhook'
            ? <TextField label="Webhook URL" value={cfgUrl} onChange={setCfgUrl} autoComplete="off" placeholder="https://…" />
            : (
              <>
                <TextField label="Title" value={cfgTitle} onChange={setCfgTitle} autoComplete="off" helpText="Supports {{field}} from the event payload" />
                <TextField label={actionType === 'telegram' ? 'Message' : 'Body'} value={cfgBody} onChange={setCfgBody} autoComplete="off" multiline={2} />
              </>
            )}
          <Banner tone="info">New rules start disabled and in dry-run. Enable + “Go live” only once you’ve verified it.</Banner>
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}
