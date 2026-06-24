const TOKEN_KEY = 'orchestrator_token'

export interface SSEMessage {
  line?: string
  done?: boolean
  status?: string
  error?: string
  [key: string]: unknown
}

export async function consumeSSE(
  url: string,
  onMessage: (msg: SSEMessage) => void,
  signal?: AbortSignal
): Promise<void> {
  const token = localStorage.getItem(TOKEN_KEY) ?? ''

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal
  })

  if (!res.ok || !res.body) {
    throw new Error(`SSE connection failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })

    // SSE messages are separated by double newlines
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''

    for (const block of blocks) {
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      try {
        const parsed = JSON.parse(dataLine.slice(6)) as SSEMessage
        onMessage(parsed)
      } catch {
        // skip malformed
      }
    }
  }
}
