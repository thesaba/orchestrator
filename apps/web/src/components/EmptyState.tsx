import { BlockStack, Text, Button } from '@shopify/polaris'

interface Props {
  icon: string
  title: string
  body: string
  action?: { label: string; onAction: () => void }
}

export function EmptyState({ icon, title, body, action }: Props) {
  return (
    <div style={{ textAlign: 'center', padding: '64px 24px' }}>
      <BlockStack gap="300">
        <div style={{ fontSize: 52 }}>{icon}</div>
        <Text as="h2" variant="headingMd">{title}</Text>
        <Text as="p" variant="bodyMd" tone="subdued">{body}</Text>
        {action && (
          <div style={{ marginTop: 8 }}>
            <Button variant="primary" onClick={action.onAction}>{action.label}</Button>
          </div>
        )}
      </BlockStack>
    </div>
  )
}
