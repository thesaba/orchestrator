# Orchestrator (Deployer) — სისტემის ანალიზი და გაუმჯობესების რეპორტი

**თარიღი:** 2026-07-03
**მოცვა:** `apps/api` (Fastify + Prisma), `apps/web` (React SPA), `scripts/` (bash provisioning/deploy)
**აქცენტი:** უსაფრთხოება, არქიტექტურა, კოდის ხარისხი, საიმედოობა

---

## შემაჯამებელი (Executive Summary)

Orchestrator არის სერვერის მართვის პანელი (Ploi/Forge-ის ტიპის), რომელიც იმავე host-ზე ასრულებს პრივილეგირებულ ბრძანებებს (`nginx`, `certbot`, `mysql`, `systemctl`, `supervisorctl`, git deploy, root shell). სწორედ ამ ბუნების გამო, **უსაფრთხოების ხარვეზი აქ = სერვერის სრული კომპრომეტაცია**, არა უბრალოდ აპლიკაციის დონის პრობლემა.

კოდი ზოგადად კარგად სტრუქტურირებულია — არის RBAC, audit log, 2FA, JWT, rate-limit login-ზე, path jail file manager-ში, HMAC webhook-ზე. თუმცა რამდენიმე ადგილას შენარჩუნებულია **shell command injection**-ის რეალური ვექტორები და **secret-ების არათანმიმდევრული დამუშავება**. ქვემოთ ჩამონათვალი დალაგებულია პრიორიტეტულობით.

| # | პრობლემა | სიმძიმე | ფაილი |
|---|----------|---------|-------|
| 1 | Command injection `dbPassword`-ით (root-ად) | 🔴 კრიტიკული | `scripts/provision.sh` |
| 2 | Command injection `repoUrl`-ით (`$()` double-quote-ში) | 🔴 კრიტიკული | `apps/api/src/routes/sites.ts` |
| 3 | API/deploy პროცესი root-ად, პრივილეგიების იზოლაციის გარეშე | 🔴 კრიტიკული | არქიტექტურა |
| 4 | Web terminal = root shell ნებისმიერ ავთენტიფიცირებულ user-ს | 🔴 კრიტიკული | `apps/api/src/routes/terminal.ts` |
| 5 | Command injection file manager-ში (`$()` არ ნეიტრალდება) | 🟠 მაღალი | `apps/api/src/routes/filemanager.ts` |
| 6 | Secret-ები plaintext-ად ბაზაში | 🟠 მაღალი | `settings.ts`, `schema.prisma` |
| 7 | JWT localStorage-ში + 7 დღე + revocation არ არის | 🟠 მაღალი | `apps/web` / `auth.ts` |
| 8 | `clone` domain-ს ვალიდაცია არ აქვს | 🟠 მაღალი | `apps/api/src/routes/sites.ts` |
| 9 | Webhook secret = identifier, ჩანს URL/log-ში | 🟡 საშუალო | `webhooks.ts` |
| 10 | pma-internal loopback დაცვა nginx proxy-ს უკან უქმდება | 🟡 საშუალო | `pma-internal.ts` |
| 11 | `cleanup.sh` ტოვებს orphan MySQL user-ს | 🟡 საშუალო | `scripts/cleanup.sh` |
| 12 | Rate-limit მხოლოდ login-ზე (`global: false`) | 🟡 საშუალო | `index.ts` |
| 13+ | სხვა robustness / kod-ხარისხის საკითხები | 🟢 დაბალი | იხ. ქვემოთ |

---

## 🔴 კრიტიკული პრობლემები

### 1. Command Injection `dbPassword`-ის გავლით — root-ის დონეზე

**ფაილი:** `scripts/provision.sh:39-40`

```bash
sudo mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
```

`dbPassword` API-ში ვალიდირდება მხოლოდ სიგრძით (`minLength: 8, maxLength: 128`), **charset-ის შეზღუდვის გარეშე** (`apps/api/src/routes/provision.ts:38`). ის გადაეცემა `provision.sh`-ს **argv-ით** (`spawn('bash', [...])`, shell-ის გარეშე), ამიტომ bash **არ** ასრულებს `$(...)`-ს ცვლადის მნიშვნელობაზე — ე.ი. **ეს არ არის shell RCE**. თუმცა პაროლი ხვდება single-quoted SQL string literal-ში, რომელსაც `mysql` root სესია ასრულებს:

- `dbPassword = "x'; CREATE USER attacker@'%' IDENTIFIED BY 'p'; GRANT ALL ...; -- "` → **SQL injection root MySQL სესიაში** (თვითნებური user/grant შექმნა, `INTO OUTFILE`-ით ფაილის ჩაწერაც კი). ერთადერთი საჭირო სიმბოლო — `'`.

**✅ მოგვარებულია** (commit `4554d08`): `dbPassword`-ს დაემატა pattern `^[^'"\\`]+$` (კრძალავს ქუოთს/ბექსლეშს/ბექთიქს, ე.ი. SQL string-იდან გამოსვლა შეუძლებელია), + `provision.sh`-ში defense-in-depth guard-ები domain/db name/user/password-ზე.

---

### 2. Command Injection `repoUrl`-ის გავლით

**ფაილი:** `apps/api/src/routes/sites.ts:184`

```ts
const { stdout } = await exec(`git ls-remote --heads "${site.repoUrl}" 2>&1`, { timeout: 15_000 })
```

`repoUrl` ინახება `PATCH /:id`-ით მხოლოდ სიგრძის ვალიდაციით (`maxLength: 500`, `deploy.ts:442`), charset/პროტოკოლის შემოწმების გარეშე. double-quote-ის შიგნით `$(...)` სრულდება, ამიტომ `repoUrl = "https://x/$(id > /tmp/x)"` → command injection.

**მოგვარება:**
- `exec` → `execFile('git', ['ls-remote', '--heads', site.repoUrl])` (argv, shell-ის გარეშე).
- `repoUrl`-ს დაუწესე ვალიდაცია: მხოლოდ `https://`/`git@` სქემა, ცნობილი host-ები (ან რეგექსი). იგივე პრინციპი გამოიყენე ყველა `exec("... \"${...}\" ...")` პატერნზე პროექტში.

---

### 3. API/deploy პროცესი მუშაობს root-ად, პრივილეგიების იზოლაციის გარეშე

**წყარო:** `DEPLOY_GUIDE.md` (ცხადად აღწერს), `monitor.ts`/`config.ts`/`ssl.ts` `sudo`-ს გარეშე უშვებენ `systemctl`, `nginx`, `certbot`-ს; `provision.sh`/`scheduler.ts`/`phpfpm.ts` კი `sudo`-ს იყენებენ — **არათანმიმდევრულად**.

ეს ნიშნავს, რომ პანელის ერთი ანგარიშის (ან JWT-ის, ან XSS-ის) კომპრომეტაცია = **მთელი host-ის root წვდომა**. ეს არის სისტემის ცენტრალური რისკი, რომელსაც ყველა დანარჩენი ხარვეზი აძლიერებს.

**მოგვარება (თანდათანობით):**
- API გაუშვი **ცალკე low-privilege user-ით** (მაგ. `orchestrator`), და მიეცი მხოლოდ საჭირო ბრძანებები `sudoers`-ის ვიწრო NOPASSWD წესებით (`/usr/bin/systemctl reload nginx`, `/usr/sbin/nginx -t`, კონკრეტული სკრიპტები და ა.შ.).
- კოდში **გააერთიანე** privileged ბრძანებების გამოძახება ერთ ფენაში (მაგ. `lib/privileged.ts`), სადაც `sudo` პრეფიქსი და allowlist ერთ ადგილას იმართება — ახლა `sudo`-ს გამოყენება routes-ებში მიმოფანტულია.
- დოკუმენტში „უმარტივესი გზა = root" ჩაანაცვლე ამ least-privilege მოდელით.

---

### 4. Web terminal — შეუზღუდავი root shell

**ფაილი:** `apps/api/src/routes/terminal.ts`, `apps/api/src/index.ts:78-82`

Terminal route `node-pty`-ით უშვებს რეალურ `bash`-ს host-ზე (არა site-ში sandboxed), პროცესის **სრული env-ის მემკვიდრეობით** (`env: { ...process.env }` — შეიცავს `JWT_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`, `PMA_BRIDGE_SECRET`). ავთენტიფიკაცია — JWT **query string-ში** (`?token=...`), რომელიც ხვდება nginx access log-ში, browser history-ში, referrer-ში.

კოდი აქ სწორად ამოწმებს per-site access-ს და viewer-ს ბლოკავს, მაგრამ ნებისმიერი `developer`/`admin`, ვისაც ერთი საიტზე მაინც აქვს წვდომა, იღებს **root shell-ს მთელ სერვერზე** (რადგან პროცესი root-ად მუშაობს, პ. 3).

**მოგვარება:**
- shell გაუშვი **site-ის user-ით** (`www-data` ან per-site user) `setuid`/`su -s`-ით, არა root-ად; `cwd` შეზღუდე site root-ით.
- **გაფილტრე env** — გადაეცი მხოლოდ `PATH`, `TERM`, `HOME`, არა მთელი `process.env`.
- JWT გადაიტანე query string-იდან — გამოიყენე ხანმოკლე one-time ticket, რომელსაც terminal handshake-ისას გაცვლი.
- terminal route დააყენე feature-flag-ის უკან (default: off).

---

## 🟠 მაღალი პრიორიტეტი

### 5. Command injection File Manager-ში

**ფაილი:** `apps/api/src/routes/filemanager.ts` (მაგ. `:49, :261, :428, :453`)

`jail()` კარგად იცავს path traversal-ისგან, მაგრამ exec-ის დროს escaping მხოლოდ `"` და `\`-ს ანეიტრალებს:

```ts
`chmod ${mode} "${abs.replace(/["\\]/g,'\\$&')}" 2>&1`
```

double-quote-ის შიგნით `$(...)`/backtick მაინც სრულდება. თუ ფაილის სახელი/target შეიცავს `$( )`-ს (rename/copy-ით attacker-ს შეუძლია შექმნას), ბრძანება ინჟექტდება.

**მოგვარება:** ყველა ეს ოპერაცია Node-ის native API-ით შეასრულე — `fs.chmod`, `fs.rename`, `fs.cp`, `fs.stat` — shell-ის სრული გამორიცხვით. `chown`-ისთვის `fs.chown` (uid/gid რიცხვები) ან `execFile('chown', [...])`.

### 6. Secret-ები plaintext-ად ბაზაში

**ფაილი:** `apps/api/src/routes/settings.ts`, `prisma/schema.prisma`

`mysql_root_password`, `s3_secret_key`, `do_api_token` ინახება `Setting.value`-ში **დაუშიფრავად** (GET-ზე redacted, მაგრამ at-rest plaintext). `SiteDatabase.dbPass`-იც plaintext. ამავე დროს `gitToken` **დაშიფრულია** (`lib/crypto.ts`) — არათანმიმდევრულობა. `do_api_token` განსაკუთრებით მძიმეა: სრული DigitalOcean კონტროლი.

**მოგვარება:** გამოიყენე უკვე არსებული `encryptSecret()`/`decryptSecret()` ყველა secret-ზე ჩაწერისას/წაკითხვისას. SQLite ფაილი (`dev.db`) დაიცავი ფაილურ დონეზეც (600, non-web dir).

### 7. JWT localStorage-ში, 7-დღიანი, revocation-ის გარეშე

**ფაილი:** `apps/web/src/context/AuthContext.tsx:43`, `apps/api/src/routes/auth.ts:51`

- token `localStorage`-ში → ნებისმიერი XSS = token-ის ქურდობა (და პ. 4-ის გამო — root shell).
- `expiresIn: '7d'`, refresh/rotation არ არის.
- პაროლის ცვლილება (`settings.ts change-password`) **არ აუქმებს** არსებულ token-ებს (stateless JWT). logout მხოლოდ ლოკალურად შლის token-ს.

**მოგვარება:** token გადაიტანე `HttpOnly; Secure; SameSite` cookie-ში; შეამცირე expiry (მაგ. 1 სთ) + refresh token; დაამატე `tokenVersion` User-ზე (JWT-ში ჩააშენე, პაროლის ცვლილებაზე გაზარდე → ძველი token-ები invalid). CSP header-ი XSS-ის რისკის შესამცირებლად.

### 8. `clone` endpoint-ს domain-ის ვალიდაცია არ აქვს

**ფაილი:** `apps/api/src/routes/sites.ts:101`

`POST /` domain-ს ამოწმებს pattern-ით, მაგრამ `POST /:id/clone` — მხოლოდ სიგრძით. domain პირდაპირ ხვდება `rootPath: /var/www/sites/${domain}`-ში და შემდგომ ბევრ shell/nginx ოპერაციაში.

**მოგვარება:** გამოიყენე იგივე `pattern` clone-ზეც. საერთოდ — domain ვალიდაცია ერთ ცენტრალურ helper/schema-ში გაიტანე და ყველგან ref-ით მოიხმარე.

---

## 🟡 საშუალო პრიორიტეტი

### 9. Webhook secret = identifier

**ფაილი:** `apps/api/src/routes/webhooks.ts`

`webhookToken` ერთდროულად არის URL-ის იდენტიფიკატორიც (`/github/:token`) და HMAC secret-იც. რადგან იგი URL-ში ჩანს (log/proxy/referrer), მისი გაჟონვა = HMAC-ის გაყალბების შესაძლებლობა.

**მოგვარება:** გამიჯნე — URL-ში საჯარო `siteRef`, HMAC secret ცალკე შენახული (GitHub webhook secret-ის სტანდარტული მოდელი).

### 10. pma-internal loopback დაცვა nginx-ის უკან უქმდება

**ფაილი:** `apps/api/src/routes/pma-internal.ts`, `scripts/nginx-panel.conf`

`location /api/` პროქსირებს ყველა `/api/*`-ს, მათ შორის `/api/internal/pma-consume`-ს. API-ს კი `request.ip` proxy-ს უკან ყოველთვის `127.0.0.1`-ია (`trustProxy` არ არის ჩართული) — ანუ „loopback only" შემოწმება (#1 დაცვა) გარე მოთხოვნებზეც true-ს აბრუნებს. რჩება მხოლოდ shared secret (#2). ე.ი. two-factor → single-factor.

**მოგვარება:** nginx-ში `location /api/internal/ { deny all; }` (ან `internal;`); API-ში პირდაპირ socket-ის შემოწმება, არა `request.ip`.

### 11. `cleanup.sh` ტოვებს orphan MySQL user-ს

**ფაილი:** `scripts/cleanup.sh:46` vs `scripts/provision.sh:39-40`

provision ქმნის user-ს **ორ** grantee-ზე (`@localhost` და `@127.0.0.1`), cleanup კი შლის **მხოლოდ `@localhost`-ს**. `@127.0.0.1` user რჩება (credential-ით) — orphan/security debt.

**მოგვარება:** cleanup-ში ორივე წაშალე: `DROP USER IF EXISTS '${DB_USER}'@'localhost', '${DB_USER}'@'127.0.0.1';`

### 12. Rate-limit მხოლოდ login-ზე

**ფაილი:** `apps/api/src/index.ts:55` (`rateLimit, { global: false }`)

მხოლოდ `/login`-ს აქვს explicit rate-limit. 2FA verify, change-password, deploy trigger და სხვა endpoint-ები brute-force-ისთვის ღიაა.

**მოგვარება:** ჩართე global rate-limit გონივრული ლიმიტით, sensitive endpoint-ებზე უფრო მკაცრი override.

---

## 🟢 დაბალი / robustness / კოდის ხარისხი

- **In-memory state deploy/provision-ისთვის** (`deployProcs`, `emitters`, log buffers) — API restart-ზე იკარგება; უკვე ნაწილობრივ დამუშავებულია `reconcileOrphanedDeployments`-ით, მაგრამ მყიფეა. განიხილე მდგრადი job store.
- **`detached: true` deploy პროცესები** — ghost process-ის რისკი; shutdown handler ცდილობს მოკვლას, მაგრამ race-ის ფანჯარა რჩება.
- **terminal `cwd = rootPath/current`** — თუ დირექტორია არ არსებობს, `node-pty.spawn` შეიძლება ჩავარდეს; დაამატე fallback/existence-check.
- **SSRF**: `deploy_slack_webhook`, `healthCheckUrl` — გამავალი მოთხოვნები user-input URL-ზე; დაუწესე allowlist/scheme შემოწმება.
- **`app.audit()` fire-and-forget** (`.catch(() => {})`) — audit ჩანაწერის დაკარგვა ჩუმად ხდება; privileged action-ებზე მაინც დაალოგე შეცდომა.
- **პაროლის სირთულის პოლიტიკა არ არის** (`minLength: 8` მხოლოდ) — დაამატე მინიმალური complexity/breached-password შემოწმება.
- **`totpSecret` plaintext** ბაზაში — იდეალურად დაშიფრე (იგივე `encryptSecret`).
- **CORS** — `origin` ერთ env value-ზეა; multi-origin-ისთვის დააზუსტე. ამჟამად bearer-token მოდელის გამო რისკი დაბალია.
- **`provision.sh`-ს domain-ის ვალიდაცია არ აქვს** (განსხვავებით `cleanup.sh`/`rename-domain.sh`-ისგან) — defense-in-depth-ისთვის დაამატე იგივე guard.
- **TypeScript `as any` / `req.user as {...}`** მრავალ ადგილას — გამოიყენე გამყარებული ტიპი JWT payload-ისთვის (ერთი `AuthUser` ტიპი).

---

## რეკომენდებული სამოქმედო თანმიმდევრობა

1. **დაუყოვნებლივ (კრიტიკული):** #1 და #2 command injection-ის დახურვა (`execFile`/`mysql2`, input ვალიდაცია) — მინიმალური ცვლილება, მაქსიმალური ეფექტი.
2. **მოკლევადიანი:** #4 terminal-ის env ფილტრი + non-root shell; #6 secret-ების დაშიფვრა; #5 file manager-ის Node native API-ზე გადატანა; #8 clone ვალიდაცია; #11 cleanup fix.
3. **საშუალოვადიანი (არქიტექტურული):** #3 least-privilege მოდელი (dedicated user + ვიწრო sudoers), privileged ბრძანებების ერთ ფენაში გაერთიანება; #7 JWT მოდელის გამკაცრება (cookie + revocation); #10 nginx `/api/internal` დახურვა; #12 global rate-limit.
4. **გაგრძელებით:** robustness/kod-ხარისხის საკითხები.

---

## დადებითი მხარეები (რაც უკვე კარგადაა)

RBAC + per-site access + viewer read-only enforcement; audit log; 2FA (TOTP); login rate-limit; path jail file manager-ში; webhook HMAC timing-safe შედარებით; git token დაშიფრული; deploy-ის zero-downtime symlink swap + health-check auto-rollback; graceful shutdown + orphan reconciliation; SQL allowlist (`db-manage.ts` `validateSql`); მკაფიო inline კომენტარები (განზრახვები კარგად აღწერილია).
