import { FastifyInstance } from 'fastify'
import { getBotToken, tgSend, tgEdit, tgAnswerCallback, escapeHtml, InlineKeyboard, ReplyKeyboard } from './telegram'

// Persistent bottom keyboard — always-visible quick buttons so navigation never
// requires remembering commands.
const REPLY_KB: ReplyKeyboard = {
  keyboard: [[{ text: '🌐 Sites' }, { text: '✅ Tasks' }], [{ text: '🖥 Status' }, { text: '❓ Help' }]],
  resize_keyboard: true,
  is_persistent: true
}
// Map the reply-keyboard labels to their slash-command equivalents.
const LABEL_CMD: Record<string, string> = {
  '🌐 Sites': '/sites', '✅ Tasks': '/tasks', '🖥 Status': '/status', '❓ Help': '/help'
}

// ── Identity ─────────────────────────────────────────────────────────────────

interface BotUser { userId: number; email: string; role: string }

async function resolveUser(app: FastifyInstance, tgUserId: number | string): Promise<BotUser | null> {
  const link = await app.prisma.telegramLink.findUnique({
    where: { telegramUserId: String(tgUserId) },
    include: { user: { select: { id: true, email: true, role: true } } }
  }).catch(() => null)
  if (!link?.user) return null
  return { userId: link.user.id, email: link.user.email, role: link.user.role }
}

const isAdmin = (u: BotUser) => u.role === 'admin'
const canWrite = (u: BotUser) => u.role !== 'viewer'

// Call the panel's OWN HTTP API as the resolved user (fresh short-lived JWT), so
// every bot action reuses the exact route + RBAC + audit + services — no
// duplicated logic and no new code path near the hosted sites.
async function callApi(app: FastifyInstance, user: BotUser, method: string, url: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const token = app.jwt.sign({ userId: user.userId, email: user.email, role: user.role }, { expiresIn: '2m' })
  const headers: Record<string, string> = { authorization: `Bearer ${token}` }
  const opts: any = { method: method as any, url, headers }
  // For non-GET requests always send a VALID JSON body ({} when there's no
  // real payload). An application/json header with an EMPTY body makes Fastify
  // fail to parse it and return 400 "Bad Request" — sending {} avoids that and
  // is harmless (the deploy route reads query params, not the body).
  if (method.toUpperCase() !== 'GET') {
    headers['content-type'] = 'application/json'
    opts.payload = payload ?? {}
  }
  const res = await app.inject(opts)
  let body: any = null
  try { body = res.json() } catch { /* non-JSON */ }
  return { status: res.statusCode, body }
}

const NOT_LINKED = 'This Telegram account isn\'t linked yet.\n\nOpen the panel → <b>Settings → Integrations → Telegram</b> and follow the link steps.'

function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ')
}

function mainMenu(user: BotUser): InlineKeyboard {
  const rows: { text: string; callback_data: string }[][] = [[
    { text: '🌐 Sites', callback_data: 'sites' },
    { text: '✅ Tasks', callback_data: 'tasks' }
  ]]
  if (isAdmin(user)) rows.push([
    { text: '🖥 System', callback_data: 'sys' },
    { text: '🔧 Services', callback_data: 'svcs' },
    { text: '🐞 Errors', callback_data: 'errs' }
  ])
  return { inline_keyboard: rows }
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function handleTelegramUpdate(app: FastifyInstance, update: any): Promise<void> {
  const token = await getBotToken(app)
  if (!token) return
  try {
    if (update.message?.text) await handleMessage(app, token, update.message)
    else if (update.callback_query) await handleCallback(app, token, update.callback_query)
  } catch (err: unknown) {
    app.log.warn(`telegram bot: ${(err as Error).message}`)
  }
}

// ── Messages / commands ──────────────────────────────────────────────────────

async function handleMessage(app: FastifyInstance, token: string, msg: any): Promise<void> {
  const chatId = msg.chat.id
  const from = msg.from
  const text = String(msg.text).trim()

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1]
    if (code) {
      const msg2 = await tryLink(app, code, from, chatId)
      return void tgSend(token, chatId, msg2, REPLY_KB)
    }
    const u = await resolveUser(app, from.id)
    return void (u
      ? tgSend(token, chatId, `👋 Welcome back, <b>${escapeHtml(u.email)}</b>.`, REPLY_KB).then(() => tgSend(token, chatId, 'Main menu:', mainMenu(u)))
      : tgSend(token, chatId, NOT_LINKED))
  }

  const user = await resolveUser(app, from.id)
  if (!user) return void tgSend(token, chatId, NOT_LINKED)

  // Reply-keyboard labels behave like their slash commands.
  const cmd = LABEL_CMD[text] ?? text

  if (cmd === '/sites')  return void tgSend(token, chatId, ...(await sitesView(app, user)))
  if (cmd === '/status' || cmd === '/system') return void tgSend(token, chatId, ...(await systemView(app, user)))
  if (cmd === '/tasks')  return void tgSend(token, chatId, ...(await tasksView(app, user)))
  if (cmd === '/help' || cmd === '/menu') {
    return void tgSend(token, chatId,
      '<b>Orchestrator bot</b>\nManage your sites & tasks from here.\n\n/sites — your sites\n/tasks — your tasks\n/task &lt;title&gt; — quick task\n/status — server status (admin)\n\n<b>Billing (admin)</b>\n/invoices — everything still owed\n/overdue — only past-due invoices\n/paid &lt;id|number&gt; — mark an invoice fully paid\n\nTip: use the buttons below or under each message.',
      REPLY_KB).then(() => tgSend(token, chatId, 'Main menu:', mainMenu(user)))
  }
  if (text.startsWith('/task ')) {
    const title = text.slice(6).trim()
    if (!title) return void tgSend(token, chatId, 'Usage: /task &lt;title&gt;')
    const { status } = await callApi(app, user, 'POST', '/api/tasks', { title })
    return void tgSend(token, chatId, status < 300 ? `✅ Task added: ${escapeHtml(title)}` : '⚠️ Could not add task')
  }

  // ── Billing (admin-only; callApi injects the user's own role, so a
  //    non-admin simply gets a 403 back and is told so) ─────────────────────
  if (cmd === '/invoices' || cmd === '/overdue') {
    return void tgSend(token, chatId, await billingListView(app, user, cmd === '/overdue'))
  }
  if (text.startsWith('/paid')) {
    const arg = text.slice(5).trim()
    if (!arg) return void tgSend(token, chatId, 'Usage: /paid &lt;invoice id or number&gt;\nExample: /paid 42 — or — /paid INV-2026-0042')
    return void tgSend(token, chatId, await markPaidView(app, user, arg))
  }

  return void tgSend(token, chatId, 'Unknown command. Use the buttons below or /help.', mainMenu(user))
}

// ── Callback buttons ─────────────────────────────────────────────────────────

async function handleCallback(app: FastifyInstance, token: string, cq: any): Promise<void> {
  await tgAnswerCallback(token, cq.id)
  const chatId = cq.message?.chat?.id
  const messageId = cq.message?.message_id
  const user = await resolveUser(app, cq.from.id)
  if (!user || chatId == null) return void tgSend(token, chatId ?? cq.from.id, NOT_LINKED)

  const parts = String(cq.data ?? '').split(':')
  const action = parts[0]
  const edit = (text: string, kb?: InlineKeyboard) => tgEdit(token, chatId, messageId, text, kb)

  switch (action) {
    case 'menu':  return void edit('<b>Orchestrator</b> — main menu', mainMenu(user))
    case 'sites': return void edit(...(await sitesView(app, user)))
    case 'site':  return void edit(...(await siteView(app, user, Number(parts[1]))))
    case 'tasks': return void edit(...(await tasksView(app, user)))
    case 'sys':   return void edit(...(await systemView(app, user)))
    case 'svcs':  return void edit(...(await servicesView(app, user)))
    case 'errs':  return void edit(...(await errorsView(app, user)))

    case 'deploy': // ask confirmation
      return void edit('Deploy the latest commit? This runs the full zero-downtime pipeline.', {
        inline_keyboard: [[
          { text: '✅ Deploy', callback_data: `deployc:${parts[1]}` },
          { text: '⬅️ Back', callback_data: `site:${parts[1]}` }
        ]]
      })
    case 'deployc': return void edit(await doDeploy(app, user, Number(parts[1])), backTo(`site:${parts[1]}`))
    case 'deploys':
      return void edit('Deploy the latest commit <b>without running tests</b>?', {
        inline_keyboard: [[
          { text: '⚡ Deploy (skip tests)', callback_data: `deploysc:${parts[1]}` },
          { text: '⬅️ Back', callback_data: `site:${parts[1]}` }
        ]]
      })
    case 'deploysc': return void edit(await doDeploy(app, user, Number(parts[1]), true), backTo(`site:${parts[1]}`))
    case 'clear':   return void edit(await doClear(app, user, Number(parts[1])), backTo(`site:${parts[1]}`))
    case 'ssl':     return void edit(...(await sslView(app, user, Number(parts[1]))))
    case 'recent':  return void edit(...(await recentView(app, user, Number(parts[1]))))
    case 'maint':   return void edit(await maintToggle(app, user, Number(parts[1]), parts[2] ?? 'down'), backTo(`site:${parts[1]}`))
    case 'rollback':
      return void edit('Roll back to the previous release?', {
        inline_keyboard: [[
          { text: '↩️ Roll back', callback_data: `rollbackc:${parts[1]}` },
          { text: '⬅️ Back', callback_data: `site:${parts[1]}` }
        ]]
      })
    case 'rollbackc': return void edit(await doRollback(app, user, Number(parts[1])), backTo(`site:${parts[1]}`))

    case 'svc': return void edit(await doRestartService(app, user, parts[1], parts[2] ?? 'restart'), backTo('svcs'))

    case 'taskdone': {
      const { status } = await callApi(app, user, 'PATCH', `/api/tasks/${Number(parts[1])}`, { status: 'done' })
      if (status >= 300) return void edit('⚠️ Could not update task.', backTo('tasks'))
      return void edit(...(await tasksView(app, user)))
    }
    default: return void edit('Unknown action.', mainMenu(user))
  }
}

const backTo = (cb: string): InlineKeyboard => ({ inline_keyboard: [[{ text: '⬅️ Back', callback_data: cb }]] })

// ── Views (return [text, keyboard]) ──────────────────────────────────────────

function siteStatusEmoji(s: any): string {
  const st = s.deployments?.[0]?.status
  if (st === 'success') return '🟢'
  if (st === 'failed') return '🔴'
  if (st === 'running') return '🟡'
  return s.status === 'active' ? '🟢' : '⚪'
}

async function sitesView(app: FastifyInstance, user: BotUser): Promise<[string, InlineKeyboard]> {
  const { body } = await callApi(app, user, 'GET', '/api/sites')
  const sites: any[] = Array.isArray(body) ? body : []
  if (!sites.length) return ['You have no sites.', mainMenu(user)]
  const rows = sites.slice(0, 20).map((s) => [{ text: `${siteStatusEmoji(s)} ${s.domain}`, callback_data: `site:${s.id}` }])
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu' }])
  return [`<b>Your sites</b> (${sites.length})`, { inline_keyboard: rows }]
}

async function siteView(app: FastifyInstance, user: BotUser, siteId: number): Promise<[string, InlineKeyboard]> {
  const { body } = await callApi(app, user, 'GET', '/api/sites')
  const site = (Array.isArray(body) ? body : []).find((s: any) => s.id === siteId)
  if (!site) return ['Site not found or no access.', backTo('sites')]
  const last = site.deployments?.[0]
  const lines = [
    `<b>${escapeHtml(site.domain)}</b>`,
    `PHP ${site.phpVersion} · ${site.sslEnabled ? '🔒 SSL' : 'no SSL'}${site.maintenanceMode ? ' · 🔧 maintenance' : ''}`,
    `Last deploy: ${last ? `${last.status} — ${last.branch}${last.commit ? ` @ ${last.commit}` : ''}` : '—'}`,
    site.sslDaysLeft != null ? `SSL: ${site.sslDaysLeft}d left` : ''
  ].filter(Boolean)

  const rows: { text: string; callback_data: string }[][] = []
  if (canWrite(user)) {
    rows.push([
      { text: '🚀 Deploy', callback_data: `deploy:${siteId}` },
      { text: '⚡ Deploy (skip tests)', callback_data: `deploys:${siteId}` }
    ])
    rows.push([
      { text: '🧹 Clear cache', callback_data: `clear:${siteId}` },
      { text: '↩️ Rollback', callback_data: `rollback:${siteId}` }
    ])
    rows.push([{
      text: site.maintenanceMode ? '✅ Maintenance OFF' : '🔧 Maintenance ON',
      callback_data: `maint:${siteId}:${site.maintenanceMode ? 'up' : 'down'}`
    }])
  }
  rows.push([
    { text: '🔒 SSL', callback_data: `ssl:${siteId}` },
    { text: '📜 Recent deploys', callback_data: `recent:${siteId}` }
  ])
  rows.push([
    { text: '⬅️ Sites', callback_data: 'sites' },
    { text: '🏠 Menu', callback_data: 'menu' }
  ])
  return [lines.join('\n'), { inline_keyboard: rows }]
}

async function sslView(app: FastifyInstance, user: BotUser, siteId: number): Promise<[string, InlineKeyboard]> {
  const { body } = await callApi(app, user, 'GET', `/api/sites/${siteId}/ssl`)
  if (!body) return ['Could not read SSL info.', backTo(`site:${siteId}`)]
  const days = body.daysLeft ?? body.daysRemaining
  const lines = [
    `<b>SSL</b> — ${body.sslEnabled ? '🔒 enabled' : 'not enabled'}`,
    days != null ? `Expires in ${days} day${days === 1 ? '' : 's'}` : '',
    body.expiresAt ? `Valid until ${new Date(body.expiresAt).toLocaleDateString()}` : ''
  ].filter(Boolean)
  return [lines.join('\n'), backTo(`site:${siteId}`)]
}

async function recentView(app: FastifyInstance, user: BotUser, siteId: number): Promise<[string, InlineKeyboard]> {
  const { body } = await callApi(app, user, 'GET', '/api/sites')
  const site = (Array.isArray(body) ? body : []).find((s: any) => s.id === siteId)
  const deps: any[] = site?.deployments ?? []
  if (!deps.length) return ['No deployments yet.', backTo(`site:${siteId}`)]
  const emoji = (s: string) => s === 'success' ? '🟢' : s === 'failed' ? '🔴' : s === 'running' ? '🟡' : '⚪'
  const text = ['<b>Recent deploys</b>', ...deps.slice(0, 6).map((d) =>
    `${emoji(d.status)} ${d.branch}${d.commit ? ` @ ${d.commit}` : ''} · ${new Date(d.createdAt).toLocaleString()}`
  )].join('\n')
  return [text, backTo(`site:${siteId}`)]
}

async function maintToggle(app: FastifyInstance, user: BotUser, siteId: number, action: string): Promise<string> {
  const { status, body } = await callApi(app, user, 'POST', `/api/sites/${siteId}/maintenance`, { action })
  if (status >= 300) return `⚠️ ${escapeHtml(body?.error ?? 'Failed')}`
  return action === 'down' ? '🔧 Maintenance mode ON.' : '✅ Maintenance mode OFF.'
}

async function doDeploy(app: FastifyInstance, user: BotUser, siteId: number, skip = false): Promise<string> {
  const { status, body } = await callApi(app, user, 'POST', `/api/sites/${siteId}/deploy${skip ? '?skipTests=1' : ''}`)
  if (status >= 300) return `⚠️ ${escapeHtml(body?.error ?? 'Deploy failed to start')}`
  if (body?.queued) return '🕒 Deploy queued — it will start after the current one finishes.'
  return '🚀 Deploy started. You\'ll get a notification when it finishes.'
}

async function doClear(app: FastifyInstance, user: BotUser, siteId: number): Promise<string> {
  const { status, body } = await callApi(app, user, 'POST', `/api/sites/${siteId}/artisan/run`, { command: 'optimize:clear' })
  return status >= 300 ? `⚠️ ${escapeHtml(body?.error ?? 'Failed')}` : '🧹 Cache clear started (optimize:clear).'
}

async function doRollback(app: FastifyInstance, user: BotUser, siteId: number): Promise<string> {
  const rel = await callApi(app, user, 'GET', `/api/sites/${siteId}/releases`)
  const releases: any[] = rel.body?.releases ?? []
  const previous = releases.find((r) => !r.isCurrent)
  if (!previous) return '⚠️ No previous release to roll back to.'
  const { status, body } = await callApi(app, user, 'POST', `/api/sites/${siteId}/rollback`, { release: previous.name })
  return status >= 300 ? `⚠️ ${escapeHtml(body?.error ?? 'Rollback failed')}` : `↩️ Rolling back to ${previous.name}.`
}

async function systemView(app: FastifyInstance, user: BotUser): Promise<[string, InlineKeyboard]> {
  if (!isAdmin(user)) return ['🔒 Server status is admin-only.', mainMenu(user)]
  const { body } = await callApi(app, user, 'GET', '/api/monitor/system')
  if (!body) return ['Could not read system stats.', mainMenu(user)]
  const text = [
    `<b>${escapeHtml(body.hostname ?? 'server')}</b>`,
    `CPU ${body.cpu?.percent ?? '?'}%  ·  RAM ${body.ram?.percent ?? '?'}%  ·  Disk ${body.disk?.percent ?? '?'}%`,
    `Uptime: ${fmtUptime(body.uptime ?? 0)}`
  ].join('\n')
  return [text, { inline_keyboard: [[{ text: '🔧 Services', callback_data: 'svcs' }, { text: '🐞 Errors', callback_data: 'errs' }], [{ text: '⬅️ Menu', callback_data: 'menu' }]] }]
}

async function servicesView(app: FastifyInstance, user: BotUser): Promise<[string, InlineKeyboard]> {
  if (!isAdmin(user)) return ['🔒 Service control is admin-only.', mainMenu(user)]
  const { body } = await callApi(app, user, 'GET', '/api/monitor/services')
  const services: any[] = Array.isArray(body) ? body : []
  const text = ['<b>Services</b>', ...services.map((s) => `${s.status === 'active' ? '🟢' : '🔴'} ${s.name}`)].join('\n')
  const rows = services.map((s) => [{ text: `🔄 Restart ${s.name}`, callback_data: `svc:${s.key}:restart` }])
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu' }])
  return [text, { inline_keyboard: rows }]
}

async function doRestartService(app: FastifyInstance, user: BotUser, key: string, act: string): Promise<string> {
  if (!isAdmin(user)) return '🔒 Admins only.'
  const { status, body } = await callApi(app, user, 'POST', `/api/monitor/services/${encodeURIComponent(key)}/control`, { action: act })
  if (status >= 300) return `⚠️ ${escapeHtml(body?.error ?? 'Failed')}`
  return `${body?.status === 'active' ? '🟢' : '🔴'} ${escapeHtml(key)} ${act} → ${body?.status ?? 'done'}`
}

async function errorsView(app: FastifyInstance, user: BotUser): Promise<[string, InlineKeyboard]> {
  if (!isAdmin(user)) return ['🔒 Errors are admin-only.', mainMenu(user)]
  const { body } = await callApi(app, user, 'GET', '/api/log-errors?resolved=0')
  const errors: any[] = body?.errors ?? []
  if (!errors.length) return ['🎉 No unresolved errors.', backTo('menu')]
  const text = [`<b>Unresolved errors</b> (${body.unresolved})`, ...errors.slice(0, 8).map((e) =>
    `🔴 <b>${escapeHtml(e.exceptionClass ?? e.level)}</b> ×${e.count} · ${escapeHtml(e.site?.domain ?? '')}\n<i>${escapeHtml((e.message ?? '').slice(0, 80))}</i>`
  )].join('\n\n')
  return [text, backTo('menu')]
}

async function tasksView(app: FastifyInstance, user: BotUser): Promise<[string, InlineKeyboard]> {
  const { body } = await callApi(app, user, 'GET', '/api/tasks?mine=1')
  const tasks: any[] = (body?.tasks ?? []).filter((t: any) => t.status !== 'done')
  if (!tasks.length) return ['🎉 No open tasks assigned to you.', mainMenu(user)]
  const text = ['<b>Your open tasks</b>', ...tasks.slice(0, 10).map((t) => `• ${escapeHtml(t.title)} <i>(${t.status})</i>`)].join('\n')
  const rows = tasks.slice(0, 10).map((t) => [{ text: `✓ ${t.title.slice(0, 40)}`, callback_data: `taskdone:${t.id}` }])
  rows.push([{ text: '⬅️ Menu', callback_data: 'menu' }])
  return [text, { inline_keyboard: rows }]
}

// ── Linking ──────────────────────────────────────────────────────────────────

async function tryLink(app: FastifyInstance, code: string, from: any, chatId: number | string): Promise<string> {
  const link = await app.prisma.telegramLink.findUnique({ where: { linkCode: code } }).catch(() => null)
  if (!link || !link.linkCodeExpires || link.linkCodeExpires.getTime() < Date.now()) {
    return '⚠️ Invalid or expired link code. Generate a new one in the panel.'
  }
  const existing = await app.prisma.telegramLink.findUnique({ where: { telegramUserId: String(from.id) } }).catch(() => null)
  if (existing && existing.userId !== link.userId) {
    return '⚠️ This Telegram account is already linked to another user.'
  }
  await app.prisma.telegramLink.update({
    where: { id: link.id },
    data: {
      telegramUserId: String(from.id),
      chatId: String(chatId),
      username: from.username ?? null,
      linkedAt: new Date(),
      linkCode: null,
      linkCodeExpires: null
    }
  })
  const u = await app.prisma.user.findUnique({ where: { id: link.userId }, select: { email: true } })
  app.audit('telegram.linked', { meta: { userId: link.userId, telegramUserId: String(from.id) } })
  return `✅ Linked as <b>${escapeHtml(u?.email ?? '')}</b>. Send /help to get started.`
}

// ── Billing views ───────────────────────────────────────────────────────────
// These call the admin-only /api/billing endpoints through `callApi`, which
// signs a short-lived JWT carrying the *Telegram user's own role*. A developer
// or viewer therefore gets a clean 403 instead of any billing data — the bot
// never widens permissions.

function money(minor: number, currency = 'GEL'): string {
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '₾'
  const s = (Math.abs(minor) / 100).toFixed(2)
  return currency === 'GEL' ? `${s} ${sym}` : `${sym}${s}`
}

async function billingListView(app: FastifyInstance, user: BotUser, overdueOnly: boolean): Promise<string> {
  const path = overdueOnly ? '/api/billing/invoices/overdue' : '/api/billing/invoices?status=open'
  const { status, body } = await callApi(app, user, 'GET', path)
  if (status === 403) return '🚫 Billing is admin-only.'
  if (status >= 300 || !Array.isArray(body)) return '⚠️ Could not load invoices.'
  if (body.length === 0) return overdueOnly ? '✅ Nothing overdue.' : '✅ Nothing outstanding.'

  const rows = body.slice(0, 20).map((i: any) => {
    const bal = i.balance ?? i.amount
    const who = i.client?.name ?? i.client ?? '—'
    const dom = i.site?.domain ?? i.domain ?? '—'
    const due = new Date(i.dueDate).toISOString().slice(0, 10)
    return `<code>${escapeHtml(i.number)}</code> · ${escapeHtml(dom)}\n   ${escapeHtml(who)} — <b>${money(bal, i.currency)}</b> · due ${due}`
  })
  const total = body.reduce((s: number, i: any) => s + (i.balance ?? i.amount), 0)
  const head = overdueOnly ? `⚠️ <b>Overdue (${body.length})</b>` : `🧾 <b>Outstanding (${body.length})</b>`
  return `${head}\n\n${rows.join('\n')}\n\n<b>Total: ${money(total, body[0]?.currency)}</b>\n\nMark one paid: <code>/paid ${escapeHtml(body[0].number)}</code>`
}

async function markPaidView(app: FastifyInstance, user: BotUser, arg: string): Promise<string> {
  // Accept either the numeric id or the human invoice number.
  let id: number | null = /^\d+$/.test(arg) ? Number(arg) : null
  if (id === null) {
    const { status, body } = await callApi(app, user, 'GET', '/api/billing/invoices')
    if (status === 403) return '🚫 Billing is admin-only.'
    if (status >= 300 || !Array.isArray(body)) return '⚠️ Could not look up that invoice.'
    const match = body.find((i: any) => i.number?.toLowerCase() === arg.toLowerCase())
    if (!match) return `⚠️ No invoice named <code>${escapeHtml(arg)}</code>.`
    id = match.id
  }

  const { status, body } = await callApi(app, user, 'POST', `/api/billing/invoices/${id}/pay`, {
    method: 'cash',
    source: 'telegram',
    note: `Marked paid via Telegram by ${user.email}`
  })
  if (status === 403) return '🚫 Billing is admin-only.'
  if (status === 404) return '⚠️ Invoice not found.'
  if (status >= 300) return `⚠️ ${escapeHtml(body?.error ?? 'Could not record the payment.')}`

  const paid = body?.fullyPaid
    ? `✅ Invoice fully paid.`
    : `✅ Payment recorded. Remaining: <b>${money(body?.balance ?? 0)}</b>`
  const restored = body?.restored ? '\n🔓 Site restored — enforcement lifted.' : ''
  return `${paid}${restored}`
}
