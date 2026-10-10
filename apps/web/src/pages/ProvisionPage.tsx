import {
  Page,
  Card,
  FormLayout,
  TextField,
  Select,
  Button,
  Banner,
  BlockStack,
  Text,
  Divider,
  InlineStack,
  Badge,
  Checkbox
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, SiteTemplate, ServerInfo } from '../api/client'
import { ProvisionLog } from '../components/ProvisionLog'
import { domainToSlug, generatePassword } from '../utils/helpers'
import { phpVersionOptions, DEFAULT_PHP_VERSION } from '../utils/php'

type Step = 'form' | 'provisioning' | 'done'

// One-line explanation of what "1-click install" does per stack.
const INSTALL_HELP: Record<SiteTemplate, string> = {
  laravel:   'Installs a fresh Laravel app (composer create-project), writes .env, generates APP_KEY and runs migrations.',
  wordpress: 'Downloads WordPress, writes wp-config, and installs it with the admin account below.',
  static:    'Creates a placeholder index.html you can replace or deploy over later.',
  node:      'Scaffolds a minimal Express app and runs it under supervisor, behind the Nginx proxy.'
}

export function ProvisionPage() {
  const navigate = useNavigate()

  // Form fields
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [template, setTemplate] = useState<SiteTemplate>('laravel')
  const [phpVersion, setPhpVersion] = useState(DEFAULT_PHP_VERSION)
  const [dbName, setDbName] = useState('')
  const [dbUser, setDbUser] = useState('')
  const [dbPassword, setDbPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [servers, setServers] = useState<ServerInfo[]>([])
  const [serverId, setServerId] = useState('') // '' = local (default)

  // 1-click install (scaffold a fresh app right after provisioning)
  const [installApp, setInstallApp] = useState(true)
  const [siteTitle, setSiteTitle] = useState('')
  const [wpAdminUser, setWpAdminUser] = useState('admin')
  const [wpAdminEmail, setWpAdminEmail] = useState('')
  const [wpAdminPass, setWpAdminPass] = useState(generatePassword())
  const [showWpPass, setShowWpPass] = useState(false)

  // Load servers so a target can be chosen when remotes exist. If only the
  // local server is present, the picker is hidden and behaviour is unchanged.
  useEffect(() => {
    api.servers.list().then((r) => setServers(r.servers)).catch(() => {})
  }, [])

  // Process state
  const [step, setStep] = useState<Step>('form')
  const [siteId, setSiteId] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Auto-fill derived fields when domain changes
  useEffect(() => {
    if (!domain) return
    const slug = domainToSlug(domain)
    if (!name) setName(domain)
    setDbName(`${slug}_db`)
    setDbUser(`${slug}_usr`)
    if (!dbPassword) setDbPassword(generatePassword())
  }, [domain])

  const handleSubmit = async () => {
    if (!domain || !dbName || !dbUser || !dbPassword) {
      setError('All fields are required.')
      return
    }
    if (installApp && template === 'wordpress' && !wpAdminEmail) {
      setError('WordPress 1-click install needs an admin email.')
      return
    }
    setError('')
    setSubmitting(true)

    try {
      // 1. Create site record
      const site = await api.sites.create({ name: name || domain, domain, phpVersion, ...(serverId ? { serverId: Number(serverId) } : {}) })

      // 2. Start provisioning (+ optional 1-click install)
      await api.provision.start(site.id, {
        dbName, dbUser, dbPassword, template, installApp,
        ...(installApp && template === 'wordpress'
          ? { siteTitle: siteTitle || name || domain, wpAdminUser, wpAdminEmail, wpAdminPass }
          : {})
      })

      setSiteId(site.id)
      setStep('provisioning')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  const handleDone = useCallback(
    (status: string) => {
      setStep('done')
      if (status === 'active' && siteId) {
        setTimeout(() => navigate(`/sites/${siteId}`), 1500)
      }
    },
    [siteId, navigate]
  )

  return (
    <Page
      title="Add New Site"
      backAction={{ content: 'Sites', onAction: () => navigate('/sites') }}
    >
      <BlockStack gap="500">
        {step === 'form' && (
          <Card>
            <BlockStack gap="500">
              {error && <Banner tone="critical">{error}</Banner>}

              <FormLayout>
                <FormLayout.Group>
                  <TextField
                    label="Domain"
                    value={domain}
                    onChange={setDomain}
                    placeholder="example.com"
                    autoComplete="off"
                  />
                  <TextField
                    label="Display name"
                    value={name}
                    onChange={setName}
                    placeholder="My Laravel App"
                    autoComplete="off"
                  />
                </FormLayout.Group>

                <FormLayout.Group>
                  <Select
                    label="Stack template"
                    options={[
                      { label: 'Laravel', value: 'laravel' },
                      { label: 'WordPress', value: 'wordpress' },
                      { label: 'Static site (no PHP)', value: 'static' },
                      { label: 'Node / Express', value: 'node' }
                    ]}
                    value={template}
                    onChange={(v) => setTemplate(v as SiteTemplate)}
                    helpText="Shapes the Nginx vhost. With 1-click install on, a fresh app of this type is installed too."
                  />
                  <Select
                    label="PHP Version"
                    disabled={template === 'static' || template === 'node'}
                    options={phpVersionOptions()}
                    value={phpVersion}
                    onChange={setPhpVersion}
                  />
                </FormLayout.Group>

                {servers.length > 1 && (
                  <Select
                    label="Target server"
                    options={servers.map((s) => ({
                      label: s.kind === 'local' ? `${s.name} (local)` : `${s.name} — ${s.host}${s.status !== 'online' ? ` · ${s.status}` : ''}`,
                      value: s.kind === 'local' ? '' : String(s.id)
                    }))}
                    value={serverId}
                    onChange={setServerId}
                    helpText="Where this site will be provisioned. Defaults to the local server."
                  />
                )}

                <Divider />

                {/* ── 1-click install ─────────────────────────────────────── */}
                <BlockStack gap="300">
                  <Checkbox
                    label="1-click install — set up a fresh app automatically"
                    checked={installApp}
                    onChange={setInstallApp}
                    helpText={`${INSTALL_HELP[template]} Turn off for an empty site you'll deploy from Git.`}
                  />
                  {installApp && template === 'wordpress' && (
                    <BlockStack gap="300">
                      <FormLayout.Group>
                        <TextField
                          label="Site title"
                          value={siteTitle}
                          onChange={setSiteTitle}
                          placeholder={name || domain}
                          autoComplete="off"
                        />
                        <TextField
                          label="Admin username"
                          value={wpAdminUser}
                          onChange={setWpAdminUser}
                          autoComplete="off"
                        />
                      </FormLayout.Group>
                      <FormLayout.Group>
                        <TextField
                          label="Admin email"
                          type="email"
                          value={wpAdminEmail}
                          onChange={setWpAdminEmail}
                          placeholder="you@example.com"
                          autoComplete="off"
                        />
                        <TextField
                          label="Admin password"
                          value={wpAdminPass}
                          onChange={setWpAdminPass}
                          type={showWpPass ? 'text' : 'password'}
                          autoComplete="off"
                          connectedRight={
                            <Button onClick={() => setShowWpPass((p) => !p)}>
                              {showWpPass ? 'Hide' : 'Show'}
                            </Button>
                          }
                          helpText="Save this — you'll sign in to /wp-admin with it."
                        />
                      </FormLayout.Group>
                      <Banner tone="info">
                        After install, enable SSL for this site so https://{domain} works (the admin URL uses https).
                      </Banner>
                    </BlockStack>
                  )}
                </BlockStack>

                <Divider />

                <Text as="h3" variant="headingSm">
                  Database Credentials
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Auto-generated. With 1-click install these are wired into the app automatically; save them anyway for later.
                </Text>

                <FormLayout.Group>
                  <TextField
                    label="Database name"
                    value={dbName}
                    onChange={setDbName}
                    autoComplete="off"
                  />
                  <TextField
                    label="Database user"
                    value={dbUser}
                    onChange={setDbUser}
                    autoComplete="off"
                  />
                </FormLayout.Group>

                <TextField
                  label="Database password"
                  value={dbPassword}
                  onChange={setDbPassword}
                  type={showPass ? 'text' : 'password'}
                  autoComplete="off"
                  connectedRight={
                    <Button onClick={() => setShowPass((p) => !p)}>
                      {showPass ? 'Hide' : 'Show'}
                    </Button>
                  }
                />
              </FormLayout>

              <InlineStack align="end">
                <Button
                  variant="primary"
                  size="large"
                  onClick={handleSubmit}
                  loading={submitting}
                >
                  {installApp ? 'Provision & install' : 'Provision Site'}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        {(step === 'provisioning' || step === 'done') && siteId && (
          <Card>
            <BlockStack gap="400">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Provisioning {domain}
                </Text>
                {step === 'done' && (
                  <Badge tone="success">Complete — redirecting...</Badge>
                )}
              </InlineStack>

              <ProvisionLog
                endpoint={`/api/sites/${siteId}/provision/stream`}
                onComplete={handleDone}
              />

              {step === 'done' && (
                <InlineStack align="end">
                  <Button onClick={() => navigate(`/sites/${siteId}`)}>
                    Go to site →
                  </Button>
                </InlineStack>
              )}
            </BlockStack>
          </Card>
        )}
      </BlockStack>
    </Page>
  )
}
