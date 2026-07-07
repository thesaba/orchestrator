import { execOn, ServerCtx } from './server-exec'

export interface CertInfo {
  active: boolean
  expiresAt: string | null
  issuer: string | null
  daysLeft: number | null
}

/**
 * Read a domain's certificate status from Certbot on the site's server (local →
 * in-process, remote → over SSH). Never throws — returns an inactive result on
 * any error. The domain is validated on site creation, keeping it inert.
 */
export async function getCertInfo(domain: string, ctx: ServerCtx = null): Promise<CertInfo> {
  try {
    const { stdout } = await execOn(ctx, 'certbot', ['certificates', '--cert-name', domain])
      .catch((e: any) => ({ stdout: e.stdout ?? '' }))

    const expiryMatch = stdout.match(/Expiry Date:\s+(.+?)\s+\(/)
    const issuerMatch = stdout.match(/Issuer:\s+(.+)/)
    const validMatch  = stdout.match(/Certificate Name:\s+\S/)

    if (!validMatch || !stdout.includes(domain)) {
      return { active: false, expiresAt: null, issuer: null, daysLeft: null }
    }

    const expiresAt = expiryMatch ? expiryMatch[1].trim() : null
    const issuer    = issuerMatch ? issuerMatch[1].trim() : null
    let daysLeft: number | null = null

    if (expiresAt) {
      const ms = new Date(expiresAt).getTime() - Date.now()
      daysLeft = Math.max(0, Math.floor(ms / 86_400_000))
    }

    return { active: true, expiresAt, issuer, daysLeft }
  } catch {
    return { active: false, expiresAt: null, issuer: null, daysLeft: null }
  }
}
