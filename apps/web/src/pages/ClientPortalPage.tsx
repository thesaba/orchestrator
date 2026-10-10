import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, BlockStack, Box, Button, Card, DataTable, InlineStack, Page, Spinner, Text, TextField, Banner } from '@shopify/polaris'

/**
 * Public, read-only client portal. No login: the URL token is the credential.
 * It never exposes the internal enforcement ladder or any infrastructure
 * detail, and there is no "I've paid" button — payments are confirmed by the
 * operator only.
 */

interface PortalData {
  client: { name: string; company: string | null; locale: string; currency: string }
  sites: { domain: string; active: boolean; amountFormatted: string; nextInvoiceAt: string
    uptime24h: number | null; currentStatus: string; lastCheckedAt: string | null }[]
  outstanding: number
  outstandingFormatted: string
  invoices: {
    number: string; dueDate: string; status: string
    amountFormatted: string; balanceFormatted: string; balance: number
    periodStart: string; periodEnd: string; paidAt: string | null
  }[]
}

const T = {
  ka: {
    title: 'ჰოსტინგის ანგარიში',
    outstanding: 'გადასახდელი',
    allPaid: 'დავალიანება არ არის',
    sites: 'საიტები',
    invoices: 'ინვოისები',
    number: 'ნომერი', period: 'პერიოდი', due: 'ვადა', amount: 'თანხა', balance: 'ნაშთი', status: 'სტატუსი',
    active: 'აქტიური', suspended: 'შეჩერებული',
    monthly: 'თვიური', next: 'შემდეგი ინვოისი',
    uptime: 'ხელმისაწვდომობა', up: 'ჩართული', down: 'გათიშული',
    support: 'მხარდაჭერა', supportMsg: 'თქვენი შეტყობინება', supportSubject: 'თემა (არასავალდებულო)',
    send: 'გაგზავნა', sent: 'გაიგზავნა — მადლობა!',
    backups: 'ბექაფები', download: 'ჩამოტვირთვა', noBackups: 'ბექაფები არ არის',
    notFound: 'ბმული არასწორია ან აღარ მოქმედებს.',
    hint: 'გადახდის დასადასტურებლად დაუკავშირდით ადმინისტრატორს.'
  },
  en: {
    title: 'Hosting account',
    outstanding: 'Outstanding',
    allPaid: 'Nothing outstanding',
    sites: 'Sites',
    invoices: 'Invoices',
    number: 'Number', period: 'Period', due: 'Due', amount: 'Amount', balance: 'Balance', status: 'Status',
    active: 'Active', suspended: 'Suspended',
    monthly: 'Monthly', next: 'Next invoice',
    uptime: 'Uptime', up: 'Up', down: 'Down',
    support: 'Support', supportMsg: 'Your message', supportSubject: 'Subject (optional)',
    send: 'Send', sent: 'Sent — thank you!',
    backups: 'Backups', download: 'Download', noBackups: 'No backups available',
    notFound: 'This link is invalid or no longer active.',
    hint: 'Contact your administrator to confirm a payment.'
  }
}

const STATUS_TONE: Record<string, 'success' | 'critical' | 'attention' | 'info' | 'warning'> = {
  paid: 'success', overdue: 'critical', partial: 'attention', open: 'info', void: 'warning'
}

const day = (s: string) => new Date(s).toISOString().slice(0, 10)

export function ClientPortalPage() {
  const { token } = useParams<{ token: string }>()
  const [data, setData] = useState<PortalData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [backups, setBackups] = useState<{ sites: { siteId: number; domain: string; files: { filename: string; sizeBytes: number; createdAt: string }[] }[] } | null>(null)
  const [supportSubject, setSupportSubject] = useState('')
  const [supportMsg, setSupportMsg] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    fetch(`/api/portal/${token}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('404'))))
      .then(setData)
      .catch(() => setNotFound(true))
    fetch(`/api/portal/${token}/backups`).then((r) => (r.ok ? r.json() : null)).then(setBackups).catch(() => {})
  }, [token])

  async function submitSupport() {
    setSending(true)
    try {
      const r = await fetch(`/api/portal/${token}/support`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: supportSubject || undefined, message: supportMsg })
      })
      if (r.ok) { setSent(true); setSupportMsg(''); setSupportSubject('') }
    } finally { setSending(false) }
  }

  if (notFound) {
    return (
      <Page>
        <Box padding="800">
          <Text as="p" alignment="center" tone="subdued">{T.ka.notFound}</Text>
        </Box>
      </Page>
    )
  }
  if (!data) {
    return <Page><Box padding="800"><InlineStack align="center"><Spinner /></InlineStack></Box></Page>
  }

  const t = data.client.locale === 'en' ? T.en : T.ka

  return (
    <Page title={t.title} subtitle={data.client.company ?? data.client.name}>
      <BlockStack gap="400">
        <Card>
          <BlockStack gap="150">
            <Text as="p" variant="bodySm" tone="subdued">{t.outstanding}</Text>
            {data.outstanding > 0
              ? <Text as="p" variant="heading2xl" tone="critical">{data.outstandingFormatted}</Text>
              : <Text as="p" variant="headingLg" tone="success">{t.allPaid}</Text>}
            <Text as="p" variant="bodySm" tone="subdued">{t.hint}</Text>
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t.sites}</Text>
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'text', 'text']}
              headings={[t.sites, t.uptime, t.monthly, t.next, t.status]}
              rows={data.sites.map((s) => [
                s.domain,
                <InlineStack key={s.domain + '-up'} gap="150" blockAlign="center">
                  <Badge tone={s.currentStatus === 'up' ? 'success' : s.currentStatus === 'down' ? 'critical' : undefined}>
                    {s.currentStatus === 'up' ? t.up : s.currentStatus === 'down' ? t.down : '—'}
                  </Badge>
                  <Text as="span" variant="bodySm" tone="subdued">{s.uptime24h === null ? '' : `${s.uptime24h}%`}</Text>
                </InlineStack>,
                s.amountFormatted,
                day(s.nextInvoiceAt),
                <Badge key={s.domain} tone={s.active ? 'success' : 'critical'}>
                  {s.active ? t.active : t.suspended}
                </Badge>
              ])}
            />
          </BlockStack>
        </Card>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t.invoices}</Text>
            <DataTable
              columnContentTypes={['text', 'text', 'text', 'numeric', 'numeric', 'text']}
              headings={[t.number, t.period, t.due, t.amount, t.balance, t.status]}
              rows={data.invoices.map((i) => [
                i.number,
                `${day(i.periodStart)} → ${day(i.periodEnd)}`,
                day(i.dueDate),
                i.amountFormatted,
                i.balance > 0 ? i.balanceFormatted : '—',
                <Badge key={i.number} tone={STATUS_TONE[i.status] ?? 'info'}>{i.status}</Badge>
              ])}
            />
          </BlockStack>
        </Card>

        {backups && backups.sites.some((s) => s.files.length > 0) && (
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">{t.backups}</Text>
              {backups.sites.filter((s) => s.files.length > 0).map((s) => (
                <BlockStack key={s.siteId} gap="150">
                  <Text as="h3" variant="headingSm">{s.domain}</Text>
                  {s.files.map((f) => (
                    <InlineStack key={f.filename} align="space-between" blockAlign="center">
                      <Text as="span" variant="bodySm">{f.filename} · {(f.sizeBytes / 1048576).toFixed(1)} MB · {day(f.createdAt)}</Text>
                      <Button size="slim" url={`/api/portal/${token}/backups/${s.siteId}/${encodeURIComponent(f.filename)}`} target="_blank">{t.download}</Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              ))}
            </BlockStack>
          </Card>
        )}

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">{t.support}</Text>
            {sent
              ? <Banner tone="success">{t.sent}</Banner>
              : (
                <BlockStack gap="200">
                  <TextField label={t.supportSubject} labelHidden placeholder={t.supportSubject} value={supportSubject} onChange={setSupportSubject} autoComplete="off" />
                  <TextField label={t.supportMsg} labelHidden placeholder={t.supportMsg} value={supportMsg} onChange={setSupportMsg} multiline={4} autoComplete="off" />
                  <InlineStack align="end">
                    <Button variant="primary" loading={sending} disabled={!supportMsg.trim()} onClick={submitSupport}>{t.send}</Button>
                  </InlineStack>
                </BlockStack>
              )}
          </BlockStack>
        </Card>
      </BlockStack>
    </Page>
  )
}
