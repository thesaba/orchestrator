# პრომპტი Claude-ისთვის — Orchestrator iOS აპლიკაცია (SwiftUI)

> ეს ფაილი მთლიანად ჩააკოპირე Claude-თან (Claude Code ან Cowork) და დაავალე მუშაობის დაწყება.
> აპლიკაცია პირადი გამოყენებისთვისაა — მხოლოდ ერთი მომხმარებელი (admin), App Store-ზე გამოქვეყნება არ იგეგმება.

---

## შენი როლი და მიზანი

შენ ხარ senior iOS დეველოპერი. უნდა ააგო **ნატიური SwiftUI აპლიკაცია iOS-ისთვის**, რომელიც კლიენტად ემსახურება უკვე არსებულ **Orchestrator** REST API-ს. ბექენდის კოდი არ იცვლება — მთელი ლოგიკა უკვე სერვერზეა, შენ მხოლოდ სრულფასოვან ნატიურ კლიენტს აშენებ.

**მთავარი მოთხოვნა:** გადაიტანე აპლიკაციაში **აბსოლუტურად ყველა ფუნქციონალი**, რის საშუალებასაც არსებული API იძლევა — ქვემოთ ჩამოთვლილი ყველა endpoint. არაფერი გამოტოვო.

---

## ბექენდის კონტექსტი

Orchestrator არის self-hosted control panel PHP/Laravel საიტების სამართავად (multi-server, agentless SSH-ით). სტეკი: Fastify + Prisma + SQLite (API), React + Vite (web). შენ web-ს არ ეხები — ნატიურ iOS ალტერნატივას აკეთებ.

- **Base URL:** `https://orchestrator.abesadze.digital`
- **API prefix:** ყველა endpoint `/api`-ით იწყება (მაგ. `https://orchestrator.abesadze.digital/api/sites`)
- **TLS:** რეალური Let's Encrypt სერტიფიკატი — App Transport Security-ს პრობლემა არ ექნება, არანაირი exception არ გჭირდება.
- **ფული billing-ში:** ინახება **integer minor units-ში (თეთრი)** — არასდროს float. UI-ში გაყავი 100-ზე ჩვენებისას (მაგ. `5000` → `50.00 GEL`).

---

## ავთენტიფიკაცია (კრიტიკული — ჯერ ეს ააგე)

ორი გზა არსებობს; **გამოიყენე Personal Access Token (PAT)** როგორც ძირითადი, JWT login როგორც ალტერნატივა.

### 1. Personal Access Token (რეკომენდებული)
- Token იწყება პრეფიქსით `orch_`.
- ყოველ request-ში ეგზავნება header-ით: `Authorization: Bearer orch_xxxxx`.
- Token გენერირდება panel-ში (Settings → API tokens). აპში მომხმარებელი ერთხელ ჩააკოპირებს.
- **შეინახე iOS Keychain-ში** (არა UserDefaults). არასდროს დაალოგო.
- Endpoints token-ების სამართავად: `GET /api/tokens`, `POST /api/tokens`, `DELETE /api/tokens/:id`.

### 2. JWT login (ალტერნატივა)
- `POST /api/auth/login` body: `{ email, password, totpCode? }`.
- პასუხი: `{ token }` (JWT). თუ 2FA ჩართულია და კოდი არ მიეცა → პასუხი `{ requiresTOTP: true }` (მაშინ ხელახლა გააგზავნე `totpCode`-ით).
- JWT-საც იმავე `Authorization: Bearer <token>` header-ით აგზავნი.
- `GET /api/auth/me` → მიმდინარე მომხმარებელი.
- 2FA: `GET /api/auth/2fa/setup`, `POST /api/auth/2fa/enable`, `DELETE /api/auth/2fa`.

### Real-time არხების auth
SSE და WebSocket endpoint-ებიც `Authorization` header-ს ითხოვენ. **iOS-ის უპირატესობა:** ბრაუზერის `EventSource`-ისგან განსხვავებით, `URLSession`-ს header-ის დაყენება შეუძლია streaming request-ზეც — ამიტომ SSE-ს პირდაპირ Bearer header-ით მოიხმარ. WebSocket ტერმინალი token-ს query-ში იღებს: `?token=<token>`.

---

## ტექნიკური სტეკი (გამოიყენე ეს)

- **SwiftUI** — მთელი UI.
- **Swift Concurrency (async/await)** — ქსელისთვის, არა completion handlers.
- **URLSession** — HTTP + SSE streaming (`URLSession.bytes(for:)` line-by-line პარსინგისთვის).
- **Codable** — ყველა API მოდელი.
- **Swift Charts** — მეტრიკების/uptime გრაფიკები.
- **Keychain** (Security framework ან მცირე wrapper) — token-ის შესანახად.
- მინიმალური მესამე მხარის dependency. თუ SSE-სთვის რამე გჭირდება, ხელით დაწერე მარტივი parser.
- Target: iOS 17+.

---

## აპლიკაციის არქიტექტურა

აწყობე სუფთა ფენებად:

1. **`APIClient`** — ცენტრალური ქსელის ფენა: base URL, Bearer header-ის ავტომატური მიმაგრება, JSON encode/decode, ერთიანი error handling (401 → ხელახალი ავტორიზაცია, 4xx/5xx → typed error). ცალკე მეთოდი SSE stream-ისთვის (`AsyncStream<String>` აბრუნებდეს ლოგის ხაზებს).
2. **Models** — `Codable` struct-ები ყოველი resource-ისთვის (Site, Deployment, Invoice, MetricSample, ა.შ.).
3. **Feature modules** — თითო API დომენზე თითო SwiftUI ხედი + ViewModel (`@Observable` ან `ObservableObject`).
4. **Keychain wrapper** — token-ის save/load/delete.
5. **Design system** — ერთიანი ფერები, სტატუს-ბეჯები (active/suspended/degraded), reusable log console ხედი.

---

## სრული ფუნქციონალის რუკა (ყველა endpoint — არაფერი გამოტოვო)

### 🔐 Auth & Users
- `POST /api/auth/login`, `GET /api/auth/me`, 2FA setup/enable/delete
- **Users:** `GET/POST /api/users`, `PATCH/DELETE /api/users/:id`, `GET/PUT /api/users/:id/sites` (per-user site access)
- **Tokens:** `GET/POST /api/tokens`, `DELETE /api/tokens/:id`
- **Settings:** `GET/PUT /api/settings`, `POST /api/settings/change-password`
- **Audit log:** `GET /api/audit`

### 🌐 Sites (ბირთვი)
- `GET /api/sites` (სია — შეიცავს health, billing სტატუსს), `GET /api/sites/:id`, `GET /api/sites/tags`
- `POST /api/sites` (ახალი საიტი), `POST /api/sites/:id/clone`, `DELETE /api/sites/:id`
- `GET /api/sites/:id/branches` (git branch-ები)

### 🚀 Provision & Deploy
- **Provision:** `POST /api/sites/:id/provision`, `GET /api/sites/:id/provision/stream` **(SSE)**
- **Deploy:** `POST /api/sites/:id/deploy`, `POST /api/sites/:id/deploy/cancel`, `GET /api/sites/:id/deploy/pending`, `GET /api/sites/:id/deploy/stream` **(SSE)**
- `PATCH /api/sites/:id` (deploy settings), `POST /api/sites/:id/webhook-token`
- **Releases & rollback:** `GET /api/sites/:id/releases`, `POST /api/sites/:id/rollback`, `POST /api/sites/:id/deployments/:deployId/redeploy`
- `GET /api/sites/:id/deployments/heatmap`, `GET /api/sites/:id/test-stats` (deploy-ის ტესტების სტატისტიკა)

### ⚙️ Config (per-site)
- **Nginx:** `GET/PUT /api/sites/:id/config/nginx`
- **.env:** `GET/PUT /api/sites/:id/config/env` + versioning: `GET .../env/versions`, `GET .../env/versions/:vid`, `POST .../env/versions/:vid/restore`
- **PHP:** `GET /api/sites/:id/php-versions`, `POST /api/sites/:id/php-version`
- **PHP-FPM pool:** `GET/PUT /api/sites/:id/phpfpm`
- **SSL:** `GET /api/sites/:id/ssl`, `POST .../ssl` (issue), `POST .../ssl/renew`, `DELETE .../ssl`, `GET .../ssl/stream` **(SSE)**

### 🗄️ Database (per-site)
- **Backups:** `GET .../database/backups`, `POST .../database/backup`, download `GET .../database/backups/:filename`, `POST .../backups/:filename/restore`, `DELETE .../backups/:filename`
- **Schedule:** `GET/PUT/DELETE .../database/backup-schedule`
- **S3 backups:** `POST /api/sites/:siteId/database/backup/s3/:filename`, `GET .../backup/s3`, `DELETE .../backup/s3/*`
- **DB manage:** `GET/POST /api/sites/:id/databases`, `DELETE .../databases/:dbId`, `POST .../databases/:dbId/query`, `POST .../databases/:dbId/import`, `POST .../databases/:dbId/pma-session`

### 🔧 Laravel / PHP ოპერაციები (per-site)
- **Artisan:** `GET .../artisan/commands`, `POST .../artisan/run`, `GET .../artisan/stream` **(SSE)**
- **Composer:** `GET .../composer/outdated`, `POST .../composer/update`, `GET .../composer/info`
- **Maintenance mode:** `GET/POST /api/sites/:id/maintenance`
- **Queue / workers (Supervisor):** `GET/PUT .../supervisor`, `GET .../supervisor/status`, `POST .../supervisor/control` (start/stop/restart)
- **Scheduler (cron):** `GET/PUT/DELETE .../scheduler`, ასევე `GET/PUT/DELETE .../cron`
- **Failed jobs & queue:** `GET .../queue/stats`, `GET .../failed-jobs`, `POST .../failed-jobs/:jobId/retry`, `DELETE .../failed-jobs/:jobId`, `DELETE .../failed-jobs`, `POST .../failed-jobs/retry-all`

### 📁 File Manager (per-site — სრული)
- `GET .../files` (list), `GET .../files/read`, `PUT .../files/write`, `POST .../files/mkdir`, `POST .../files/touch`, `DELETE .../files/delete`
- `POST .../files/rename`, `.../copy`, `.../move`, `.../zip`, `.../unzip`, `.../tar`, `.../untar`, `.../chmod`, `.../chown`
- `GET .../files/download`, `POST .../files/download-zip`, `POST .../files/upload`, `GET .../files/search`, `GET .../files/diff`, `GET .../files/properties`

### 📊 Monitoring
- `GET /api/monitor/system` (CPU/RAM/disk), `GET /api/monitor/history`, `GET /api/monitor/stats/history`
- `GET /api/monitor/processes`, `GET /api/monitor/apm` (performance insights)
- **Services:** `GET /api/monitor/services`, `POST /api/monitor/services/:key/control`, `GET /api/monitor/services/:key/logs`
- `GET /api/monitor/ssl` (ყველა სერტიფიკატის ვადა), `GET /api/monitor/health-score/:siteId`
- **Live site logs:** `GET /api/monitor/logs/:siteId/stream` **(SSE)**
- **Uptime:** `GET /api/uptime`, `GET /api/uptime/:siteId/history`, `GET /api/uptime/:siteId/sparkline`, `PATCH /api/uptime/:siteId`
- **Laravel logs:** `GET /api/sites/:id/logs`, `DELETE /api/sites/:id/logs`
- **Dashboard:** `GET /api/dashboard`, `PUT /api/dashboard/auto`, `POST /api/dashboard/presets`, `DELETE /api/dashboard/presets/:id`

### 💰 Billing (ფული = თეთრი, integer)
- `GET /api/billing/overview`, `GET/PUT /api/billing/enforcement` (off/dry_run/on), `POST /api/billing/run-tick`
- **Clients:** `GET/POST /api/billing/clients`, `PATCH/DELETE /api/billing/clients/:id`, `POST /api/billing/clients/:id/rotate-token`
- **Plans:** `GET/POST /api/billing/plans`, `PATCH /api/billing/plans/:id`, `GET /api/billing/default-policy`
- **Subscriptions:** `GET/POST /api/billing/subscriptions`, `PATCH/DELETE .../subscriptions/:id`, `GET .../subscriptions/:id/preview`, `GET .../subscriptions/:id/events`, `POST .../subscriptions/:id/issue-invoice`, `POST .../subscriptions/:id/enforce`
- **Invoices:** `GET /api/billing/invoices`, `GET /api/billing/invoices/overdue`, `POST /api/billing/invoices/:id/pay` (mark paid), `POST /api/billing/invoices/:id/void`
- **Profitability:** `GET /api/billing/profitability` (cost vs price per site)

### 🖥️ Servers & System (infrastructure)
- **Servers (multi-server):** `GET/POST /api/servers`, `PATCH/DELETE /api/servers/:id`, `POST /api/servers/test-connection`, `POST /api/servers/:id/test`, `GET /api/servers/:id/health`, `POST /api/servers/:id/prepare`, `GET /api/servers/:id/prepare/stream` **(SSE)**
- **DigitalOcean droplet control:** `GET /api/server/status`, `/droplets`, `/sizes`, `POST /api/server/actions`, `GET /api/server/actions[/:id]`, `POST /api/server/resize`, `PATCH /api/server/rename`, snapshots (`GET/POST/DELETE /api/server/snapshots[/:id]`), `GET /api/server/backups`, firewalls (`GET /api/server/firewalls`, `POST/DELETE /api/server/firewalls/:id/rules`)
- **System:** `GET /api/system/info`, `GET /api/system/run/:key/stream` **(SSE — apt/services/disk/ufw ოპერაციები)**
- **Terminal:** `GET /api/terminal/:siteId` **(WebSocket, `?token=` query-ით)** — interactive shell

### 🔔 Notifications, Alerts, Errors, AI
- **Notifications:** `GET /api/notifications`, `POST /api/notifications/read-all`, `POST /api/notifications/:id/read`, `DELETE /api/notifications/:id`, `DELETE /api/notifications`
- **Alerts (rules):** `GET/POST /api/alerts`, `PATCH/DELETE /api/alerts/:id`
- **Log errors (mini-Sentry):** `GET /api/log-errors`, `GET/PATCH/DELETE /api/log-errors/:id`
- **AI assistant:** `GET/PATCH /api/ai/config`, `POST /api/ai/test`, `POST /api/ai/chat` (context-aware chat), `POST /api/ai/explain-error/:id`, `POST /api/ai/explain-deploy/:deploymentId`
- **Digest:** `GET/PATCH /api/digest`, `POST /api/digest/send-now`
- **Telegram:** `GET /api/telegram/me`, `POST /api/telegram/link-code`, `POST /api/telegram/unlink`, `POST /api/telegram/setup`, `POST /api/telegram/remove-webhook`

### 🗂️ Workspace (პროდუქტიულობა)
- **Tasks:** `GET/POST /api/tasks`, `GET/PATCH/DELETE /api/tasks/:id`, checklist (`POST .../checklist`, `PATCH/DELETE .../checklist/:itemId`), comments (`POST .../comments`, `DELETE .../comments/:commentId`)
- **Notes:** `GET/POST /api/notes`, `GET/PATCH/DELETE /api/notes/:id`, `PUT /api/notes/:id/shares`
- **Calendar:** `GET /api/calendar/events`, `GET /api/calendar/events/:id`, `POST /api/calendar/events`, `PATCH/DELETE /api/calendar/events/:id`
- **Site security (firewall/basic-auth):** `GET/POST /api/sites/:id/security`
- **Status pages:** `GET/POST /api/sites/:id/status-page` (და საჯარო `GET /api/public/status/:token`)

---

## Real-time არხების სია (განსაკუთრებული ყურადღება)

ეს endpoint-ები **SSE** stream-ია (`text/event-stream`, `data: {...}\n\n`) — მოიხმარე `URLSession.bytes` + ხაზობრივი პარსინგით, `Authorization` header-ით:

- Deploy: `GET /api/sites/:id/deploy/stream`
- Provision: `GET /api/sites/:id/provision/stream`
- SSL: `GET /api/sites/:id/ssl/stream`
- Artisan: `GET /api/sites/:id/artisan/stream`
- Live site logs: `GET /api/monitor/logs/:siteId/stream`
- Server prepare: `GET /api/servers/:id/prepare/stream`
- System ops: `GET /api/system/run/:key/stream`

SSE მესიჯის ფორმატი: `{ line: "..." }` ლოგის ხაზისთვის, `{ done: true, status: "success"|"failed"|"..." }` დასრულებისას. დაამუშავე reconnect-ის რეზილიენტურად (buffer replay ხდება).

**WebSocket:** `GET /api/terminal/:siteId?token=<token>` — ინტერაქტიული shell (xterm-ის ეკვივალენტი). ეს ყველაზე რთულია — დატოვე ბოლოსთვის ან ჩასვი `WKWebView`-ში არსებული web ტერმინალი, თუ ნატიური რთულია.

---

## აგების ეტაპები (ასე იმუშავე)

**Phase 0 — საძირკველი**
`APIClient`, Keychain wrapper, PAT-ით ავტორიზაცია, `GET /api/auth/me`-ით ვალიდაცია, ცენტრალური error handling, base მოდელები.

**Phase 1 — Read-only MVP**
Dashboard, Sites სია + დეტალი, Monitoring (system + charts), Uptime, SSL ვადები, Health scores, Notifications. მხოლოდ `GET`-ები. ეს ჯერ სრულად ამუშავე და მაჩვენე.

**Phase 2 — Actions**
Deploy trigger + SSE ლოგი, Rollback, Maintenance toggle, Workers control, Failed jobs retry, Billing (mark paid / void / enforcement), Artisan commands.

**Phase 3 — Config & Files**
.env editor + versioning, Nginx/PHP-FPM config, File Manager, Database backups/restore.

**Phase 4 — დანარჩენი სრულად**
Servers/DigitalOcean control, System ops, AI assistant, Tasks/Notes/Calendar, Telegram, Alerts, Audit log, Status pages, Terminal (WebSocket ან WKWebView).

ყოველი Phase-ის ბოლოს: ააგე პროექტი, გამიშვი, დამიდასტურე რომ compile-დება, და მოკლედ მაჩვენე რა გაკეთდა.

---

## ხარისხის მოთხოვნები

- სუფთა, წაკითხვადი Swift; `async/await`; `@MainActor` UI ViewModel-ებზე.
- ყოველი ქსელის შეცდომა მომხმარებელს ნათლად უნდა უჩვენდე (alert/inline), არა silent fail.
- 401-ზე ავტომატურად გადაიყვანე ავტორიზაციის ეკრანზე.
- Token მხოლოდ Keychain-ში. არასდროს ლოგში/UserDefaults-ში.
- Loading/empty/error state-ები ყველა ეკრანზე.
- სტატუს-ბეჯები ფერადი: active=მწვანე, suspended/critical=წითელი, degraded=ყვითელი. **suspended საიტი არასდროს მწვანედ.**
- ფული ყოველთვის თეთრიდან გადაყვანილი გამოაჩინე (`/100`, ორნიშნა ათწილადი, ვალუტა GEL).

---

## პირველი ნაბიჯი

დაიწყე Phase 0-ით: შექმენი Xcode პროექტის სტრუქტურა, `APIClient`, Keychain wrapper და ავტორიზაციის ეკრანი (PAT-ის ჩასაწერი). დამისვი ნებისმიერი დამაზუსტებელი კითხვა base URL-ზე, endpoint-ის ზუსტ response ფორმატებზე ან პრიორიტეტებზე, სანამ დაიწყებ. თუ რომელიმე endpoint-ის ზუსტი JSON პასუხის ცოდნა გჭირდება, მთხოვე — ვცდი და მოგცემ.
