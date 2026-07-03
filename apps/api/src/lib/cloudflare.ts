import type { PrismaClient } from '@prisma/client'
import { readSecret } from './crypto'

const CF_API = 'https://api.cloudflare.com/client/v4'

export interface CloudflareCreds {
  token: string | null
  zoneId: string | null
  publicIp: string | null
}

async function getSetting(prisma: PrismaClient, key: string): Promise<string> {
  const row = await prisma.setting.findUnique({ where: { key } }).catch(() => null)
  return row?.value?.trim() ?? ''
}

export async function getCloudflareCreds(prisma: PrismaClient): Promise<CloudflareCreds> {
  const [tokenRaw, zoneId, publicIp] = await Promise.all([
    getSetting(prisma, 'cloudflare_api_token'),
    getSetting(prisma, 'cloudflare_zone_id'),
    getSetting(prisma, 'server_public_ip')
  ])
  return {
    token: tokenRaw ? readSecret(tokenRaw) : null, // stored encrypted at rest
    zoneId: zoneId || null,
    publicIp: publicIp || null
  }
}

export function isCloudflareConfigured(creds: CloudflareCreds): boolean {
  return Boolean(creds.token && creds.zoneId)
}

/** Best-effort public IP detection, used when server_public_ip isn't set. */
export async function detectPublicIp(): Promise<string | null> {
  try {
    const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    const data = (await res.json()) as { ip?: string }
    return data.ip ?? null
  } catch {
    return null
  }
}

interface CfResult { ok: boolean; message: string }

async function cf(token: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {})
    }
  })
  return res.json()
}

/**
 * Create (or update, if one already exists) an A record pointing `name` at the
 * server's public IP. Idempotent and best-effort — returns a result rather than
 * throwing so provisioning is never blocked by DNS.
 */
export async function upsertARecord(
  creds: CloudflareCreds,
  name: string,
  ipOverride?: string | null
): Promise<CfResult> {
  if (!creds.token || !creds.zoneId) {
    return { ok: false, message: 'Cloudflare not configured' }
  }
  const ip = ipOverride || creds.publicIp || (await detectPublicIp())
  if (!ip) return { ok: false, message: 'Could not determine server public IP' }

  try {
    // Look for an existing A record with this exact name.
    const list = await cf(creds.token, `/zones/${creds.zoneId}/dns_records?type=A&name=${encodeURIComponent(name)}`)
    if (!list?.success) {
      return { ok: false, message: list?.errors?.[0]?.message ?? 'Cloudflare API error' }
    }

    const body = JSON.stringify({ type: 'A', name, content: ip, ttl: 1, proxied: false })
    const existing = list.result?.[0]

    const resp = existing
      ? await cf(creds.token, `/zones/${creds.zoneId}/dns_records/${existing.id}`, { method: 'PUT', body })
      : await cf(creds.token, `/zones/${creds.zoneId}/dns_records`, { method: 'POST', body })

    if (resp?.success) {
      return { ok: true, message: `${existing ? 'Updated' : 'Created'} A record ${name} → ${ip}` }
    }
    return { ok: false, message: resp?.errors?.[0]?.message ?? 'Cloudflare API error' }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}
