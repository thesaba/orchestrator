import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, Button, Badge, Banner, Link, Divider } from '@shopify/polaris'
import { api, TelegramStatus } from '../api/client'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/toast'

/**
 * Connect a personal Telegram account to the bot. Each user links their own
 * account; the bot then acts with that user's exact role/site permissions.
 * Admins additionally wire up the webhook that powers interactivity.
 */
export function TelegramCard() {
  const { isAdmin } = useAuth()
  const showToast = useToast()
  const [st, setSt] = useState<TelegramStatus | null>(null)
  const [code, setCode] = useState<{ code: string; deepLink: string | null; botUsername: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => { api.telegram.me().then(setSt).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])

  const genCode = async () => {
    setBusy(true)
    try { setCode(await api.telegram.linkCode()) }
    catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Failed', { error: true }) }
    finally { setBusy(false) }
  }
  const unlink = async () => { await api.telegram.unlink().catch(() => {}); setCode(null); load(); showToast('Unlinked') }
  const setup = async () => {
    setBusy(true)
    try { await api.telegram.setup(); showToast('Webhook connected'); load() }
    catch (e: unknown) { showToast(e instanceof Error ? e.message : 'Failed', { error: true }) }
    finally { setBusy(false) }
  }
  const removeWebhook = async () => { await api.telegram.removeWebhook().catch(() => {}); showToast('Webhook removed'); load() }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Telegram bot</Text>
            {st?.linked ? <Badge tone="success">linked</Badge> : <Badge>not linked</Badge>}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Manage your sites, deploys and tasks from Telegram — the bot acts with your own permissions.
          </Text>
        </BlockStack>

        {st && !st.botConfigured && (
          <Banner tone="warning">Add the Telegram bot token in the <b>Notifications</b> tab first.</Banner>
        )}

        {isAdmin && st?.botConfigured && (
          <>
            <InlineStack gap="200" blockAlign="center" wrap>
              <Badge tone={st.webhookConfigured ? 'success' : undefined}>{st.webhookConfigured ? 'webhook on' : 'webhook off'}</Badge>
              <Button onClick={setup} loading={busy}>Connect / refresh webhook</Button>
              {st.webhookConfigured && <Button variant="tertiary" tone="critical" onClick={removeWebhook}>Disconnect</Button>}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              The webhook lets Telegram deliver button taps to the panel. Requires the Panel URL (General tab) to be a public HTTPS address.
            </Text>
            <Divider />
          </>
        )}

        {st?.linked ? (
          <InlineStack align="space-between" blockAlign="center" wrap>
            <Text as="span">Linked{st.username ? ` as @${st.username}` : ''}. Send <code>/help</code> to the bot.</Text>
            <Button tone="critical" variant="tertiary" onClick={unlink}>Unlink</Button>
          </InlineStack>
        ) : (
          <BlockStack gap="300">
            <Button variant="primary" onClick={genCode} loading={busy} disabled={!st?.botConfigured}>Link my account</Button>
            {code && (
              <Banner tone="info">
                <BlockStack gap="150">
                  {code.deepLink
                    ? <Text as="p">Open the bot and press <b>Start</b>: <Link url={code.deepLink} external>{`@${code.botUsername}`}</Link></Text>
                    : <Text as="p">Send this message to your bot: <code>/start {code.code}</code></Text>}
                  <Text as="p" variant="bodySm" tone="subdued">Code expires in 10 minutes. After linking, press refresh.</Text>
                  <Button onClick={load}>I've linked — refresh</Button>
                </BlockStack>
              </Banner>
            )}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  )
}
