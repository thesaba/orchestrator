// Thin HTTP client for the Orchestrator API. Authenticates with a Personal
// Access Token (Bearer orch_…), reusing the panel's existing auth / RBAC / audit.
// It NEVER returns secrets — callers only ever pass through what the API returns,
// and the panel already redacts credentials on its side.

import { AsyncLocalStorage } from 'node:async_hooks'

// Carries the current MCP tool name through async calls so the client can tag
// each request with an X-MCP-Tool header (the panel logs it as "which tool").
export const toolContext = new AsyncLocalStorage<string>()

export interface OrchestratorClientOptions {
  baseUrl: string
  token: string
}

export class OrchestratorError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'OrchestratorError'
  }
}

export class OrchestratorClient {
  private baseUrl: string
  private token: string

  constructor(opts: OrchestratorClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.token = opts.token
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api${path}`
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const tool = toolContext.getStore()
    if (tool) headers['x-mcp-tool'] = tool

    let res: Response
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
    } catch (e) {
      throw new OrchestratorError(0, `Could not reach Orchestrator at ${this.baseUrl}: ${(e as Error).message}`)
    }

    const text = await res.text()
    let parsed: unknown = undefined
    if (text) { try { parsed = JSON.parse(text) } catch { parsed = text } }

    if (!res.ok) {
      const msg = (parsed && typeof parsed === 'object' && 'error' in (parsed as any))
        ? String((parsed as any).error)
        : (typeof parsed === 'string' ? parsed : `HTTP ${res.status}`)
      throw new OrchestratorError(res.status, msg)
    }
    return parsed as T
  }

  get<T>(path: string) { return this.request<T>('GET', path) }
  post<T>(path: string, body?: unknown) { return this.request<T>('POST', path, body) }

  /** Confirm the token works and report who it belongs to (role gates which tools do anything). */
  async whoami(): Promise<{ ok: boolean; detail: string }> {
    try {
      // /api/sites is available to any authenticated user; a 200 proves the PAT is valid.
      const sites = await this.get<unknown[]>('/sites')
      return { ok: true, detail: `token OK — ${Array.isArray(sites) ? sites.length : 0} site(s) visible` }
    } catch (e) {
      const err = e as OrchestratorError
      return { ok: false, detail: `${err.status || ''} ${err.message}`.trim() }
    }
  }
}
