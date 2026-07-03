# Remediation Status — Orchestrator უსაფრთხოების გასწორებები

**თარიღი:** 2026-07-03 · **ბაზა:** `ANALYSIS_REPORT.md`

ყველა ცვლილება ცალკე commit-ადაა, პრიორიტეტულობის მიხედვით. TypeScript-ის ტიპური შემოწმება ყოველ ცვლილებაზე გაშვებული — ახალი შეცდომა არ დამატებულა (არსებული 55 შეცდომა Prisma client-ის მოძველების noise-ია, რომელიც `prisma generate`-ზე ქრება).

## გასწორებული (კოდში)

| # | პრობლემა | სტატუსი | Commit |
|---|----------|---------|--------|
| 2 | `repoUrl` shell RCE (`git ls-remote`) | ✅ execFile (argv) + URL ვალიდაცია | `0fce11c` |
| — | `cleanup.sh` გამოძახება shell-ით (sites.ts) | ✅ execFile (argv) | `0fce11c` |
| 1 | `dbPassword` SQL injection (root MySQL) | ✅ charset pattern + script guard | `4554d08` |
| 4 | Web terminal secret-ების გაჟონვა env-ით | ✅ env allowlist + cwd fallback | `0384064` |
| 5 | File manager shell RCE (chmod/chown/mv/cp/zip/tar/grep/find/diff/du) | ✅ execFile / native `fs` | `67864d6` |
| 6 | Secret-ები plaintext-ად ბაზაში | ✅ AES-256-GCM at rest + plaintext fallback | `98122d9` |
| 8 | `clone` domain ვალიდაცია | ✅ hostname pattern | `22ca762` |
| 11 | `cleanup.sh` orphan MySQL user | ✅ ორივე grantee იშლება + guards | `f2f32e1` |
| 12 | Rate-limit მხოლოდ login-ზე | ✅ global backstop (600/min) | `f2a0770` |
| — | არასწორი client IP nginx-ის უკან | ✅ `trustProxy: 'loopback'` | `f2a0770` |
| 7 | JWT 7-დღიანი lifetime | ✅ 24h (კონფიგურირებადი) | `f2a0770` |
| 10 | `pma-consume` loopback დაცვა proxy-ს უკან იშლება | ✅ nginx 404 + socket-peer check | `fb1879f` |

### გასწორების პრინციპები
- **shell injection**: ყველა user/DB-წარმოშობის მნიშვნელობა shell-ს აღარ ხვდება string-interpolation-ით — გამოიყენება `execFile` (argv, shell-ის გარეშე, `lib/exec.ts`) ან native `fs`. სადაც shell რჩება (`systemctl`, `certbot`, `supervisorctl`, `nginx`), input-ი მკაცრადაა ვალიდირებული (domain pattern, `phpVersion ^\d+\.\d+$`, action enum-ები) ან სერვერ-წარმოშობისაა.
- **secret-ები**: `readSecret()`/`writeSecret()` (`lib/crypto.ts`) — ახალი ჩანაწერები იშიფრება, ძველი plaintext ჩანაწერები კითხვისას გამჭვირვალედ მუშაობს და შემდეგ ჩაწერაზე იშიფრება. **key rotation-ის რისკი არ არის** — არაფერი ტყდება.
- **verification**: `tsc --noEmit` diff baseline-თან + `bash -n` სკრიპტებზე + guard-ების ფუნქციური ტესტი.

## შეგნებულად გადადებული follow-up-ები (არქიტექტურული — deploy/schema ცვლილება სჭირდება)

ეს პუნქტები **განზრახ** არ გაკეთდა კოდში, რადგან runtime/deploy-დონის ცვლილებას ან DB მიგრაციას მოითხოვს (რომელიც ამ გარემოში ვერ ვალიდირდება). თითოეული აღწერილია რომ უსაფრთხოდ განხორციელდეს:

1. **#3 Least-privilege runtime (root → dedicated user).** API/deploy პროცესი აღარ უნდა მუშაობდეს root-ად. ნაბიჯები: შექმენი `orchestrator` user; `systemd` unit-ში `User=orchestrator`; ვიწრო `sudoers` NOPASSWD წესები მხოლოდ საჭირო ბრძანებებზე (`/usr/sbin/nginx -t`, `systemctl reload nginx`, კონკრეტული სკრიპტები). კოდში privileged გამოძახებები უკვე ერთ ფენაშია მიმართული (`lib/exec.ts`) — მომავალში იქ ჩაამატე `sudo` პრეფიქსი allowlist-ით. **ეს რჩება #1 არქიტექტურულ რისკად.**

2. **#7 Token revocation + HttpOnly cookie.** ამჟამად: lifetime 24h-მდე შემცირდა (მიღწეული). შემდეგი: (a) `User.tokenVersion` სვეტი (მიგრაცია) — JWT-ში ჩააშენე, პაროლის ცვლილებაზე გაზარდე → ძველი token-ები მყისვე invalid; (b) token გადაიტანე `HttpOnly; Secure; SameSite=Strict` cookie-ში + refresh-token, localStorage-იდან (XSS-ით ქურდობის რისკის მოსახსნელად). ორივე cross-cutting ცვლილებაა (ყველა fetch/SSE/WS) — ცალკე ბრენჩში, ტესტებით.

3. **#9 Webhook secret ≠ identifier.** ამჟამად `webhookToken` ერთდროულად URL-იდენტიფიკატორიცაა და HMAC secret-იც. საჭიროა schema ცვლილება: ცალკე საჯარო `webhookRef` (URL-ში) და ცალკე `webhookSecret` (HMAC-ისთვის, UI-ში ნაჩვენები GitHub webhook secret-ად). მოითხოვს frontend + GitHub-ის ხელახალ კონფიგურაციას, ამიტომ არსებული webhook-ების გატეხვის თავიდან ასაცილებლად ცალკე migration-ია.

4. **DB provisioning სრულად `mysql2`-ზე.** `provision.sh`-ის MySQL ნაწილი (ახლა guard-ებით დაცული) იდეალურად Node-ში `mysql2`-ით უნდა შესრულდეს (როგორც `db-manage.ts` `withRootConn`), shell/SQL-string interpolation-ის სრული გამორიცხვით. მოითხოვს API-სთვის MySQL root creds-ის კონფიგურაციას provisioning-ის დროსაც.

5. **SSRF allowlist** `deploy_slack_webhook` / `healthCheckUrl`-ზე (დაბალი პრიორიტეტი).

## Deploy-ის შემდგომი ნაბიჯები

- `pnpm --filter api build` (ან `tsc`) — Prisma client დაგენერირდება, baseline noise გაქრება.
- `prisma generate` სავალდებულოა (ამ გარემოში ქსელის შეზღუდვის გამო ვერ გაეშვა).
- nginx: ხელახლა ჩატვირთე კონფიგი (`nginx -t && systemctl reload nginx`) `/api/internal/` ბლოკის ასამოქმედებლად.
- არსებული secret-ები ბაზაში plaintext-ად რჩება სანამ Settings-ში ხელახლა არ შეინახავ (readSecret backward-compatible-ია) — რეკომენდებულია ერთხელ გადაინახო mysql root / S3 / DO secret-ები, რომ დაიშიფროს.
