# Orchestrator — დეპლოის სრული ინსტრუქცია DigitalOcean Droplet-ზე

## 1. პროექტის ანალიზი

ეს არ არის უბრალო ვებ-აპლიკაცია — ეს არის **სერვერის მართვის პანელი** (Ploi / RunCloud / Laravel Forge-ის ტიპის self-hosted ალტერნატივა). იდეა ისაა, რომ ეს პროექტი თავადვე იყენებს დროპლეტს, რომელზეც დაინსტალირდება, რათა მართოს იმავე სერვერზე განთავსებული **სხვა** PHP/Laravel საიტები (provisioning, deploy, SSL, supervisor, ბექაფები და ა.შ.).

**არქიტექტურა (pnpm monorepo):**

- `apps/api` — Node.js + Fastify backend. Prisma ORM + SQLite ბაზა (`dev.db`). JWT ავთენტიფიკაცია, rate-limit, audit log. პორტი: `3001`, ბმული მხოლოდ `127.0.0.1`-ზე (გარედან არ ჩანს, Nginx აპროქსირებს).
- `apps/web` — React + Vite + Shopify Polaris SPA (admin dashboard). იბილდება სტატიკურ ფაილებად და მას ემსახურება Nginx.
- `scripts/` — bash სკრიპტები, რომლებსაც API პროცესი უშვებს სერვერზე:
  - `provision.sh` — ქმნის საიტის დირექტორიას, MySQL ბაზას/იუზერს, Nginx vhost-ს.
  - `deploy.sh` — zero-downtime გადატანა git repo-დან (clone → composer install → artisan cache/migrate → symlink swap).
  - `ssl.sh` — Let's Encrypt სერტიფიკატი `certbot`-ით.
  - `cleanup.sh` — საიტის სრული წაშლა.
  - `backup.sh` — MySQL dump-ების cron ბექაფი.
  - `orchestrator-api.service` / `nginx-panel.conf` — მზა systemd/Nginx კონფიგების შაბლონები.

**მნიშვნელოვანი ტექნიკური დეტალი:** API-ის routes (`monitor.ts`, `supervisor.ts`, `ssl.ts`, `config.ts`, `sites.ts`) პირდაპირ უშვებენ `systemctl`, `nginx`, `certbot`, `supervisorctl`, `mysql` ბრძანებებს **`sudo`-ს გარეშე**. ეს ნიშნავს, რომ ის ლინუქს-იუზერი, ვისი სახელითაც მუშაობს `orchestrator-api` სერვისი, საჭიროებს ამ ბრძანებების პირდაპირ შესრულების უფლებას. ამიტომ პრაქტიკაში გასცემს ორი გზიდან ერთს:
1. **სერვისი გაშვებულია root-ით** (უმარტივესი, ისეთივე მოდელით მუშაობს Forge/Ploi-ის ლოკალური აგენტებიც) — ქვემოთ ამ ვარიანტს ვირჩევ.
2. ან თითო ბრძანებაზე sudoers/polkit წვრილმანი წესების აწერა — გაცილებით მეტი სამუშაო და მაინც მოითხოვს კოდის შეცვლას (რადგან კოდში `sudo` პრეფიქსი არსად ჩაწერილია).

**Stack-ის შემაჯამება:** Ubuntu/Debian-ზე ორიენტირებული (`apt`, `www-data`, `/etc/nginx`, `systemctl`), Node.js (Fastify/Prisma/tsx/TypeScript), PHP-FPM (8.2 default, მაგრამ `phpVersion` ველი თითო საიტზე ცვლადია → საჭიროა რამდენიმე PHP ვერსია), MySQL, Composer, Nginx, Certbot, Supervisor, Git.

---

## 2. რომელი ოპერაციული სისტემა / Droplet

**რჩევა: Ubuntu 24.04 LTS (ან 22.04 LTS, თუ გინდა მეტი გამოცდილი `ondrej/php` PPA თავსებადობა).**

რატომ:
- ყველა სკრიპტი (`systemctl`, `apt`, `www-data`, `/etc/nginx/sites-available`) Debian-ის ოჯახისთვისაა დაწერილი — CentOS/Fedora/Rocky-ზე გადატანა მოითხოვდა სკრიპტების გადაწერას.
- LTS ვერსია = 5 წლის უსაფრთხოების მხარდაჭერა.
- `ondrej/php` PPA-ს მეშვეობით ერთდროულად რამდენიმე PHP ვერსიის (8.1, 8.2, 8.3...) დაყენება მარტივია — საჭირო ხდება, რადგან Orchestrator თითო საიტს ცალკე PHP ვერსიის მინიჭებას უშვებს.

**Droplet ზომა:**
- მინიმუმი: **2 GB RAM / 2 vCPU** (Basic Premium AMD ან Regular) — თუ Orchestrator მართავს მხოლოდ 1-2 პატარა საიტს.
- რეკომენდებული საწყისი: **4 GB RAM / 2 vCPU** — თუ აპირებ რამდენიმე Laravel საიტის + queue worker-ების (Supervisor) გაშვებას იმავე სერვერზე. MySQL + PHP-FPM + Node.js + Nginx ერთად საკმაო RAM-ს მოითხოვს.
- დისკი: 50GB+ NVMe SSD (ბექაფები სათითაოდ ერთვება).
- რეგიონი: აარჩიე შენი მომხმარებლების ყველაზე ახლო DigitalOcean datacenter.

---

## 3. ნაბიჯ-ნაბიჯ დეპლოი

### ნაბიჯი 0 — წინაპირობები
- შენი დომენი (მაგ. `deploy.yourdomain.com`) მიმართული უნდა იყოს droplet-ის public IP-ზე (A record), სანამ SSL-ს გასცემ.
- გექნება SSH წვდომა root-ით ახალ droplet-ზე.

### ნაბიჯი 1 — საბაზისო სერვერის უსაფრთხოება

```bash
ssh root@YOUR_DROPLET_IP

apt update && apt upgrade -y

# ახალი sudo-იუზერი (root-ით პირდაპირ მუშაობა არასწორი პრაქტიკაა)
adduser deployer
usermod -aG sudo deployer

# firewall
apt install -y ufw
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw enable

# fail2ban — brute-force დაცვა SSH-ზე
apt install -y fail2ban
systemctl enable --now fail2ban
```

რეკომენდებულია root login-ის და password auth-ის გათხოვა SSH-ში (`/etc/ssh/sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`) SSH key-ით შესვლის შემდეგ.

შემდეგი ნაბიჯებიდან გააგრძელე `deployer` იუზერით:
```bash
su - deployer
```

### ნაბიჯი 2 — Node.js + pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v20.x

sudo npm install -g pnpm
pnpm -v
```

### ნაბიჯი 3 — Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

### ნაბიჯი 4 — MySQL

```bash
sudo apt install -y mysql-server
sudo mysql_secure_installation
```
დაყენებისას აარჩიე ძლიერი root პაროლი და დათანხმდი default-ებზე (remove anonymous users, disallow remote root და ა.შ).

### ნაბიჯი 5 — PHP (რამდენიმე ვერსია) + Composer

```bash
sudo apt install -y software-properties-common
sudo add-apt-repository -y ppa:ondrej/php
sudo apt update

# დაყენე ის ვერსიები, რომლებიც გჭირდება (8.2 default Orchestrator-ში)
sudo apt install -y php8.2 php8.2-fpm php8.2-mysql php8.2-cli php8.2-curl \
  php8.2-mbstring php8.2-xml php8.2-zip php8.2-gd php8.2-bcmath

sudo systemctl enable --now php8.2-fpm

# Composer
curl -sS https://getcomposer.org/installer | php
sudo mv composer.phar /usr/local/bin/composer
composer --version
```
თუ მომავალში დაგჭირდება სხვა PHP ვერსიაც (8.1, 8.3) — გაიმეორე იგივე `apt install php8.X-fpm ...` სტრიქონი.

### ნაბიჯი 6 — Certbot, Supervisor, Git, Redis

```bash
sudo apt install -y certbot python3-certbot-nginx supervisor git unzip redis-server

sudo systemctl enable --now supervisor
sudo systemctl enable --now redis-server
```

**Redis საჭიროა**, თუმცა ეს არც ერთ წინა ნაბიჯში არ იყო ნახსენები — პანელი თვითონ მონიტორავს `redis-server` სერვისს (Monitoring ტაბი) და ყველა ახალი საიტისთვის, რომელსაც პროვიჟენირებ, ნაგულისხმევად წერს `CACHE_DRIVER=redis`, `QUEUE_CONNECTION=redis`, `SESSION_DRIVER=redis` (`REDIS_HOST=127.0.0.1`, `REDIS_PORT=6379`, პაროლის გარეშე). Ubuntu-ს default Redis კონფიგი ამ მნიშვნელობებს ემთხვევა, დამატებითი კონფიგი არ გჭირდება ერთ-დროპლეტიან სეტაპისთვის.

### ნაბიჯი 7 — პროექტის კლონირება

```bash
sudo mkdir -p /opt/orchestrator
sudo chown deployer:deployer /opt/orchestrator
git clone <შენი-repo-URL> /opt/orchestrator
cd /opt/orchestrator
```

(თუ repo private-ია, წინასწარ დააგენერირე deploy key ან გადმოწერე ფაილები `scp`/`rsync`-ით.)

### ნაბიჯი 8 — დამოკიდებულებების დაყენება და build

```bash
cd /opt/orchestrator
pnpm install

# API build
cd apps/api
cp .env.example .env
nano .env
```

`apps/api/.env`-ში შეასწორე:
```
DATABASE_URL="file:./prod.db"
JWT_SECRET="<გენერირებული 32+ სიმბოლოიანი random string>"
PORT=3001
CORS_ORIGIN="https://deploy.yourdomain.com"
SCRIPTS_DIR="/opt/orchestrator/scripts"
```
`JWT_SECRET` შეგიძლია გენერირება:
```bash
openssl rand -base64 32
```

შემდეგ:
```bash
# ბაზის სქემის შექმნა + ცარიელი admin იუზერის seed
pnpm prisma generate --schema=prisma/schema.prisma
pnpm db:push
pnpm db:seed   # ⚠ ტერმინალში დაბეჭდილ admin@localhost პაროლს აუცილებლად შეინახე

# API-ის build (TypeScript → dist/)
pnpm build
```

```bash
# Web (React SPA) build
cd /opt/orchestrator/apps/web
pnpm build   # → dist/ ქმნის სტატიკურ ფაილებს
```

### ნაბიჯი 9 — systemd სერვისი API-სთვის

```bash
sudo cp /opt/orchestrator/scripts/orchestrator-api.service /etc/systemd/system/
sudo nano /etc/systemd/system/orchestrator-api.service
```

**მნიშვნელოვანი შესწორება:** ვინაიდან API პროცესი პირდაპირ უშვებს `systemctl`, `nginx -t`, `certbot`, `supervisorctl`, `mysql` ბრძანებებს `sudo`-ს გარეშე (იხ. ანალიზი ზემოთ), `User=deployer`/`Group=deployer` ხაზები შეცვალე `root`-ით:
```
User=root
Group=root
```
წინააღმდეგ შემთხვევაში provisioning/SSL/deploy/supervisor ფუნქციები წყდებიან permission-denied შეცდომებით.

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now orchestrator-api
sudo systemctl status orchestrator-api
journalctl -u orchestrator-api -f   # ლოგების ნახვა
```

### ნაბიჯი 10 — Nginx კონფიგი პანელისთვის

```bash
sudo cp /opt/orchestrator/scripts/nginx-panel.conf /etc/nginx/sites-available/orchestrator
sudo sed -i 's/PANEL_DOMAIN/deploy.yourdomain.com/' /etc/nginx/sites-available/orchestrator
sudo ln -sf /etc/nginx/sites-available/orchestrator /etc/nginx/sites-enabled/orchestrator

sudo nginx -t
sudo systemctl reload nginx
```

### ნაბიჯი 11 — SSL სერტიფიკატი

```bash
sudo certbot --nginx --agree-tos -m you@yourdomain.com -d deploy.yourdomain.com
```
Certbot ავტომატურად დააკონფიგურირებს HTTPS-ს და redirect-ს. განახლება ავტომატური cron/systemd timer-ით ხდება (`certbot.timer`), დამატებითი ქმედება არ გჭირდება.

### ნაბიჯი 12 — sudoers (deploy/provision სკრიპტებისთვის)

თუ ნაბიჯ 9-ში API root-ით გაშვი, ეს ნაბიჯი არ გჭირდება — root-ს ნებისმიერი ბრძანების უფლება აქვს.

თუ უსაფრთხოების მიზნით უპირატესობას non-root მოდელს ანიჭებ, საჭირო გახდება:
- API სერვისის `ExecStart`-ის შეცვლა, რომ ყველა `exec()`/`spawn()` ბრძანებას `sudo` პრეფიქსი ჰქონდეს (კოდის ცვლილებაა, არსებულ კოდში არაა) **ან**
- `deployer` იუზერისთვის precise `NOPASSWD` sudoers წესების და polkit წესების აწერა `systemctl`, `nginx`, `certbot`, `supervisorctl`, `mysql` ბრძანებებზე.

ეს ბევრად რთული და მტყუვნებისადმი მიდრეკილია — production-ისთვის root-ით გაშვება (ნაბიჯი 9) გაცილებით სტაბილურია, თუმცა გაითვალისწინე, რომ ეს ნიშნავს, რომ ნებისმიერ ვინც API-ში შეაღწევს, root წვდომას იღებს.

### ნაბიჯი 13 — შემოწმება

1. გახსენი `https://deploy.yourdomain.com` ბრაუზერში.
2. შედი ნაბიჯ 8-ში დაბეჭდილი `admin@localhost` და დროებითი პაროლით.
3. **დაუყოვნებლივ შეცვალე პაროლი** (თუ პანელში ეს ფუნქცია არსებობს) ან Settings-დან გაანახლე.
4. შემოწმდი `/api/health` ენდფოინთი პასუხს იცემა: `https://deploy.yourdomain.com/api/health`.

---

## 3.1 ცნობილი პრობლემა — `apps/web` build ჩავარდა TypeScript შეცდომებზე

`pnpm build` (web) ჩავარდება ორ pre-existing ბაგზე, რომლებიც კოდშივე იყო (არა droplet-ის კონფიგურაციის პრობლემა):
- `LoginPage.tsx` — `TextField`-ს არ აქვს `onKeyDown` prop ამ Polaris ვერსიაში.
- `SiteDetailPage.tsx` — `Modal`-ს არ აქვს `large` prop, საჭიროა `size="large"`.

ეს გასწორებულია წყაროში (`onKeyDown` გადატანილია გარშემორტყმულ `<div>`-ზე, `large` → `size="large"`). გასწორება შენახულია ლოკალურ repo-ში — **commit + push გააკეთე შენი მანქანიდან**, შემდეგ დროპლეტზე:
```bash
cd /opt/orchestrator
git pull
cd apps/web && pnpm build
```

## 3.2 ცნობილი პრობლემა — Bad Request / FST_ERR_CTP_EMPTY_JSON_BODY

ღილაკები, რომლებიც body-ის გარეშე POST-ს გზავნიან (`Deploy Now`, SSL issue/renew, DB backup და სხვ.), 500/400 ერორზე გადიოდა, რადგან frontend ყოველთვის აყენებდა `Content-Type: application/json` header-ს, ცარიელი body-თიც. გასწორებულია `apps/web/src/api/client.ts`-ში — header მხოლოდ მაშინ ემატება, როცა body რეალურად არსებობს. `git pull` + `pnpm build` (web) დროპლეტზე საკმარისია.

## 3.3 Private რეპოზიტორიების მხარდაჭერა (Git Access Token)

თავიდან საერთოდ არ არსებობდა მექანიზმი private repo-ების კლონირებისთვის — `deploy.sh` უბრალოდ `git clone`-ს უშვებდა raw URL-ზე, რაც მუშაობდა მხოლოდ public repo-ებზე.

**დამატებულია:**
- `Site` მოდელს დაემატა დაშიფრული `gitToken` ველი (`apps/api/prisma/schema.prisma`) — AES-256-GCM, გასაღები `ENCRYPTION_KEY`-დან (ან `JWT_SECRET`-დან, თუ პირველი არ არის დაყენებული).
- Deploy Settings ტაბში გაჩნდა ველი **"Git Access Token (for private repos)"** — write-only, შენახვის შემდეგ არასოდეს ჩვენდება ისევ, მხოლოდ "Token saved" ბეჯი.
- Deploy-ის დროს ტოკენი ჩაშენდება HTTPS clone URL-ში (`https://<token>@github.com/...`), გადაეცემა `deploy.sh`-ს environment-ით (არა argv-ით, რომ `ps`-ში არ გამოჩნდეს), და დეპლოის ლოგიდან მასკირებულია.

**საჭირო ნაბიჯები დროპლეტზე ამის ამოქმედებლად:**
```bash
cd /opt/orchestrator
git pull

# ახალი env ცვლადი (არ არის სავალდებულო, JWT_SECRET-ზე fallback-ი იმუშავებს,
# მაგრამ რეკომენდებულია ცალკე გასაღების დაყენება)
echo 'ENCRYPTION_KEY="'$(openssl rand -hex 32)'"' | sudo tee -a apps/api/.env

cd apps/api && pnpm db:push   # ამატებს gitToken column-ს SQLite ბაზაში
pnpm build
cd ../web && pnpm build
sudo systemctl restart orchestrator-api
```

**გამოყენება:** საიტის გვერდზე → Deploy Settings → ჩაწერე GitHub/GitLab Personal Access Token (repo scope) → Save settings. Public repo-ებზე ეს ველი ცარიელი დაგრჩება — არაფერი იცვლება მათთვის.

## 3.4 ცნობილი პრობლემა — Deploy failed: shared/.env is empty or missing

ეს არ არის ბაგი — `provision.sh` მხოლოდ ცარიელ `shared/.env` ფაილს ქმნის (`touch`), განზრახ, რადგან ბაზის პაროლი/`APP_KEY` და სხვა საიტ-სპეციფიკური მნიშვნელობები წინასწარ უცნობია. **პირველი დეპლოის წინ** აუცილებლად შეავსე:

1. გადადი საიტის გვერდზე → **Config** ტაბი → **`.env`** ფაილის editor.
2. ჩაამატე მინიმუმ: `APP_KEY` (გენერირება: `php8.2 artisan key:generate --show` ლოკალურად ან სერვერზე), `DB_DATABASE`/`DB_USERNAME`/`DB_PASSWORD` (provision-ის დროს შექმნილი მნიშვნელობები — ჩანს საიტის Database ტაბში), `APP_URL`, `APP_ENV=production`.
3. შეინახე და მხოლოდ მერე დააჭირე **Deploy Now**.

## 4. შემდგომი მოვლა

- **განახლება:** `cd /opt/orchestrator && git pull && pnpm install && pnpm build` (api-სა და web-ისთვის ცალ-ცალკე), შემდეგ `sudo systemctl restart orchestrator-api`.
- **ლოგები:** `journalctl -u orchestrator-api -f`.
- **ბექაფი:** `scripts/backup.sh` ცალკეული საიტებისთვისაა (cron-ით პანელი თვითონ აყენებს); თვითონ Orchestrator-ის SQLite ბაზის (`apps/api/prod.db`) ბექაფიც ღირს ცალკე cron-ით (`cp` + `gzip` შესაბამის ბექაფ-დირექტორიაში).
- **firewall:** `3001` პორტი არასოდეს გახსნი გარედან — API მხოლოდ `127.0.0.1`-ზე უსმენს და Nginx აპროქსირებს, ეს უკვე უსაფრთხო კონფიგია.

## 5. ვერსია 2.0 — ახალი ფუნქციების დეპლოი (2FA, uptime monitoring, web terminal, PHP-FPM/cron editor, S3 ბექაფი და სხვ.)

ეს ცვლილებები 22 commit-ად ჩავარდა `main`-ში. დროპლეტზე გადატანამდე გაითვალისწინე:

### 5.1 სისტემური დამოკიდებულებები
`node-pty` (web terminal-ისთვის) native-ად ბილდდება ინსტალაციის დროს — სჭირდება C/C++ toolchain:
```bash
sudo apt update && sudo apt install -y build-essential python3
```
დარწმუნდი, რომ `git`-ი და `composer`-ი PATH-ზეა იმ იუზერისთვის, ვისი სახელითაც მუშაობს `orchestrator-api` (ეს უკვე საჭირო იყო, ახლა მეტი route ეყრდნობა მათ — composer.ts, sites.ts-ის branch listing).

### 5.2 დეპლოი
```bash
cd /opt/orchestrator
git pull
cd apps/api && pnpm install && pnpm db:push   # ახალი Prisma ველები (2FA, uptime, tags...)
pnpm build
cd ../web && pnpm install && pnpm build
```

### 5.3 sudoers — PHP-FPM editor და Scheduler/cron route-ებისთვის
ეს ორი ფუნქცია წერს `/etc/php/*/fpm/pool.d/*.conf`-ში და `/etc/cron.d/*`-ში და უშვებს `systemctl reload php*-fpm`-ს — კოდი ამას აკეთებს `sudo`-ს მეშვეობით ვიწროდ განსაზღვრული ბრძანებებით (არ მოითხოვს root-ით მთლიანი სერვისის გაშვებას). თუ `orchestrator-api` `deployer` იუზერით მუშაობს (`scripts/orchestrator-api.service`-ის მიხედვით), დააყენე:

```bash
sudo visudo -f /etc/sudoers.d/deployer-fpm
```
და ჩასვი (ჩაანაცვლე `deployer` რეალური იუზერით, თუ სხვაა):
```
deployer ALL=(root) NOPASSWD: /usr/bin/install -m 0644 /tmp/fpm-pool-*.conf /etc/php/*/fpm/pool.d/*.conf
deployer ALL=(root) NOPASSWD: /usr/sbin/php-fpm[0-9].[0-9] -t
deployer ALL=(root) NOPASSWD: /usr/bin/systemctl reload php[0-9].[0-9]-fpm
deployer ALL=(root) NOPASSWD: /usr/bin/install -m 0644 /tmp/cron-* /etc/cron.d/*
deployer ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/cron.d/*
```
შემდეგ `sudo visudo -c` შეამოწმე სინტაქსი. (თუ სერვისი უკვე root-ით მუშაობს — ეს ნაბიჯი არ გჭირდება, `sudo` root-იდან root-ზე ყოველთვის გაივლის.)

### 5.4 Web Terminal — გამორთულია default-ად
`terminal.ts` route ანიჭებს ნამდვილ, შეუზღუდავ `bash` shell-ს სერვერზე ნებისმიერ ავტორიზებულ პანელის მომხმარებელს (API პროცესის სრული environment-ით — DB credentials, JWT_SECRET, ENCRYPTION_KEY ჩათვლით). ამიტომ ეს route გამორთულია, სანამ აშკარად არ ჩართავ:
```bash
# apps/api/.env
ENABLE_TERMINAL=true
```
თითო connect/disconnect ლოგირდება audit log-ში (`terminal.connect` / `terminal.disconnect`), მაგრამ ეს მაინც ექვივალენტურია root SSH წვდომის გაცემის — ჩართე მხოლოდ თუ ნამდვილად გჭირდება და ენდობი ყველა პანელის მომხმარებელს.

### 5.5 S3/R2 ბექაფი
არ მოითხოვს `.env`-ში ცვლადებს — ყველაფერი (`access key`, `secret`, `region`, `bucket`, `endpoint`) ივსება პანელის Settings-ის UI-დან, DB-ში ინახება (`secret`-ი დაფარულია `••••••••`-ით GET-ზე). დარწმუნდი outbound HTTPS ღია გაქვს firewall-ში S3/R2 endpoint-ისთვის.

### 5.6 სხვა შეახსენებები
- Uptime monitor მონიტორავს მხოლოდ plain HTTP-ზე (port 80) — თუ საიტს მხოლოდ HTTPS აქვს ან HTTP→HTTPS redirect-ი, შესაძლოა ცდომილებით "down" დაფიქსირდეს.
- Deploy queue ინ-memory-შია — API restart-ი queued deploy-ს ჩუმად ჩაგდებს.
- `pnpm install`-ის შემდეგ გადაამოწმე `pnpm build` ორივე app-ზე წარმატებით ჩაირთვის (`tsc --noEmit` ლოკალურად უკვე გადამოწმდა, ცარიელი output).
- სერვისის გადატვირთვის შემდეგ ლოგებში დაადასტურე: `journalctl -u orchestrator-api -f` — `ENABLE_TERMINAL`-ის გარეშე route არც დარეგისტრირდება, warning ჩანდება მხოლოდ თუ ჩართეთ.
