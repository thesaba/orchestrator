import { FastifyInstance } from 'fastify'
import { getBotToken, tgSend, tgEdit, tgAnswerCallback, escapeHtml, InlineKeyboard } from './telegram'

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
  const res = await app.inject({
    method: method as any,
    url,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(payload !== undefined ? { payload: payload as any } : {})
  })
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
    if (code) return void tgSend(token, chatId, await tryLink(app, code, from, chatId))
    const u = await resolveUser(app, from.id)
    return void (u
      ? tgSend(token, chatId, `👋 Welcome back, <b>${escapeHtml(u.email)}</b>.`, mainMenu(u))
      : tgSend(token, chatId, NOT_LINKED))
  }

  const user = await resolveUser(app, from.id)
  if (!user) return void tgSend(token, chatId, NOT_LINKED)

  if (text === '/sites')  return void tgSend(token, chatId, ...(await sitesView(app, user)))
  if (text === '/status' || text === '/system') return void tgSend(token, chatId, ...(await systemView(app, user)))
  if (text === '/tasks')  return void tgSend(token, chatId, ...(await tasksView(app, user)))
  if (text.startsWith('/task ')) {
    const title = text.slice(6).trim()
    if (!title) return void tgSend(token, chatId, 'Usage: /task &lt;title&gt;')
    const { status } = await callApi(app, user, 'POST', '/api/tasks', { title })
    return void tgSend(token, chatId, status < 300 ? `✅ Task added: ${escapeHtml(title)}` : '⚠️ Could not add task')
  }
  if (text === '/help' || text === '/menu') {
    return void tgSend(token, chatId,
      '<b>Orchestrator bot</b>\nManage your sites & tasks from here.\n\n/sites — your sites\n/tasks — your tasks\n/task &lt;title&gt; — quick task\n/status — server status (admin)\n/help — this menu',
      mainMenu(user))
  }
  return void tgSend(token, chatId, 'Unknown command. Send /help.', mainMenu(user))
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
    case 'clear':   return void edit(await doClear(app, user, Number(parts[1])), backTo(`site:${parts[1]}`))
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
      { text: '🧹 Clear cache', callback_data: `clear:${siteId}` }
    ])
    rows.push([{ text: '↩️ Rollback', callback_data: `rollback:${siteId}` }])
  }
  rows.push([{ text: '⬅️ Sites', callback_data: 'sites' }])
  return [lines.join('\n'), { inline_keyboard: rows }]
}

async function doDeploy(app: FastifyInstance, user: BotUser, siteId: number): Promise<string> {
  const { status, body } = await callApi(app, user, 'POST', `/api/sites/${siteId}/deploy`)
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
