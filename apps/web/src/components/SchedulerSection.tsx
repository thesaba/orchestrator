import { useEffect, useState } from 'react'
import { BlockStack, Button, Text, Banner, InlineStack, Badge, Box } from '@shopify/polaris'
import { schedulerApi } from '../api/client'
import { useToast } from '../context/toast'

interface Props {
  siteId: number
}

export function SchedulerSection({ siteId }: Props) {
  const showToast = useToast()
  const [active, setActive]   = useState<boolean | null>(null)
  const [loading, setLoading] = useState(false)
  const [cronPath, setCronPath] = useState('')

  useEffect(() => {
    schedulerApi.get(siteId).then((r) => { setActive(r.active); setCronPath(r.cronPath) }).catch(() => {})
  }, [siteId])

  async function toggle() {
    setLoading(true)
    try {
      if (active) {
        await schedulerApi.disable(siteId)
        setActive(false)
        showToast('Laravel Scheduler disabled')
      } else {
        const r = await schedulerApi.enable(siteId)
        setActive(true)
        setCronPath(r.cronPath)
        showToast('Laravel Scheduler enabled')
      }
    } catch (err: unknown) {
      showToast((err as Error).message, { error: true })
    } finally {
      setLoading(false)
    }
  }

  return (
    <BlockStack gap="300">
      <InlineStack gap="300" blockAlign="center">
        <Text as="h3" variant="headingSm">Laravel Scheduler</Text>
        {active !== null && (
          <Badge tone={active ? 'success' : 'enabled'}>
            {active ? 'Active' : 'Inactive'}
          </Badge>
        )}
      </InlineStack>

      <Text as="p" tone="subdued" variant="bodySm">
        Enables <code>php artisan schedule:run</code> every minute via a system cron job
        (writes to <code>/etc/cron.d/</code>).
      </Text>

      {active && cronPath && (
        <Banner tone="info">
          Cron file: <code>{cronPath}</code>
        </Banner>
      )}

      <Box>
        <Button
          onClick={toggle}
          loading={loading}
          tone={active ? 'critical' : undefined}
          variant={active ? undefined : 'primary'}
        >
          {active ? 'Disable Scheduler' : 'Enable Scheduler'}
        </Button>
      </Box>
    </BlockStack>
  )
}
