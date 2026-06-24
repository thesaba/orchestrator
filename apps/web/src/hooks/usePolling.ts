import { useCallback, useEffect, useRef, useState } from 'react'

export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number
): { data: T | null; error: string; refresh: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refresh = useCallback(async () => {
    try {
      const result = await fetcherRef.current()
      setData(result)
      setError('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to fetch')
    }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs, refresh])

  return { data, error, refresh }
}
