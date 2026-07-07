import { execOn, ServerCtx, isLocal } from './server-exec'
import { getSystemStats } from '../routes/monitor'

/**
 * Per-server system stats.
 *
 * For the local server this simply delegates to the original getSystemStats()
 * (Node `os` + df/free) — unchanged. For a remote server it runs ONE bash
 * command over SSH that emits machine-readable lines, then parses them into the
 * exact same shape, so the frontend/monitors don't care where the numbers came
 * from.
 */

export interface SystemStats {
  cpu: { load1: number; load5: number; load15: number; cores: number; percent: number }
  ram: { total: number; used: number; free: number; percent: number }
  disk: { total: number; used: number; percent: number }
  swap: { total: number; used: number; percent: number }
  uptime: number
  hostname: string
}

const REMOTE_SCRIPT = [
  'echo "LOAD $(awk \'{print $1,$2,$3}\' /proc/loadavg)"',
  'echo "CORES $(nproc 2>/dev/null || echo 1)"',
  'echo "MEM $(free -b | awk \'/^Mem:/{print $2,$3,$4}\')"',
  'echo "SWAP $(free -b | awk \'/^Swap:/{print $2,$3}\')"',
  'echo "DISK $(df -k / | awk \'NR==2{print $2,$3,$5}\')"',
  'echo "UPTIME $(awk \'{print $1}\' /proc/uptime)"',
  'echo "HOST $(hostname)"'
].join('; ')

function num(s: string | undefined): number {
  const n = parseFloat(s ?? '')
  return Number.isFinite(n) ? n : 0
}

export async function getRemoteSystemStats(ctx: ServerCtx): Promise<SystemStats> {
  const { stdout } = await execOn(ctx, 'bash', ['-lc', REMOTE_SCRIPT], { timeout: 15_000 })
  const map: Record<string, string[]> = {}
  for (const line of stdout.split('\n')) {
    const [key, ...rest] = line.trim().split(/\s+/)
    if (key) map[key] = rest
  }
  const load = map.LOAD ?? []
  const cores = Math.max(1, Math.round(num(map.CORES?.[0])) || 1)
  const memTotal = num(map.MEM?.[0])
  const memUsed = num(map.MEM?.[1])
  const memFree = num(map.MEM?.[2])
  const swapTotal = num(map.SWAP?.[0])
  const swapUsed = num(map.SWAP?.[1])
  const diskTotalK = num(map.DISK?.[0])
  const diskUsedK = num(map.DISK?.[1])
  const diskPct = parseInt(map.DISK?.[2] ?? '0', 10) || 0
  const load1 = num(load[0])

  return {
    cpu: {
      load1: Math.round(load1 * 100) / 100,
      load5: Math.round(num(load[1]) * 100) / 100,
      load15: Math.round(num(load[2]) * 100) / 100,
      cores,
      percent: Math.min(100, Math.round((load1 / cores) * 100))
    },
    ram: {
      total: memTotal, used: memUsed, free: memFree,
      percent: memTotal > 0 ? Math.round((memUsed / memTotal) * 100) : 0
    },
    disk: { total: diskTotalK * 1024, used: diskUsedK * 1024, percent: diskPct },
    swap: {
      total: swapTotal, used: swapUsed,
      percent: swapTotal > 0 ? Math.round((swapUsed / swapTotal) * 100) : 0
    },
    uptime: Math.floor(num(map.UPTIME?.[0])),
    hostname: (map.HOST?.[0]) || 'remote'
  }
}

/** Stats for any server context: local → original path, remote → over SSH. */
export async function statsFor(ctx: ServerCtx): Promise<SystemStats> {
  if (isLocal(ctx)) return getSystemStats() as Promise<SystemStats>
  return getRemoteSystemStats(ctx)
}
