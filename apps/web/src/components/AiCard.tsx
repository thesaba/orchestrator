import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, Checkbox, Select, TextField, Button, Banner, Badge } from '@shopify/polaris'
import { api, AiConfig } from '../api/client'
import { useToast } from '../context/toast'

/**
 * AI assistant configuration (bring-your-own-key, opt-in). The assistant is
 * read-only/advisory — it explains errors & deploys and never changes a site.
 */
export function AiCard() {
  const showToast = useToast()
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [provider, setProvider] = useState('openai')
  const [model, setModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.ai.config().then((c) => {
      setCfg(c); setProvider(c.provider); setModel(c.model); setBaseUrl(c.baseUrl); setEnabled(c.enabled)
    }).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true)
    try {
      await api.ai.saveConfig({ enabled, provider, model: model || undefined, baseUrl: baseUrl || undefined, ...(apiKey ? { apiKey } : {}) })
      setApiKey('')
      showToast('AI settings saved')
      load()
    } catch (e: unknown) {
      showToast(e instanceof Error ? e.message : 'Failed', { error: true })
    } finally { setBusy(false) }
  }

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">AI assistant</Text>
            {cfg?.enabled && cfg.configured && <Badge tone="success">on</Badge>}
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            Explains errors & failed deploys. Bring your own key; the assistant is read-only and never changes a site.
          </Text>
        </BlockStack>

        <Banner tone="warning">
          Error/deploy text is sent to your chosen provider to generate explanations. Secrets are best-effort redacted first, but review the privacy trade-off. For full privacy, point the base URL at a local model (e.g. Ollama).
        </Banner>

        <Checkbox label="Enable AI assistant" checked={enabled} onChange={setEnabled} />

        <InlineStack gap="300" wrap>
          <div style={{ width: 180 }}>
            <Select
              label="Provider"
              options={[{ label: 'OpenAI-compatible', value: 'openai' }, { label: 'Anthropic', value: 'anthropic' }]}
              value={provider}
              onChange={setProvider}
            />
          </div>
          <div style={{ width: 220 }}>
            <TextField label="Model" value={model} onChange={setModel} autoComplete="off" placeholder={provider === 'anthropic' ? 'claude-3-5-sonnet-latest' : 'gpt-4o-mini'} />
          </div>
        </InlineStack>

        <TextField
          label="Base URL (optional)"
          value={baseUrl}
          onChange={setBaseUrl}
          autoComplete="off"
          placeholder={provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
          helpText="For OpenAI-compatible or self-hosted models (e.g. http://127.0.0.1:11434/v1 for Ollama)."
        />

        <TextField
          label="API key"
          type="password"
          value={apiKey}
          onChange={setApiKey}
          autoComplete="off"
          placeholder={cfg?.configured ? 'Leave blank to keep existing' : 'Paste your API key'}
          helpText="Stored encrypted, never returned to the browser."
        />

        <InlineStack align="end">
          <Button variant="primary" onClick={save} loading={busy}>Save AI settings</Button>
        </InlineStack>
      </BlockStack>
    </Card>
  )
}
