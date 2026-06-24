import { Text, InlineStack } from '@shopify/polaris'
import { useNavigate } from 'react-router-dom'

export interface BreadcrumbItem {
  label: string
  url?: string
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  const navigate = useNavigate()
  return (
    <InlineStack gap="200" blockAlign="center">
      {items.map((item, i) => (
        <InlineStack key={i} gap="200" blockAlign="center">
          {i > 0 && <Text as="span" variant="bodySm" tone="subdued">/</Text>}
          {item.url ? (
            <button
              onClick={() => navigate(item.url!)}
              style={{
                background: 'none', border: 'none', padding: 0,
                cursor: 'pointer', color: 'var(--oc-accent)',
                fontSize: 13, fontFamily: 'inherit'
              }}
            >
              {item.label}
            </button>
          ) : (
            <Text as="span" variant="bodySm">{item.label}</Text>
          )}
        </InlineStack>
      ))}
    </InlineStack>
  )
}
