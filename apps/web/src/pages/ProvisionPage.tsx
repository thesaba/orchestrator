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
  Badge
} from '@shopify/polaris'
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { ProvisionLog } from '../components/ProvisionLog'
import { domainToSlug, generatePassword } from '../utils/helpers'

type Step = 'form' | 'provisioning' | 'done'

export function ProvisionPage() {
  const navigate = useNavigate()

  // Form fields
  const [domain, setDomain] = useState('')
  const [name, setName] = useState('')
  const [phpVersion, setPhpVersion] = useState('8.2')
  const [dbName, setDbName] = useState('')
  const [dbUser, setDbUser] = useState('')
  const [dbPassword, setDbPassword] = useState('')
  const [showPass, setShowPass] = useState(false)

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
    setError('')
    setSubmitting(true)

    try {
      // 1. Create site record
      const site = await api.sites.create({ name: name || domain, domain, phpVersion })

      // 2. Start provisioning
      await api.provision.start(site.id, { dbName, dbUser, dbPassword })

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

                <Select
                  label="PHP Version"
                  options={[
                    { label: 'PHP 8.1', value: '8.1' },
                    { label: 'PHP 8.2', value: '8.2' },
                    { label: 'PHP 8.3', value: '8.3' }
                  ]}
                  value={phpVersion}
                  onChange={setPhpVersion}
                />

                <Divider />

                <Text as="h3" variant="headingSm">
                  Database Credentials
                </Text>
                <Text as="p" variant="bodySm" tone="subdued">
                  Save these — you'll need them for your Laravel .env
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
                  Provision Site
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
