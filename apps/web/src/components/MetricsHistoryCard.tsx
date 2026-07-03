import { useCallback, useEffect, useState } from 'react'
import { Card, BlockStack, InlineStack, Text, ButtonGroup, Button } from '@shopify/polaris'
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid
} from 'recharts'
import { api, MetricSample } from '../api/client'

const RANGES: { label: string; hours: number }[] = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 168 }
]

const SERIES = [
  { key: 'cpuPercent',  name: 'CPU',  color: '#5c6ac4' },
  { key: 'ramPercent',  name: 'RAM',  color: '#47c1bf' },
  { key: 'diskPercent', name: 'Disk', color: '#f49342' }
]

function formatTick(iso: string, hours: number): string {
  const d = new Date(iso)
  return hours <= 24
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

/**
 * Historical CPU / RAM / disk usage chart, backed by the metrics monitor's
 * time-series samples (GET /monitor/history).
 */
export function MetricsHistoryCard() {
  const [hours, setHours] = useState(24)
  const [samples, setSamples] = useState<MetricSample[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback((h: number) => {
    setLoading(true)
    api.monitor.history(h)
      .then((r) => setSamples(r.samples))
      .catch(() => setSamples([]))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load(hours) }, [hours, load])

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h2" variant="headingMd">Resource history</Text>
          <ButtonGroup variant="segmented">
            {RANGES.map((r) => (
              <Button
                key={r.hours}
                pressed={hours === r.hours}
                onClick={() => setHours(r.hours)}
              >
                {r.label}
              </Button>
            ))}
          </ButtonGroup>
        </InlineStack>

        {samples.length < 2 ? (
          <Text as="p" tone="subdued">
            {loading ? 'Loading…' : 'Not enough data yet — samples are collected every minute.'}
          </Text>
        ) : (
          <div style={{ width: '100%', height: 260 }}>
            <ResponsiveContainer>
              <LineChart data={samples} margin={{ top: 8, right: 12, bottom: 4, left: -16 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e1e3e5" />
                <XAxis
                  dataKey="checkedAt"
                  tickFormatter={(v) => formatTick(v, hours)}
                  minTickGap={40}
                  fontSize={11}
                />
                <YAxis domain={[0, 100]} unit="%" fontSize={11} />
                <Tooltip
                  labelFormatter={(v) => new Date(v as string).toLocaleString()}
                  formatter={((value: any, name: any) => [`${value}%`, name]) as any}
                />
                <Legend />
                {SERIES.map((s) => (
                  <Line
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.name}
                    stroke={s.color}
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </BlockStack>
    </Card>
  )
}
