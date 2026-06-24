import { Card, BlockStack, InlineStack, Text, Badge, SkeletonBodyText, Button } from '@shopify/polaris'
import { RefreshIcon } from '@shopify/polaris-icons'
import { api, ServiceStatus } from '../api/client'
import { usePolling } from '../hooks/usePolling'

export function ServicesCard() {
  const { data: services, refresh } = usePolling<ServiceStatus[]>(api.monitor.services, 15_000)

  return (
    <Card>
      <BlockStack gap="400">
        <InlineStack align="space-between">
          <Text as="h2" variant="headingMd">
            Services
          </Text>
          <Button
            icon={RefreshIcon}
            variant="plain"
            accessibilityLabel="Refresh services"
            onClick={refresh}
          />
        </InlineStack>

        {!services ? (
          <SkeletonBodyText lines={4} />
        ) : (
          <BlockStack gap="300">
            {services.map((svc) => (
              <InlineStack key={svc.name} align="space-between">
                <Text as="p" variant="bodyMd">
                  {svc.name}
                </Text>
                <Badge tone={svc.status === 'active' ? 'success' : 'critical'}>
                  {svc.status}
                </Badge>
              </InlineStack>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  )
}
