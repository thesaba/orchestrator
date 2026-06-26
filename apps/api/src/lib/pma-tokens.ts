import { randomBytes } from 'crypto'

// In-memory, single-use, short-lived tokens used to hand a one-time MySQL
// credential off to the phpMyAdmin signon bridge (a separate PHP process)
// without ever putting the password in a URL. The bridge fetches the real
// credentials server-side, over loopback, using this token as an opaque
// lookup key — see routes/pma.ts and routes/pma-internal.ts.
//
// In-memory is fine: tokens live at most TOKEN_TTL_MS and are consumed
// within a couple of seconds of being issued (the user's browser tab
// opening triggers the bridge's loopback callback almost immediately).
// A restart simply invalidates any in-flight tokens, which is harmless.

export interface PmaCreds {
  host: string
  user: string
  pass: string
  db: string
}

interface PmaTokenEntry extends PmaCreds {
  expiresAt: number
}

const TOKEN_TTL_MS = 60_000

const tokens = new Map<string, PmaTokenEntry>()

function sweep() {
  const now = Date.now()
  for (const [key, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(key)
  }
}

export function createPmaToken(creds: PmaCreds): string {
  sweep()
  const token = randomBytes(32).toString('hex')
  tokens.set(token, { ...creds, expiresAt: Date.now() + TOKEN_TTL_MS })
  return token
}

/** Single-use: returns the creds and immediately deletes the token, or null if invalid/expired. */
export function consumePmaToken(token: string): PmaCreds | null {
  const entry = tokens.get(token)
  tokens.delete(token)
  if (!entry) return null
  if (entry.expiresAt < Date.now()) return null
  const { expiresAt, ...creds } = entry
  return creds
}
