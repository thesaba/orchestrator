import { BlockStack, InlineStack, Text, Badge, Button, Banner, Spinner } from '@shopify/polaris'
import { useEffect, useState } from 'react'
import { phpFpmApi } from '../api/client'
import { useToast } from '../context/toast'
import { ConfigEditor } from './ConfigEditor'

export function PhpFpmTab({ siteId }: { siteId: number }) {
  const [content,  setContent]  = useState('')
  const [path,     setPath]     = useState('')
  const [exists,   setExists]   = useState(false)
  const [loading,  setLoading]  = useState(true)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState('')
  const [reloaded, setReloaded] = useState(false)
  const showToast = useToast()

  useEffect(() => {
    phpFpmApi.get(siteId)
      .then((r) => { setContent(r.content); setPath(r.path); setExists(r.exists) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [siteId])

  const save = async () => {
    setSaving(true); setError(''); setReloaded(false)
    try {
      const r = await phpFpmApi.save(siteId, content)
      setReloaded(r.reloaded)
      showToast(r.reloaded ? 'Pool config saved & php-fpm reloaded' : 'Pool config saved (reload skipped)')
    } catch (e: unknown) { setError((e as Error).message) }
    finally { setSaving(false) }
  }

  if (loading) return <InlineStack align="center"><Spinner size="small" /></InlineStack>

  return (
    <BlockStack gap="500">
      <InlineStack align="space-between" blockAlign="center">
        <BlockStack gap="100">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h2" variant="headingMd">PHP-FPM Pool Config</Text>
            <Badge tone={exists ? 'success' : 'warning'}>{exists ? 'Custom' : 'Default template'}</Badge>
          </InlineStack>
          {path && <Text as="p" variant="bodySm" tone="subdued">{path}</Text>}
        </BlockStack>
      </InlineStack>

      <Text as="p" variant="bodySm" tone="subdued">
        Edit the PHP-FPM pool configuration for this site. Changes are written to the pool conf and php-fpm is reloaded automatically.
        Syntax errors are rejected before writing.
      </Text>

      {error && <Banner tone="critical" onDismiss={() => setError('')}><pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{error}</pre></Banner>}
      {reloaded && <Banner tone="success" onDismiss={() => setReloaded(false)}>php-fpm reloaded successfully.</Banner>}

      <ConfigEditor
        value={content}
        onChange={setContent}
        onSave={save}
        saveLabel="Save & Reload PHP-FPM"
        minHeight="500px"
      />
    </BlockStack>
  )
}
