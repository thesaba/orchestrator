import { BlockStack, InlineStack, Text, Button, Banner } from '@shopify/polaris'
import { useCallback, useRef, useState } from 'react'

interface Props {
  value: string
  onChange: (v: string) => void
  onSave: () => Promise<void>
  saveLabel?: string
  minHeight?: string
  disabled?: boolean
}

export function ConfigEditor({
  value,
  onChange,
  onSave,
  saveLabel = 'Save',
  minHeight = '360px',
  disabled = false
}: Props) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const handleSave = useCallback(async () => {
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await onSave()
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [onSave])

  // Keep a stable ref so the keyDown handler can call the latest handleSave
  const handleSaveRef = useRef(handleSave)
  handleSaveRef.current = handleSave

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const el = e.currentTarget
        const start = el.selectionStart
        const end = el.selectionEnd
        onChange(value.substring(0, start) + '    ' + value.substring(end))
        requestAnimationFrame(() => {
          el.selectionStart = el.selectionEnd = start + 4
        })
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        handleSaveRef.current()
      }
    },
    [value, onChange]
  )

  const lineCount = value.split('\n').length

  return (
    <BlockStack gap="300">
      {error && (
        <Banner tone="critical" onDismiss={() => setError('')}>
          <pre
            style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              fontSize: '12px'
            }}
          >
            {error}
          </pre>
        </Banner>
      )}

      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight,
          fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", ui-monospace, monospace',
          fontSize: '13px',
          lineHeight: '1.6',
          background: '#0d1117',
          color: '#e6edf3',
          border: '1px solid #30363d',
          borderRadius: '6px',
          padding: '14px 16px',
          resize: 'vertical',
          outline: 'none',
          boxSizing: 'border-box',
          opacity: disabled ? 0.5 : 1
        }}
      />

      <InlineStack align="space-between" blockAlign="center">
        <Text as="p" variant="bodySm" tone="subdued">
          {lineCount} line{lineCount !== 1 ? 's' : ''} · Tab inserts 4 spaces · {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+S to save
        </Text>
        <InlineStack gap="300" blockAlign="center">
          {saved && (
            <Text as="p" variant="bodySm" tone="success">
              Saved
            </Text>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={disabled}
          >
            {saveLabel}
          </Button>
        </InlineStack>
      </InlineStack>
    </BlockStack>
  )
}
