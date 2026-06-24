import { Modal, BlockStack, InlineStack, Text, Button, Badge } from '@shopify/polaris'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const STORAGE_KEY = 'onboarding_complete'

const STEPS = [
  {
    icon: '🚀',
    title: 'Welcome to Orchestrator',
    body: 'Orchestrator is a zero-downtime Laravel deployment panel. Provision servers, deploy with one click, monitor uptime, and manage your sites — all from here.'
  },
  {
    icon: '🌐',
    title: 'Add your first site',
    body: 'Go to Sites → Add site to provision a new Laravel app. You\'ll enter a domain, PHP version, and database credentials. The panel will configure Nginx, PHP-FPM, and MySQL automatically.'
  },
  {
    icon: '🔗',
    title: 'Connect your repository',
    body: 'In each site\'s Deploy Settings tab, add a Git repository URL. For private repos, add a Personal Access Token. Then hit Deploy — Capistrano-style zero-downtime releases!'
  },
  {
    icon: '🤖',
    title: 'Set up auto-deploy',
    body: 'Generate a webhook token in Deploy Settings and add it to GitHub. Every push to your branch triggers an automatic deploy — no manual steps needed.'
  },
  {
    icon: '📊',
    title: 'Monitor & explore',
    body: 'Use the Monitoring page for uptime status and SSL expiry alerts. The Dashboard shows deploy history charts. Use ⌘K (or /) to open the command palette anywhere.'
  }
]

export function OnboardingWizard() {
  const [open, setOpen]   = useState(false)
  const [step, setStep]   = useState(0)
  const navigate = useNavigate()

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setTimeout(() => setOpen(true), 800)
    }
  }, [])

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, '1')
    setOpen(false)
  }

  const finish = () => {
    dismiss()
    navigate('/sites/new')
  }

  const current = STEPS[step]
  const isLast  = step === STEPS.length - 1

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title=""
      noScroll
    >
      <Modal.Section>
        <BlockStack gap="500">
          {/* Progress dots */}
          <InlineStack align="center" gap="200">
            {STEPS.map((_, i) => (
              <div key={i} style={{
                width: 8, height: 8, borderRadius: '50%', cursor: 'pointer',
                background: i === step ? '#458fff' : '#c9cccf',
                transition: 'background 0.2s'
              }} onClick={() => setStep(i)} />
            ))}
          </InlineStack>

          {/* Step content */}
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>{current.icon}</div>
            <Text as="h2" variant="headingLg">{current.title}</Text>
            <div style={{ marginTop: 12 }}>
              <Text as="p" variant="bodyMd" tone="subdued">{current.body}</Text>
            </div>
          </div>

          {/* Navigation */}
          <InlineStack align="space-between" blockAlign="center">
            <Button variant="plain" onClick={dismiss}>Skip tour</Button>
            <InlineStack gap="200">
              {step > 0 && (
                <Button onClick={() => setStep((s) => s - 1)}>← Back</Button>
              )}
              {isLast ? (
                <Button variant="primary" onClick={finish}>Add first site →</Button>
              ) : (
                <Button variant="primary" onClick={() => setStep((s) => s + 1)}>
                  Next →
                </Button>
              )}
            </InlineStack>
          </InlineStack>

          {/* Step counter */}
          <InlineStack align="center">
            <Badge tone="info">{`${step + 1} / ${STEPS.length}`}</Badge>
          </InlineStack>
        </BlockStack>
      </Modal.Section>
    </Modal>
  )
}
