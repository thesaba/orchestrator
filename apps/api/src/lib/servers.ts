import os from 'os'
import type { PrismaClient } from '@prisma/client'
import type { ServerCtx } from './server-exec'

/**
 * Server registry helpers.
 *
 * A single kind="local" row represents the panel host. Every pre-existing site
 * has serverId=null and therefore resolves to `null` here, which server-exec
 * treats as "run locally" — the original behaviour. Only sites explicitly
 * placed on a remote server take the SSH path.
 */

// Create the local-server row once, if it doesn't exist. Idempotent; safe to
// call on every boot. Never touches remote rows or existing sites.
export async function seedLocalServer(prisma: PrismaClient): Promise<void> {
  const existing = await (prisma as any).server.findFirst({ where: { kind: 'local' } }).catch(() => null)
  if (existing) return
  await (prisma as any).server.create({
    data: { name: `${os.hostname()} (local)`, kind: 'local', host: null, sshUser: 'root', status: 'online' }
  }).catch(() => {/* table not migrated yet — no-op */})
}

// Map a Server DB row to the minimal shape server-exec needs. Local → null.
export function toServerCtx(server: { kind: string; host: string | null; port: number; sshUser: string; sshKey: string | null } | null): ServerCtx {
  if (!server || server.kind === 'local' || !server.host) return null
  return { kind: server.kind, host: server.host, port: server.port, sshUser: server.sshUser, sshKey: server.sshKey }
}

// Resolve the execution context for a given serverId (null/undefined → local).
export async function serverCtxById(prisma: PrismaClient, serverId: number | null | undefined): Promise<ServerCtx> {
  if (!serverId) return null
  const server = await (prisma as any).server.findUnique({ where: { id: serverId } }).catch(() => null)
  return toServerCtx(server)
}

// Convenience: resolve the execution context for a site row (uses site.serverId).
export async function serverCtxForSite(prisma: PrismaClient, site: { serverId?: number | null }): Promise<ServerCtx> {
  return serverCtxById(prisma, site.serverId ?? null)
}
