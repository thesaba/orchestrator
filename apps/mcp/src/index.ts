#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import express from 'express'
import { OrchestratorClient } from './orchestrator.js'
import { registerTools } from './tools.js'

// ── Minimal .env loader (no dependency). Real env always wins. ────────────────
function loadEnv() {
  try {
    for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/)
      if (!m) continue
      let v = m[2]
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
      if (!(m[1] in process.env)) process.env[m[1]] = v
    }
  } catch { /* no .env — rely on real env */ }
}
loadEnv()

const BASE_URL = process.env.ORCHESTRATOR_URL
const TOKEN = process.env.ORCHESTRATOR_TOKEN
const ENABLE_ACTIONS = process.env.MCP_ENABLE_ACTIONS !== 'false'
const HTTP_PORT = process.env.MCP_HTTP_PORT ? Number(process.env.MCP_HTTP_PORT) : null
const HTTP_AUTH = process.env.MCP_HTTP_AUTH

if (!BASE_URL || !TOKEN) {
  console.error('[orchestrator-mcp] ORCHESTRATOR_URL and ORCHESTRATOR_TOKEN are required (see .env.example).')
  process.exit(1)
}

const client = new OrchestratorClient({ baseUrl: BASE_URL, token: TOKEN })

function buildServer(): McpServer {
  const server = new McpServer({ name: 'orchestrator', version: '1.0.0' })
  registerTools(server, client, { enableActions: ENABLE_ACTIONS })
  return server
}

async function runStdio() {
  // Validate the token up front so misconfig is obvious (stderr only — stdout is
  // reserved for the MCP protocol on stdio).
  const who = await client.whoami()
  console.error(`[orchestrator-mcp] ${BASE_URL} · actions=${ENABLE_ACTIONS ? 'on' : 'off'} · ${who.detail}`)
  const server = buildServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function runHttp(port: number) {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // Optional shared-secret gate for remote use.
  app.use((req, res, next) => {
    if (!HTTP_AUTH) return next()
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (bearer !== HTTP_AUTH) { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  })

  const transports: Record<string, StreamableHTTPServerTransport> = {}

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport = sessionId ? transports[sessionId] : undefined

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports[sid] = transport! }
      })
      transport.onclose = () => { if (transport!.sessionId) delete transports[transport!.sessionId] }
      await buildServer().connect(transport)
    } else if (!transport) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session; send an initialize request first.' }, id: null })
      return
    }
    await transport.handleRequest(req, res, req.body)
  })

  const sessionStream = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    const transport = sessionId ? transports[sessionId] : undefined
    if (!transport) { res.status(400).send('Invalid or missing session id'); return }
    await transport.handleRequest(req, res)
  }
  app.get('/mcp', sessionStream)     // server→client notifications (SSE)
  app.delete('/mcp', sessionStream)  // terminate a session

  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  const who = await client.whoami()
  app.listen(port, () => {
    console.error(`[orchestrator-mcp] HTTP on :${port}/mcp · ${BASE_URL} · actions=${ENABLE_ACTIONS ? 'on' : 'off'} · auth=${HTTP_AUTH ? 'on' : 'OFF'} · ${who.detail}`)
  })
}

;(HTTP_PORT ? runHttp(HTTP_PORT) : runStdio()).catch((e) => {
  console.error('[orchestrator-mcp] fatal:', e)
  process.exit(1)
})
