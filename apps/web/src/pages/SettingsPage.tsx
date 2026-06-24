import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Banner,
  Divider,
  Badge
} from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { api, PanelSettings } from '../api/client'

const EMPTY: PanelSettings = {
  panel_title: '',
  panel_url: '',
  notify_email: '',
  deploy_slack_webhook: ''
}

export function SettingsPage() {
  const [settings, setSettings] = useState<PanelSettings>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [savingGeneral, setSavingGeneral] = useState(false)
  const [generalResult, setGeneralResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPwd, setSavingPwd] = useState(false)
  const [pwdResult, setPwdResult] = useState<{ ok: boolean; msg: string } | null>(null)

  useEffect(() => {
    api.settings
      .get()
      .then(setSettings)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  const handleSaveGeneral = async () => {
    setSavingGeneral(true)
    setGeneralResult(null)
    try {
      await api.settings.update({
        panel_title: settings.panel_title,
        panel_url: settings.panel_url,
        notify_email: settings.notify_email,
        deploy_slack_webhook: settings.deploy_slack_webhook
      })
      setGeneralResult({ ok: true, msg: 'Settings saved.' })
    } catch (err: unknown) {
      setGeneralResult({ ok: false, msg: err instanceof Error ? err.message : 'Save failed' })
    } finally {
      setSavingGeneral(false)
    }
  }

  const handleChangePassword = async () => {
    setPwdResult(null)
    if (newPassword !== confirmPassword) {
      setPwdResult({ ok: false, msg: 'New passwords do not match.' })
      return
    }
    if (newPassword.length < 8) {
      setPwdResult({ ok: false, msg: 'Password must be at least 8 characters.' })
      return
    }
    setSavingPwd(true)
    try {
      const res = await api.settings.changePassword(oldPassword, newPassword)
      setPwdResult({ ok: true, msg: res.message })
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (err: unknown) {
      setPwdResult({ ok: false, msg: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setSavingPwd(false)
    }
  }

  if (loading) return null

  return (
    <Page title="Settings">
      <Layout>

        {/* ── General ───────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">General</Text>

              {generalResult && (
                <Banner
                  tone={generalResult.ok ? 'success' : 'critical'}
                  onDismiss={() => setGeneralResult(null)}
                >
                  {generalResult.msg}
                </Banner>
              )}

              <TextField
                label="Panel title"
                value={settings.panel_title}
                onChange={(v) => setSettings((s) => ({ ...s, panel_title: v }))}
                helpText="Shown in the browser tab and header."
                autoComplete="off"
              />
              <TextField
                label="Panel URL"
                value={settings.panel_url}
                onChange={(v) => setSettings((s) => ({ ...s, panel_url: v }))}
                helpText="Base URL used to generate webhook URLs. No trailing slash."
                autoComplete="off"
                placeholder="https://deploy.example.com"
              />

              <Divider />

              <Text as="h3" variant="headingSm">Notifications (optional)</Text>
              <TextField
                label="Notify email"
                type="email"
                value={settings.notify_email}
                onChange={(v) => setSettings((s) => ({ ...s, notify_email: v }))}
                helpText="Receive an email on deploy failure. Leave blank to disable."
                autoComplete="email"
                placeholder="you@example.com"
              />
              <TextField
                label="Slack webhook URL"
                value={settings.deploy_slack_webhook}
                onChange={(v) => setSettings((s) => ({ ...s, deploy_slack_webhook: v }))}
                helpText="Post deploy results to a Slack channel. Leave blank to disable."
                autoComplete="off"
                placeholder="https://hooks.slack.com/services/…"
              />

              <InlineStack align="end">
                <Button variant="primary" onClick={handleSaveGeneral} loading={savingGeneral}>
                  Save settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Email notifications ───────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Email Notifications</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Email alerts are sent on deploy success/failure to the address above.
                SMTP is configured via environment variables in the API <Badge>apps/api/.env</Badge>
              </Text>
              <div style={{ background: '#f6f6f7', borderRadius: 8, padding: '12px 16px', fontFamily: 'monospace', fontSize: 12 }}>
                {[
                  'SMTP_HOST=smtp.example.com',
                  'SMTP_PORT=587',
                  'SMTP_SECURE=false',
                  'SMTP_USER=user@example.com',
                  'SMTP_PASS=yourpassword',
                  'SMTP_FROM="Orchestrator <noreply@example.com>"',
                ].map((line) => (
                  <div key={line} style={{ color: '#333', lineHeight: 1.8 }}>{line}</div>
                ))}
              </div>
              <Text as="p" variant="bodySm" tone="subdued">
                Leave <Badge>SMTP_HOST</Badge> unset to disable email. Slack webhook above works independently.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Security ──────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Change password</Text>

              {pwdResult && (
                <Banner
                  tone={pwdResult.ok ? 'success' : 'critical'}
                  onDismiss={() => setPwdResult(null)}
                >
                  {pwdResult.msg}
                </Banner>
              )}

              <TextField
                label="Current password"
                type="password"
                value={oldPassword}
                onChange={setOldPassword}
                autoComplete="current-password"
              />
              <TextField
                label="New password"
                type="password"
                value={newPassword}
                onChange={setNewPassword}
                autoComplete="new-password"
                helpText="Minimum 8 characters."
              />
              <TextField
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                error={
                  confirmPassword && confirmPassword !== newPassword
                    ? 'Passwords do not match'
                    : undefined
                }
              />
              <InlineStack align="end">
                <Button
                  variant="primary"
                  onClick={handleChangePassword}
                  loading={savingPwd}
                  disabled={!oldPassword || !newPassword || !confirmPassword}
                >
                  Change password
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── About ─────────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">About</Text>
              {[
                { label: 'Version',  value: 'v1.0.0' },
                { label: 'Stack',    value: 'Fastify · Prisma · SQLite · React · Polaris' },
                { label: 'Database', value: 'SQLite (dev.db)' },
                { label: 'API port', value: '3001 (bound to 127.0.0.1)' }
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                  <Badge>{value}</Badge>
                </div>
              ))}
            </BlockStack>
          </Card>
        </Layout.Section>

      </Layout>
    </Page>
  )
}
