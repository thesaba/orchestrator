import { useCallback, useEffect, useState } from 'react'
import {
  Badge, Banner, BlockStack, Box, Button, Card, DataTable, Divider, InlineStack,
  Layout, Modal, Page, Select, Spinner, Tabs, Text, TextField
} from '@shopify/polaris'
import {
  billingApi, formatMinor,
  type BillingClient, type BillingInvoice, type BillingOverview,
  type BillingSubscription, type EnforcementLevel, type EnforcementMode,
  type SubscriptionPreview, type TickReport
} from '../api/client'
import { api } from '../api/client'

// Ladder rungs, least → most severe. Used for the level badge.
const LEVEL_TONE: Record<EnforcementLevel, 'success' | 'attention' | 'warning' | 'critical'> = {
  none: 'success',
  banner: 'attention',
  restrict: 'warning',
  suspend: 'critical',
  archived: 'critical'
}
const LEVEL_LABEL: Record<EnforcementLevel, string> = {
  none: 'Active',
  banner: 'Banner',
  restrict: 'Restricted',
  suspend: 'Suspended',
  archived: 'Archived'
}

const INVOICE_TONE: Record<string, 'success' | 'attention' | 'warning' | 'critical' | 'info'> = {
  paid: 'success', open: 'info', partial: 'attention', overdue: 'critical', void: 'warning', draft: 'info'
}

export function BillingPage() {
  const [tab, setTab] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  const [overview, setOverview] = useState<BillingOverview | null>(null)
  const [clients, setClients] = useState<BillingClient[]>([])
  const [subs, setSubs] = useState<BillingSubscription[]>([])
  const [invoices, setInvoices] = useState<BillingInvoice[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [o, c, s, i] = await Promise.all([
        billingApi.overview(), billingApi.clients(),
        billingApi.subscriptions(), billingApi.invoices()
      ])
      setOverview(o); setClients(c); setSubs(s); setInvoices(i)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const notify = (msg: string) => { setFlash(msg); setTimeout(() => setFlash(null), 6000) }

  if (loading && !overview) {
    return <Page title="Billing"><Box padding="800"><InlineStack align="center"><Spinner /></InlineStack></Box></Page>
  }

  return (
    <Page title="Billing" subtitle="Clients, invoices and automatic suspension for non-payment">
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>}
        {flash && <Banner tone="success" onDismiss={() => setFlash(null)}>{flash}</Banner>}

        <EnforcementCard overview={overview} onChanged={load} notify={notify} onError={setError} />

        <Tabs
          selected={tab}
          onSelect={setTab}
          tabs={[
            { id: 'overview', content: 'Overview' },
            { id: 'subs', content: `Subscriptions (${subs.filter((s) => s.status !== 'cancelled').length})` },
            { id: 'invoices', content: `Invoices (${invoices.filter((i) => i.status !== 'paid' && i.status !== 'void').length} open)` },
            { id: 'clients', content: `Clients (${clients.length})` },
            { id: 'profit', content: 'Profitability' }
          ]}
        >
          <Box paddingBlockStart="400">
            {tab === 0 && <OverviewTab overview={overview} />}
            {tab === 1 && <SubscriptionsTab subs={subs} clients={clients} onChanged={load} notify={notify} onError={setError} />}
            {tab === 2 && <InvoicesTab invoices={invoices} onChanged={load} notify={notify} onError={setError} />}
            {tab === 3 && <ClientsTab clients={clients} onChanged={load} notify={notify} onError={setError} />}
            {tab === 4 && <ProfitabilityTab onError={setError} />}
          </Box>
        </Tabs>
      </BlockStack>
    </Page>
  )
}

// ── Master switch ───────────────────────────────────────────────────────────

function EnforcementCard({
  overview, onChanged, notify, onError
}: {
  overview: BillingOverview | null
  onChanged: () => void
  notify: (m: string) => void
  onError: (m: string) => void
}) {
  const [mode, setMode] = useState<EnforcementMode>(overview?.mode ?? 'off')
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<TickReport | null>(null)

  useEffect(() => { if (overview) setMode(overview.mode) }, [overview])

  const save = async (m: EnforcementMode) => {
    setBusy(true)
    try {
      await billingApi.setEnforcement(m)
      setMode(m)
      notify(
        m === 'on' ? 'Enforcement is ON — the ladder will now suspend unpaid sites.'
          : m === 'dry_run' ? 'Dry run — actions are recorded but nothing is applied.'
          : 'Enforcement is OFF — no site will ever be touched.'
      )
      onChanged()
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  const runTick = async (dryRun: boolean) => {
    setBusy(true)
    try {
      const r = await billingApi.runTick(dryRun)
      setReport(r)
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <BlockStack gap="100">
            <Text as="h2" variant="headingMd">Enforcement</Text>
            <Text as="p" tone="subdued" variant="bodySm">
              Controls whether the dunning ladder may change a live site. Invoices and reminders
              are unaffected — only suspension is gated.
            </Text>
          </BlockStack>
          <Box minWidth="200px">
            <Select
              label="Mode"
              labelHidden
              disabled={busy}
              value={mode}
              onChange={(v) => save(v as EnforcementMode)}
              options={[
                { label: 'Off — never touch a site', value: 'off' },
                { label: 'Dry run — record only', value: 'dry_run' },
                { label: 'On — enforce the ladder', value: 'on' }
              ]}
            />
          </Box>
        </InlineStack>

        {mode === 'on' && (
          <Banner tone="warning">
            Enforcement is live. Sites with overdue invoices will be escalated automatically —
            banner, then restricted, then suspended. Clients flagged “never auto-suspend” stop at the banner.
          </Banner>
        )}

        <InlineStack gap="200">
          <Button loading={busy} onClick={() => runTick(true)}>Preview today’s run (dry)</Button>
          <Button loading={busy} disabled={mode !== 'on'} onClick={() => runTick(false)} variant="primary">
            Run billing now
          </Button>
        </InlineStack>

        {report && (
          <Box background="bg-surface-secondary" padding="300" borderRadius="200">
            <BlockStack gap="150">
              <Text as="p" variant="headingSm">Run report — mode: {report.mode}</Text>
              <TickLine label="Invoices issued" items={report.issued} />
              <TickLine label="Notifications" items={report.notified} />
              <TickLine label="Escalated" items={report.escalated} />
              <TickLine label="Restored" items={report.restored} />
              <TickLine label="Skipped" items={report.skipped} />
              <TickLine label="Errors" items={report.errors} critical />
            </BlockStack>
          </Box>
        )}
      </BlockStack>
    </Card>
  )
}

function TickLine({ label, items, critical }: { label: string; items: string[]; critical?: boolean }) {
  if (!items.length) return null
  return (
    <Text as="p" variant="bodySm" tone={critical ? 'critical' : 'subdued'}>
      <b>{label}:</b> {items.join(' · ')}
    </Text>
  )
}

// ── Overview ────────────────────────────────────────────────────────────────

function OverviewTab({ overview }: { overview: BillingOverview | null }) {
  if (!overview) return null
  const c = overview.currency
  const stat = (label: string, value: string, tone?: 'critical' | 'success') => (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="headingLg" tone={tone}>{value}</Text>
      </BlockStack>
    </Card>
  )
  return (
    <BlockStack gap="400">
      <Layout>
        <Layout.Section variant="oneThird">{stat('Monthly recurring revenue', formatMinor(overview.mrr, c))}</Layout.Section>
        <Layout.Section variant="oneThird">
          {stat('Outstanding', formatMinor(overview.outstanding, c), overview.outstanding > 0 ? 'critical' : 'success')}
        </Layout.Section>
        <Layout.Section variant="oneThird">{stat('Suspended sites', String(overview.suspended), overview.suspended ? 'critical' : undefined)}</Layout.Section>
      </Layout>

      <Card>
        <BlockStack gap="300">
          <Text as="h3" variant="headingMd">Receivables aging</Text>
          <DataTable
            columnContentTypes={['text', 'numeric']}
            headings={['Bucket', 'Amount']}
            rows={[
              ['Not yet due', formatMinor(overview.aging.current, c)],
              ['1–30 days overdue', formatMinor(overview.aging.d1_30, c)],
              ['31–60 days overdue', formatMinor(overview.aging.d31_60, c)],
              ['60+ days overdue', formatMinor(overview.aging.d61_plus, c)]
            ]}
            totals={['', formatMinor(overview.aging.total, c)]}
            showTotalsInFooter
          />
        </BlockStack>
      </Card>
    </BlockStack>
  )
}

// ── Subscriptions ───────────────────────────────────────────────────────────

function SubscriptionsTab({
  subs, clients, onChanged, notify, onError
}: {
  subs: BillingSubscription[]; clients: BillingClient[]
  onChanged: () => void; notify: (m: string) => void; onError: (m: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [previewFor, setPreviewFor] = useState<BillingSubscription | null>(null)
  const [cancelling, setCancelling] = useState<BillingSubscription | null>(null)

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); notify(msg); onChanged() } catch (e) { onError((e as Error).message) }
  }

  const rows = subs
    .filter((s) => s.status !== 'cancelled')
    .map((s) => [
      s.site?.domain ?? '—',
      s.client?.name ?? '—',
      formatMinor(s.amount, s.currency),
      new Date(s.nextInvoiceAt).toISOString().slice(0, 10),
      <Badge key={`b${s.id}`} tone={LEVEL_TONE[s.enforcementLevel]}>
        {s.neverAutoSuspend ? `${LEVEL_LABEL[s.enforcementLevel]} · VIP` : LEVEL_LABEL[s.enforcementLevel]}
      </Badge>,
      <InlineStack key={`a${s.id}`} gap="100">
        <Button size="micro" onClick={() => setPreviewFor(s)}>Preview</Button>
        <Button size="micro" onClick={() => act(() => billingApi.issueInvoice(s.id), 'Invoice issued')}>Invoice</Button>
        {s.enforcementLevel !== 'none' && (
          <Button size="micro" tone="success" onClick={() => act(() => billingApi.enforce(s.id, 'none'), 'Site restored')}>
            Restore
          </Button>
        )}
        <Button size="micro" tone="critical" onClick={() => setCancelling(s)}>Cancel billing</Button>
      </InlineStack>
    ])

  return (
    <BlockStack gap="300">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Subscriptions</Text>
            <Button variant="primary" onClick={() => setAdding(true)}>Add subscription</Button>
          </InlineStack>
          {rows.length === 0
            ? <Text as="p" tone="subdued">No subscriptions yet.</Text>
            : <DataTable
                columnContentTypes={['text', 'text', 'numeric', 'text', 'text', 'text']}
                headings={['Site', 'Client', 'Amount', 'Next invoice', 'State', '']}
                rows={rows}
              />}
        </BlockStack>
      </Card>

      {adding && <AddSubscriptionModal clients={clients} onClose={() => setAdding(false)} onDone={() => { setAdding(false); notify('Subscription created'); onChanged() }} onError={onError} />}
      {previewFor && <PreviewModal sub={previewFor} onClose={() => setPreviewFor(null)} />}
      {cancelling && (
        <Modal
          open
          onClose={() => setCancelling(null)}
          title={`Cancel billing — ${cancelling.site?.domain ?? ''}`}
          primaryAction={{
            content: 'Cancel billing',
            destructive: true,
            onAction: async () => {
              const id = cancelling.id
              setCancelling(null)
              await act(() => billingApi.cancelSubscription(id), 'Billing cancelled — the site is untouched')
            }
          }}
          secondaryActions={[{ content: 'Keep billing', onAction: () => setCancelling(null) }]}
        >
          <Modal.Section>
            <BlockStack gap="200">
              <Text as="p">
                Stop billing <b>{cancelling.site?.domain}</b>. No further invoices are issued and the
                dunning ladder stops.
              </Text>
              {cancelling.enforcementLevel !== 'none' && (
                <Banner tone="success">Any active suspension or banner is lifted immediately — the site is restored.</Banner>
              )}
              <Text as="p" tone="subdued" variant="bodySm">
                The site itself is not touched. Past invoices are kept as history. You can add billing to this
                site again later.
              </Text>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </BlockStack>
  )
}

function PreviewModal({ sub, onClose }: { sub: BillingSubscription; onClose: () => void }) {
  const [p, setP] = useState<SubscriptionPreview | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    billingApi.preview(sub.id).then(setP).catch((e) => setErr((e as Error).message))
  }, [sub.id])

  return (
    <Modal open onClose={onClose} title={`What happens next — ${sub.site?.domain ?? ''}`} secondaryActions={[{ content: 'Close', onAction: onClose }]}>
      <Modal.Section>
        {err && <Banner tone="critical">{err}</Banner>}
        {!p && !err && <InlineStack align="center"><Spinner size="small" /></InlineStack>}
        {p && (
          <BlockStack gap="300">
            {p.balance === 0 ? (
              <Banner tone="success">Nothing outstanding. This site will not be touched.</Banner>
            ) : (
              <>
                <Text as="p">
                  Invoice <b>{p.invoice}</b> — balance <b>{formatMinor(p.balance, p.currency)}</b>,{' '}
                  {p.daysOverdue !== null && p.daysOverdue > 0
                    ? <Text as="span" tone="critical">{p.daysOverdue} days overdue</Text>
                    : <Text as="span" tone="subdued">not yet due</Text>}
                </Text>
                <InlineStack gap="200">
                  <Text as="span" tone="subdued">Currently:</Text>
                  <Badge tone={LEVEL_TONE[p.currentLevel]}>{LEVEL_LABEL[p.currentLevel]}</Badge>
                  <Text as="span" tone="subdued">→ should be:</Text>
                  <Badge tone={LEVEL_TONE[p.targetLevel]}>{LEVEL_LABEL[p.targetLevel]}</Badge>
                </InlineStack>
                {p.withinGrace && <Banner tone="info">Inside the grace period — enforcement is held back.</Banner>}
                {p.cappedByPolicy && <Banner tone="info">Capped at “banner”: this subscription never auto-suspends.</Banner>}
                {p.next
                  ? <Banner tone={p.next.level === 'suspend' ? 'warning' : 'info'}>
                      Next: <b>{p.next.action}</b> in {p.next.daysAway} day(s), on {new Date(p.next.date).toISOString().slice(0, 10)}.
                    </Banner>
                  : <Text as="p" tone="subdued">The ladder is exhausted — no further automatic action.</Text>}
              </>
            )}
            <Divider />
            <Text as="h3" variant="headingSm">Ladder</Text>
            <DataTable
              columnContentTypes={['numeric', 'text']}
              headings={['Day', 'Action']}
              rows={p.policy.map((s) => [s.offsetDays > 0 ? `+${s.offsetDays}` : String(s.offsetDays), s.action])}
            />
          </BlockStack>
        )}
      </Modal.Section>
    </Modal>
  )
}

function AddSubscriptionModal({
  clients, onClose, onDone, onError
}: { clients: BillingClient[]; onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [sites, setSites] = useState<{ label: string; value: string }[]>([])
  const [siteId, setSiteId] = useState('')
  const [clientId, setClientId] = useState(clients[0] ? String(clients[0].id) : '')
  const [amount, setAmount] = useState('')
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [anchorDay, setAnchorDay] = useState('')
  const [grace, setGrace] = useState('3')
  const [vip, setVip] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.sites.list().then((r: any) => {
      const list = (r.sites ?? r) as { id: number; domain: string }[]
      setSites(list.map((s) => ({ label: s.domain, value: String(s.id) })))
      if (list[0]) setSiteId(String(list[0].id))
    }).catch(() => {})
  }, [])

  const submit = async () => {
    setBusy(true)
    try {
      await billingApi.createSubscription({
        siteId: Number(siteId),
        clientId: Number(clientId),
        amount,
        // Midday UTC keeps the calendar day stable in Asia/Tbilisi (UTC+4).
        startDate: startDate ? `${startDate}T12:00:00.000Z` : undefined,
        anchorDay: anchorDay ? Number(anchorDay) : null,
        gracePeriodDays: Number(grace) || 0,
        neverAutoSuspend: vip
      })
      onDone()
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal
      open onClose={onClose} title="Add subscription"
      primaryAction={{ content: 'Create', onAction: submit, loading: busy, disabled: !siteId || !clientId || !amount }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Select label="Site" options={sites} value={siteId} onChange={setSiteId} />
          <Select label="Client" options={clients.map((c) => ({ label: c.name, value: String(c.id) }))} value={clientId} onChange={setClientId} />
          <TextField label="Monthly amount" value={amount} onChange={setAmount} autoComplete="off" placeholder="30" helpText="In major units, e.g. 30 or 30.50" />
          <TextField label="First invoice date" type="date" value={startDate} onChange={setStartDate} autoComplete="off"
            helpText="The first invoice is issued — and falls due — on this date. Every later invoice uses the billing day below. Backdate it to test the overdue ladder." />
          <TextField label="Billing day of month" type="number" min={1} max={28} value={anchorDay} onChange={setAnchorDay} autoComplete="off" helpText="1–28. Each client can bill on a different day. Leave blank to reuse the first invoice date's day." />
          <TextField label="Grace period (days)" type="number" min={0} value={grace} onChange={setGrace} autoComplete="off" helpText="Enforcement is withheld this many days past the due date. Reminders still go out." />
          <Select label="Auto-suspend" value={vip ? 'no' : 'yes'} onChange={(v) => setVip(v === 'no')}
            options={[{ label: 'Yes — follow the full ladder', value: 'yes' }, { label: 'No — never suspend (VIP), stop at banner', value: 'no' }]} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

// ── Invoices ────────────────────────────────────────────────────────────────

function InvoicesTab({
  invoices, onChanged, notify, onError
}: { invoices: BillingInvoice[]; onChanged: () => void; notify: (m: string) => void; onError: (m: string) => void }) {
  const [paying, setPaying] = useState<BillingInvoice | null>(null)

  const voidIt = async (inv: BillingInvoice) => {
    if (!window.confirm(`Void ${inv.number}? This cannot be undone.`)) return
    try { await billingApi.voidInvoice(inv.id); notify(`${inv.number} voided`); onChanged() }
    catch (e) { onError((e as Error).message) }
  }

  const rows = invoices.map((i) => [
    i.number,
    i.site?.domain ?? '—',
    i.client?.name ?? '—',
    formatMinor(i.amount, i.currency),
    // A voided invoice is owed by nobody — showing its balance is misleading.
    i.status !== 'void' && i.balance > 0 ? formatMinor(i.balance, i.currency) : '—',
    new Date(i.dueDate).toISOString().slice(0, 10),
    <Badge key={`s${i.id}`} tone={INVOICE_TONE[i.status] ?? 'info'}>{i.status}</Badge>,
    <InlineStack key={`a${i.id}`} gap="100">
      {i.status !== 'paid' && i.status !== 'void' && (
        <Button size="micro" variant="primary" onClick={() => setPaying(i)}>Mark paid</Button>
      )}
      {i.status !== 'paid' && i.status !== 'void' && (
        <Button size="micro" tone="critical" onClick={() => voidIt(i)}>Void</Button>
      )}
    </InlineStack>
  ])

  return (
    <BlockStack gap="300">
      <Card>
        {rows.length === 0
          ? <Box padding="400"><Text as="p" tone="subdued">No invoices yet.</Text></Box>
          : <DataTable
              columnContentTypes={['text', 'text', 'text', 'numeric', 'numeric', 'text', 'text', 'text']}
              headings={['Number', 'Site', 'Client', 'Amount', 'Balance', 'Due', 'Status', '']}
              rows={rows}
            />}
      </Card>
      {paying && (
        <MarkPaidModal
          invoice={paying}
          onClose={() => setPaying(null)}
          onDone={(restored) => {
            setPaying(null)
            notify(restored ? 'Payment recorded — site restored.' : 'Payment recorded.')
            onChanged()
          }}
          onError={onError}
        />
      )}
    </BlockStack>
  )
}

function MarkPaidModal({
  invoice, onClose, onDone, onError
}: { invoice: BillingInvoice; onClose: () => void; onDone: (restored: boolean) => void; onError: (m: string) => void }) {
  const [amount, setAmount] = useState((invoice.balance / 100).toFixed(2))
  const [method, setMethod] = useState('cash')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const r = await billingApi.pay(invoice.id, { amount, method, reference: reference || undefined, note: note || undefined })
      onDone(r.restored)
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  const full = Math.round(Number(amount) * 100) >= invoice.balance

  return (
    <Modal
      open onClose={onClose} title={`Record payment — ${invoice.number}`}
      primaryAction={{ content: full ? 'Mark fully paid' : 'Record partial payment', onAction: submit, loading: busy }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" tone="subdued">
            Balance due: <b>{formatMinor(invoice.balance, invoice.currency)}</b>
          </Text>
          <TextField label="Amount received" value={amount} onChange={setAmount} autoComplete="off" suffix={invoice.currency} />
          <Select label="Method" value={method} onChange={setMethod} options={[
            { label: 'Cash', value: 'cash' },
            { label: 'Bank transfer', value: 'bank_transfer' },
            { label: 'Card', value: 'card' },
            { label: 'Other', value: 'other' }
          ]} />
          <TextField label="Reference (optional)" value={reference} onChange={setReference} autoComplete="off"
            helpText="Bank reference or receipt number. Used later to reconcile imported statements." />
          <TextField label="Note (optional)" value={note} onChange={setNote} autoComplete="off" multiline={2} />
          {full && <Banner tone="info">Paying in full will immediately lift any suspension on this site.</Banner>}
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

// ── Clients ─────────────────────────────────────────────────────────────────

function ClientsTab({
  clients, onChanged, notify, onError
}: { clients: BillingClient[]; onChanged: () => void; notify: (m: string) => void; onError: (m: string) => void }) {
  const [adding, setAdding] = useState(false)

  const copyPortal = async (c: BillingClient) => {
    if (!c.portalToken) return
    const url = `${window.location.origin}/client/${c.portalToken}`
    await navigator.clipboard.writeText(url).catch(() => {})
    notify('Portal link copied to clipboard')
  }

  const rows = clients.map((c) => [
    c.name,
    c.email ?? c.phone ?? '—',
    c.sites.join(', ') || '—',
    c.outstanding > 0
      ? <Text key={`o${c.id}`} as="span" tone="critical">{formatMinor(c.outstanding, c.currency)}</Text>
      : <Text key={`o${c.id}`} as="span" tone="subdued">—</Text>,
    <Button key={`p${c.id}`} size="micro" disabled={!c.portalToken} onClick={() => copyPortal(c)}>Copy portal link</Button>
  ])

  return (
    <BlockStack gap="300">
      <Card>
        <BlockStack gap="300">
          <InlineStack align="space-between" blockAlign="center">
            <Text as="h2" variant="headingMd">Clients</Text>
            <Button variant="primary" onClick={() => setAdding(true)}>Add client</Button>
          </InlineStack>
          {rows.length === 0
            ? <Text as="p" tone="subdued">No clients yet.</Text>
            : <DataTable
                columnContentTypes={['text', 'text', 'text', 'numeric', 'text']}
                headings={['Name', 'Contact', 'Sites', 'Outstanding', '']}
                rows={rows}
              />}
        </BlockStack>
      </Card>
      {adding && (
        <AddClientModal
          onClose={() => setAdding(false)}
          onDone={() => { setAdding(false); notify('Client created'); onChanged() }}
          onError={onError}
        />
      )}
    </BlockStack>
  )
}

function AddClientModal({ onClose, onDone, onError }: { onClose: () => void; onDone: () => void; onError: (m: string) => void }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [locale, setLocale] = useState('ka')
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      await billingApi.createClient({
        name,
        email: email || undefined,
        phone: phone || undefined,
        locale
      } as Partial<BillingClient>)
      onDone()
    } catch (e) { onError((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal
      open onClose={onClose} title="Add client"
      primaryAction={{ content: 'Create', onAction: submit, loading: busy, disabled: !name.trim() }}
      secondaryActions={[{ content: 'Cancel', onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <TextField label="Name" value={name} onChange={setName} autoComplete="off" requiredIndicator />
          <TextField label="Email" type="email" value={email} onChange={setEmail} autoComplete="off" />
          <TextField label="Phone" value={phone} onChange={setPhone} autoComplete="off" />
          <Select label="Language for reminders" value={locale} onChange={setLocale}
            options={[{ label: 'ქართული', value: 'ka' }, { label: 'English', value: 'en' }]} />
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}

// ── Profitability ───────────────────────────────────────────────────────────
// Orchestrator already knows which server each site lives on. Joining that with
// what the client pays surfaces the outlier a generic billing tool can't see:
// the client paying the least while sharing the most crowded box.

function ProfitabilityTab({ onError }: { onError: (m: string) => void }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof billingApi.profitability>>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    billingApi.profitability()
      .then(setRows)
      .catch((e) => onError((e as Error).message))
      .finally(() => setLoading(false))
  }, [onError])

  if (loading) return <Box padding="600"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
  if (!rows.length) return <Card><Box padding="400"><Text as="p" tone="subdued">No subscriptions to analyse yet.</Text></Box></Card>

  // Revenue per site on a shared box: the lower this is, the worse the deal.
  const scored = [...rows]
    .map((r) => ({ ...r, perSiteShare: Math.round(r.amount / Math.max(1, r.sitesOnServer)) }))
    .sort((a, b) => a.perSiteShare - b.perSiteShare)

  return (
    <BlockStack gap="300">
      <Banner tone="info">
        Sites sharing a crowded server while paying the least are the first candidates to
        re-price or move to their own droplet.
      </Banner>
      <Card>
        <DataTable
          columnContentTypes={['text', 'text', 'numeric', 'numeric', 'numeric', 'text']}
          headings={['Site', 'Client', 'Pays', 'Sites on server', 'Revenue ÷ sites', 'State']}
          rows={scored.map((r) => [
            r.domain,
            r.client,
            r.amountFormatted,
            String(r.sitesOnServer),
            formatMinor(r.perSiteShare, r.currency),
            <Badge key={r.siteId} tone={LEVEL_TONE[r.enforcementLevel]}>{LEVEL_LABEL[r.enforcementLevel]}</Badge>
          ])}
        />
      </Card>
    </BlockStack>
  )
}
