import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, Checkbox, TextField, Select, Button, Banner, Badge } from '@shopify/polaris'
import { api, SiteSecurity } from '../api/client'
import { useToast } from '../context/toast'

/**
 * Per-site nginx security: HTTP basic auth + IP allow/deny. Applied via a guarded
 * script (backup + nginx -t + rollback), so a bad config never breaks the site.
 * Admin-only.
 */
export function SiteSecurityCard({ siteId }: { siteId: number }) {
  const showToast = useToast()
  const [cfg, setCfg] = useState<SiteSecurity | null>(null)
  const [basicAuth, setBasicAuth] = useState(false)
  const [user, setUser] = useState('')
  const [password, setPassword] = useState('')
  const [ipMode, setIpMode] = useState<'off' | 'allow' | 'deny'>('off')
  const [ipList, setIpList] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.siteSecurity.get(siteId).then((c) => {
      setCfg(c); setBasicAuth(c.basicAuth); setUser(c.basicUser ?? '')
      setIpMode((c.ipMode ?? 'off') as 'off' | 'allow' | 'deny'); setIpList(c.ipList.join('\n'))
    }).catch(() => {})
  }, [siteId])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true); setError('')
    const ips = ipList.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
    try {
      const c = await api.siteSecurity.update(siteId, {
        basicAuth,
        ...(user ? { basicUser: user } : {}),
        ...(password ? { basicPassword: password } : {}),
        ipMode,
        ipList: ips
      })
      setCfg(c); setPassword('')
      showToast('Security applied')
    } catch (e: unknown) {
      const err = e as { message?: string; detail?: string }
      setError(err.detail ? `${err.message}\n${err.detail}` : (err.message ?? 'Failed'))
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">Security</Text>
            {cfg?.basicAuth && <Badge tone="success">basic auth</Badge>}
            {cfg?.ipMode && <Badge tone="attention">{`IP ${cfg.ipMode}list`}</Badge>}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Protect this site with HTTP basic auth and/or IP rules. Applied to nginx with a backup + validate + auto-rollback, so a bad config can't take the site down.
          </Text>
        </BlockStack>

        {error && <Banner tone="critical" onDismiss={() => setError('')}><pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 12 }}>{error}</pre></Banner>}

        <BlockStack gap="300">
          <Checkbox label="Require HTTP basic auth" checked={basicAuth} onChange={setBasicAuth} />
          {basicAuth && (
            <InlineStack gap="300" wrap>
              <div style={{ width: 200 }}>
                <TextField label="Username" value={user} onChange={setUser} autoComplete="off" />
              </div>
              <div style={{ width: 220 }}>
                <TextField
                  label="Password" type="password" value={password} onChange={setPassword}
                  autoComplete="new-password"
                  placeholder={cfg?.hasPassword ? 'Leave blank to keep current' : 'Set a password'}
                />
              </div>
            </InlineStack>
          )}
        </BlockStack>

        <BlockStack gap="300">
          <div style={{ width: 220 }}>
            <Select
              label="IP access"
              options={[
                { label: 'No IP restriction', value: 'off' },
                { label: 'Allowlist (only these IPs)', value: 'allow' },
                { label: 'Denylist (block these IPs)', value: 'deny' }
              ]}
              value={ipMode}
              onChange={(v) => setIpMode(v as 'off' | 'allow' | 'deny')}
            />
          </div>
          {ipMode !== 'off' && (
            <TextField
              label={ipMode === 'allow' ? 'Allowed IPs / CIDRs' : 'Blocked IPs / CIDRs'}
              value={ipList}
              onChange={setIpList}
              multiline={3}
              autoComplete="off"
              placeholder={'203.0.113.10\n198.51.100.0/24'}
              helpText="One per line. IPv4 or CIDR."
            />
          )}
        </BlockStack>

        <InlineStack align="end">
          <Button variant="primary" onClick={save} loading={busy}>Apply security</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  )
}
