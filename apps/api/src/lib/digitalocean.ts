// Thin wrapper around the DigitalOcean REST API (v2). Credentials (a
// Personal Access Token + the droplet's numeric ID) are stored in the
// generic Setting key/value table — same pattern as mysql_root_user/password
// and the S3 backup credentials. See routes/settings.ts for the
// allow-list/redaction rules and routes/server.ts for how this is used.
import type { PrismaClient } from '@prisma/client'

const DO_API = 'https://api.digitalocean.com/v2'

export class DOError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function getSetting(prisma: PrismaClient, key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } })
  return row?.value || null
}

export interface DOCreds {
  token: string | null
  dropletId: string | null
}

export async function getDoCreds(prisma: PrismaClient): Promise<DOCreds> {
  const [token, dropletId] = await Promise.all([
    getSetting(prisma, 'do_api_token'),
    getSetting(prisma, 'do_droplet_id')
  ])
  return { token, dropletId }
}

// Generic authenticated request against the DO API. Throws DOError (with the
// real HTTP status) on any non-2xx response so routes can surface DO's own
// error message ("droplet is not powered off", "size is not valid", etc.)
// straight to the panel instead of a generic 500.
export async function doRequest<T = unknown>(
  token: string,
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetch(`${DO_API}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })

  const text = await res.text()
  let json: unknown = {}
  try { json = text ? JSON.parse(text) : {} } catch { /* some 204s have no body */ }

  if (!res.ok) {
    const message = (json as { message?: string })?.message || `DigitalOcean API error (HTTP ${res.status})`
    throw new DOError(message, res.status)
  }
  return json as T
}
