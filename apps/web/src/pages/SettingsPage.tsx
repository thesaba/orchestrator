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
  Badge,
  Select
} from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { api, PanelSettings, s3Api, DODroplet } from '../api/client'
import { useToast } from '../context/toast'
import { useAuth } from '../context/AuthContext'

const EMPTY: PanelSettings = {
  panel_title: '',
  panel_url: '',
  notify_email: '',
  deploy_slack_webhook: '',
  deploy_discord_webhook: '',
  deploy_telegram_bot_token: '',
  deploy_telegram_chat_id: '',
  deploy_generic_webhook: '',
  cloudflare_api_token: '',
  cloudflare_zone_id: '',
  server_public_ip: ''
}

export function SettingsPage() {
  const showToast = useToast()
  const { isAdmin } = useAuth()
  const [settings,    setSettings]    = useState<PanelSettings>(EMPTY)
  const [loading,     setLoading]     = useState(true)
  const [savingGeneral, setSavingGeneral] = useState(false)

  const [oldPassword,     setOldPassword]     = useState('')
  const [newPassword,     setNewPassword]     = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [savingPwd,       setSavingPwd]       = useState(false)
  const [pwdResult,       setPwdResult]       = useState<{ ok: boolean; msg: string } | null>(null)

  // 2FA state
  const [totpEnabled,    setTotpEnabled]    = useState(false)
  const [qrDataUrl,      setQrDataUrl]      = useState<string | null>(null)
  const [totpSecret,     setTotpSecret]     = useState('')
  const [totpCode,       setTotpCode]       = useState('')
  const [totpLoading,    setTotpLoading]    = useState(false)
  const [totpError,      setTotpError]      = useState<string | null>(null)
  const [setupStep,      setSetupStep]      = useState<'idle' | 'scan' | 'verify'>('idle')

  // S3/R2 state
  const [s3AccessKey,  setS3AccessKey]  = useState('')
  const [s3SecretKey,  setS3SecretKey]  = useState('')
  const [s3Region,     setS3Region]     = useState('auto')
  const [s3Bucket,     setS3Bucket]     = useState('')
  const [s3Endpoint,   setS3Endpoint]   = useState('')
  const [savingS3,     setSavingS3]     = useState(false)

  // MySQL root credentials state
  const [mysqlRootUser, setMysqlRootUser] = useState('')
  const [mysqlRootPass, setMysqlRootPass] = useState('')
  const [savingMysql,   setSavingMysql]   = useState(false)

  // DigitalOcean API state
  const [doToken,      setDoToken]      = useState('')
  const [doDropletId,  setDoDropletId]  = useState('')
  const [doDroplets,   setDoDroplets]   = useState<DODroplet[]>([])
  const [doLoadingList, setDoLoadingList] = useState(false)
  const [savingDo,     setSavingDo]     = useState(false)

  const saveS3 = async () => {
    setSavingS3(true)
    try {
      await s3Api.saveSettings({
        s3_access_key: s3AccessKey,
        s3_secret_key: s3SecretKey,
        s3_region: s3Region,
        s3_bucket: s3Bucket,
        ...(s3Endpoint ? { s3_endpoint: s3Endpoint } : {})
      })
      showToast('S3/R2 settings saved')
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
    } finally { setSavingS3(false) }
  }

  useEffect(() => {
    api.settings.get().then((s) => {
      // Merge over defaults so keys absent from the response stay '' (controlled).
      setSettings((prev) => ({ ...prev, ...s }))
      if ((s as any).s3_access_key)    setS3AccessKey((s as any).s3_access_key)
      if ((s as any).s3_region)        setS3Region((s as any).s3_region)
      if ((s as any).s3_bucket)        setS3Bucket((s as any).s3_bucket)
      if ((s as any).s3_endpoint)      setS3Endpoint((s as any).s3_endpoint)
      if ((s as any).mysql_root_user)  setMysqlRootUser((s as any).mysql_root_user)
      if ((s as any).do_droplet_id)   setDoDropletId((s as any).do_droplet_id)
    }).catch(() => {}).finally(() => setLoading(false))
    api.auth.me().then((u) => setTotpEnabled(u?.totpEnabled ?? false)).catch(() => {})
  }, [])

  const handleSaveGeneral = async () => {
    setSavingGeneral(true)
    try {
      await api.settings.update({
        panel_title: settings.panel_title,
        panel_url: settings.panel_url,
        notify_email: settings.notify_email,
        deploy_slack_webhook: settings.deploy_slack_webhook,
        deploy_discord_webhook: settings.deploy_discord_webhook,
        deploy_telegram_bot_token: settings.deploy_telegram_bot_token,
        deploy_telegram_chat_id: settings.deploy_telegram_chat_id,
        deploy_generic_webhook: settings.deploy_generic_webhook,
        cloudflare_api_token: settings.cloudflare_api_token,
        cloudflare_zone_id: settings.cloudflare_zone_id,
        server_public_ip: settings.server_public_ip
      })
      showToast('Settings saved')
    } catch (err: unknown) {
      showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
    } finally {
      setSavingGeneral(false)
    }
  }

  const handleChangePassword = async () => {
    setPwdResult(null)
    if (newPassword !== confirmPassword) { setPwdResult({ ok: false, msg: 'New passwords do not match.' }); return }
    if (newPassword.length < 8)          { setPwdResult({ ok: false, msg: 'Password must be at least 8 characters.' }); return }
    setSavingPwd(true)
    try {
      const res = await api.settings.changePassword(oldPassword, newPassword)
      setPwdResult({ ok: true, msg: res.message })
      setOldPassword(''); setNewPassword(''); setConfirmPassword('')
    } catch (err: unknown) {
      setPwdResult({ ok: false, msg: err instanceof Error ? err.message : 'Failed' })
    } finally {
      setSavingPwd(false)
    }
  }

  const handle2faSetup = async () => {
    setTotpLoading(true); setTotpError(null)
    try {
      const res = await api.auth.setup2fa()
      setQrDataUrl(res.qrDataUrl)
      setTotpSecret(res.secret)
      setSetupStep('scan')
    } catch (err: unknown) {
      setTotpError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setTotpLoading(false)
    }
  }

  const handle2faEnable = async () => {
    setTotpLoading(true); setTotpError(null)
    try {
      await api.auth.enable2fa(totpCode)
      setTotpEnabled(true)
      setSetupStep('idle')
      setTotpCode('')
      showToast('Two-factor authentication enabled')
    } catch (err: unknown) {
      setTotpError(err instanceof Error ? err.message : 'Invalid code')
    } finally {
      setTotpLoading(false)
    }
  }

  const handle2faDisable = async () => {
    setTotpLoading(true); setTotpError(null)
    try {
      await api.auth.disable2fa()
      setTotpEnabled(false)
      showToast('Two-factor authentication disabled')
    } catch (err: unknown) {
      setTotpError(err instanceof Error ? err.message : 'Failed')
    } finally {
      setTotpLoading(false)
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
              <TextField
                label="Discord webhook URL"
                value={settings.deploy_discord_webhook}
                onChange={(v) => setSettings((s) => ({ ...s, deploy_discord_webhook: v }))}
                helpText="Post deploy & SSL alerts to a Discord channel. Leave blank to disable."
                autoComplete="off"
                placeholder="https://discord.com/api/webhooks/…"
              />
              <TextField
                label="Telegram bot token"
                type="password"
                value={settings.deploy_telegram_bot_token}
                onChange={(v) => setSettings((s) => ({ ...s, deploy_telegram_bot_token: v }))}
                helpText="From @BotFather. Stored encrypted. Leave blank to keep existing / disable."
                autoComplete="off"
                placeholder="123456:ABC-DEF…"
              />
              <TextField
                label="Telegram chat ID"
                value={settings.deploy_telegram_chat_id}
                onChange={(v) => setSettings((s) => ({ ...s, deploy_telegram_chat_id: v }))}
                helpText="Numeric chat/channel ID the bot posts to."
                autoComplete="off"
                placeholder="-1001234567890"
              />
              <TextField
                label="Generic webhook URL"
                value={settings.deploy_generic_webhook}
                onChange={(v) => setSettings((s) => ({ ...s, deploy_generic_webhook: v }))}
                helpText="POSTs a JSON payload for any custom integration (n8n, Zapier, …)."
                autoComplete="off"
                placeholder="https://example.com/webhooks/orchestrator"
              />
              <Divider />
              <Text as="h3" variant="headingSm">Cloudflare DNS (optional)</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                When set, provisioning a site automatically creates an A record pointing the
                domain at this server.
              </Text>
              <TextField
                label="Cloudflare API token"
                type="password"
                value={settings.cloudflare_api_token ?? ''}
                onChange={(v) => setSettings((s) => ({ ...s, cloudflare_api_token: v }))}
                helpText="Scoped token with DNS edit permission. Stored encrypted. Leave blank to keep existing."
                autoComplete="off"
                placeholder="••••••••"
              />
              <TextField
                label="Cloudflare Zone ID"
                value={settings.cloudflare_zone_id ?? ''}
                onChange={(v) => setSettings((s) => ({ ...s, cloudflare_zone_id: v }))}
                autoComplete="off"
                placeholder="Found on the domain's overview page in Cloudflare"
              />
              <TextField
                label="Server public IP (optional)"
                value={settings.server_public_ip ?? ''}
                onChange={(v) => setSettings((s) => ({ ...s, server_public_ip: v }))}
                helpText="Used for the A record. Auto-detected if left blank."
                autoComplete="off"
                placeholder="203.0.113.10"
              />
              <InlineStack align="end">
                <Button variant="primary" onClick={handleSaveGeneral} loading={savingGeneral}>
                  Save settings
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Email notifications info ───────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Email Notifications</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Email alerts are sent on deploy success/failure to the address above.
                SMTP is configured via environment variables in the API <Badge>apps/api/.env</Badge>
              </Text>
              <div className="oc-settings-code">
                {[
                  'SMTP_HOST=smtp.example.com',
                  'SMTP_PORT=587',
                  'SMTP_SECURE=false',
                  'SMTP_USER=user@example.com',
                  'SMTP_PASS=yourpassword',
                  'SMTP_FROM="Orchestrator <noreply@example.com>"',
                ].map((line) => (
                  <div key={line} style={{ lineHeight: 1.8 }}>{line}</div>
                ))}
              </div>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── Password + 2FA ────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Change password</Text>
              {pwdResult && (
                <Banner tone={pwdResult.ok ? 'success' : 'critical'} onDismiss={() => setPwdResult(null)}>
                  {pwdResult.msg}
                </Banner>
              )}
              <TextField label="Current password" type="password" value={oldPassword} onChange={setOldPassword} autoComplete="current-password" />
              <TextField label="New password" type="password" value={newPassword} onChange={setNewPassword} autoComplete="new-password" helpText="Minimum 8 characters." />
              <TextField
                label="Confirm new password"
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                autoComplete="new-password"
                error={confirmPassword && confirmPassword !== newPassword ? 'Passwords do not match' : undefined}
              />
              <InlineStack align="end">
                <Button variant="primary" onClick={handleChangePassword} loading={savingPwd} disabled={!oldPassword || !newPassword || !confirmPassword}>
                  Change password
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── 2FA ───────────────────────────────────────────────────────── */}
        <Layout.Section variant="oneHalf">
          <Card>
            <BlockStack gap="400">
              <InlineStack gap="300" blockAlign="center">
                <Text as="h2" variant="headingMd">Two-Factor Authentication</Text>
                <Badge tone={totpEnabled ? 'success' : 'info'}>{totpEnabled ? 'Enabled' : 'Disabled'}</Badge>
              </InlineStack>

              {totpError && <Banner tone="critical" onDismiss={() => setTotpError(null)}>{totpError}</Banner>}

              {!totpEnabled && setupStep === 'idle' && (
                <>
                  <Text as="p" tone="subdued" variant="bodySm">
                    Add an extra layer of security using Google Authenticator or any TOTP app.
                  </Text>
                  <Button variant="primary" onClick={handle2faSetup} loading={totpLoading}>Set up 2FA</Button>
                </>
              )}

              {setupStep === 'scan' && qrDataUrl && (
                <BlockStack gap="300">
                  <Text as="p" variant="bodySm">
                    Scan the QR code with your authenticator app, then enter the 6-digit code to confirm.
                  </Text>
                  <div style={{ display: 'flex', justifyContent: 'center' }}>
                    <img src={qrDataUrl} alt="2FA QR code" style={{ width: 180, height: 180 }} />
                  </div>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Or enter manually: <code style={{ userSelect: 'all' }}>{totpSecret}</code>
                  </Text>
                  <Button onClick={() => setSetupStep('verify')}>I've scanned it →</Button>
                </BlockStack>
              )}

              {setupStep === 'verify' && (
                <BlockStack gap="300">
                  <TextField
                    label="Authenticator code"
                    value={totpCode}
                    onChange={setTotpCode}
                    autoComplete="one-time-code"
                    maxLength={6}
                    placeholder="000000"
                  />
                  <InlineStack gap="300">
                    <Button variant="primary" onClick={handle2faEnable} loading={totpLoading} disabled={totpCode.length < 6}>
                      Enable 2FA
                    </Button>
                    <Button onClick={() => { setSetupStep('idle'); setTotpCode('') }}>Cancel</Button>
                  </InlineStack>
                </BlockStack>
              )}

              {totpEnabled && setupStep === 'idle' && (
                <Button tone="critical" onClick={handle2faDisable} loading={totpLoading}>
                  Disable 2FA
                </Button>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── S3/R2 Backup ──────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">S3 / R2 Backup Storage</Text>
              <Text as="p" variant="bodySm" tone="subdued">
                Configure credentials to upload database backups to S3-compatible storage (AWS S3, Cloudflare R2, MinIO, etc.). Set endpoint URL for non-AWS providers.
              </Text>
              <TextField label="Access Key ID" value={s3AccessKey} onChange={setS3AccessKey} autoComplete="off" />
              <TextField label="Secret Access Key" value={s3SecretKey} onChange={setS3SecretKey} type="password" autoComplete="off" placeholder="Leave blank to keep existing secret" />
              <TextField label="Region" value={s3Region} onChange={setS3Region} autoComplete="off" placeholder="auto (for R2) or us-east-1" />
              <TextField label="Bucket" value={s3Bucket} onChange={setS3Bucket} autoComplete="off" />
              <TextField label="Custom Endpoint URL (optional)" value={s3Endpoint} onChange={setS3Endpoint} autoComplete="off" placeholder="https://accountid.r2.cloudflarestorage.com (for R2)" />
              <InlineStack align="end">
                <Button variant="primary" onClick={saveS3} loading={savingS3}>Save S3 settings</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>

        {/* ── MySQL Root Credentials (admin only) ───────────────────────── */}
        {isAdmin && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">MySQL Root Credentials</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Required to create and drop databases from the Database tab.
                    Stored server-side only — never returned to the browser.
                  </Text>
                </BlockStack>
                <TextField
                  label="Root username"
                  value={mysqlRootUser}
                  onChange={setMysqlRootUser}
                  autoComplete="off"
                  placeholder="root"
                />
                <TextField
                  label="Root password"
                  type="password"
                  value={mysqlRootPass}
                  onChange={setMysqlRootPass}
                  autoComplete="new-password"
                  placeholder="Leave blank to keep existing password"
                />
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    loading={savingMysql}
                    onClick={async () => {
                      setSavingMysql(true)
                      try {
                        const data: Record<string, string> = { mysql_root_user: mysqlRootUser }
                        if (mysqlRootPass) data.mysql_root_password = mysqlRootPass
                        await api.settings.update(data as any)
                        setMysqlRootPass('')
                        showToast('MySQL credentials saved')
                      } catch (err: unknown) {
                        showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
                      } finally {
                        setSavingMysql(false)
                      }
                    }}
                  >
                    Save credentials
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* ── DigitalOcean API (admin only) ─────────────────────────────── */}
        {isAdmin && (
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="100">
                  <Text as="h2" variant="headingMd">DigitalOcean API</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Lets the Server page control this droplet directly — reboot, resize, snapshots, backups,
                    firewalls — without logging into the DigitalOcean dashboard. Generate a Personal Access
                    Token with Read and Write scope from your DigitalOcean account (API → Tokens).
                  </Text>
                </BlockStack>
                <TextField
                  label="API token"
                  type="password"
                  value={doToken}
                  onChange={setDoToken}
                  autoComplete="off"
                  placeholder="Leave blank to keep existing secret"
                />
                <InlineStack align="end">
                  <Button
                    loading={doLoadingList}
                    disabled={!doToken}
                    onClick={async () => {
                      setDoLoadingList(true)
                      try {
                        await api.settings.update({ do_api_token: doToken })
                        const droplets = await api.server.listDroplets()
                        setDoDroplets(droplets)
                        showToast('Token saved — pick your droplet below')
                      } catch (err: unknown) {
                        showToast(err instanceof Error ? err.message : 'Failed to verify token', { error: true })
                      } finally {
                        setDoLoadingList(false)
                      }
                    }}
                  >
                    Save &amp; load droplets
                  </Button>
                </InlineStack>
                <Divider />
                {doDroplets.length > 0 ? (
                  <Select
                    label="Droplet"
                    options={doDroplets.map((d) => ({
                      label: `${d.name} — ${d.region?.slug} · ${d.size_slug} · ${d.networks?.v4?.[0]?.ip_address ?? 'no IP'}`,
                      value: String(d.id)
                    }))}
                    value={doDropletId}
                    onChange={setDoDropletId}
                  />
                ) : (
                  <TextField
                    label="Droplet ID"
                    value={doDropletId}
                    onChange={setDoDropletId}
                    autoComplete="off"
                    helpText="Numeric droplet ID. Save the token above and click 'Save & load droplets' to pick from a list instead."
                  />
                )}
                <InlineStack align="end">
                  <Button
                    variant="primary"
                    loading={savingDo}
                    disabled={!doDropletId}
                    onClick={async () => {
                      setSavingDo(true)
                      try {
                        await api.settings.update({ do_droplet_id: doDropletId })
                        showToast('DigitalOcean settings saved')
                      } catch (err: unknown) {
                        showToast(err instanceof Error ? err.message : 'Save failed', { error: true })
                      } finally {
                        setSavingDo(false)
                      }
                    }}
                  >
                    Save droplet selection
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </Layout.Section>
        )}

        {/* ── About ─────────────────────────────────────────────────────── */}
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">About</Text>
              {[
                { label: 'Version',  value: 'v2.0.0' },
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
