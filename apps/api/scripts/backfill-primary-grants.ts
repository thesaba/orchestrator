// One-time migration: primary databases provisioned before the
// localhost/127.0.0.1 grant fix only have a 'localhost' MySQL grant, which
// doesn't cover the panel's TCP connections to 127.0.0.1 (Query Runner,
// import, and any future phpMyAdmin SSO). This adds the missing
// '127.0.0.1' user + grant for every existing site, reusing the password
// already stored in that site's shared/.env (no password change).
//
// Safe to re-run — CREATE USER IF NOT EXISTS / GRANT are idempotent.
//
// Usage (from apps/api):
//   npx ts-node scripts/backfill-primary-grants.ts

import { PrismaClient } from '@prisma/client'
import mysql from 'mysql2/promise'
import { promises as fs } from 'fs'
import path from 'path'

const prisma = new PrismaClient()

async function getMysqlRootCreds(): Promise<{ user: string; pass: string }> {
  const [userRow, passRow] = await Promise.all([
    prisma.setting.findUnique({ where: { key: 'mysql_root_user' } }),
    prisma.setting.findUnique({ where: { key: 'mysql_root_password' } })
  ])
  if (!userRow?.value) {
    throw new Error('mysql_root_user is not set in Settings — cannot proceed.')
  }
  return { user: userRow.value, pass: passRow?.value ?? '' }
}

async function readEnvPassword(rootPath: string): Promise<string | null> {
  try {
    const content = await fs.readFile(path.join(rootPath, 'shared', '.env'), 'utf-8')
    const m = content.match(/^DB_PASSWORD=(.*)$/m)
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null
  } catch {
    return null
  }
}

async function main() {
  const rootCreds = await getMysqlRootCreds()

  const sites = await prisma.site.findMany({
    where: { dbUser: { not: null }, dbName: { not: null } }
  })

  if (sites.length === 0) {
    console.log('No sites with a primary database found.')
    return
  }

  console.log(`Checking ${sites.length} site(s) for missing '127.0.0.1' grants...`)

  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: rootCreds.user,
    password: rootCreds.pass,
    connectTimeout: 10_000
  })

  try {
    for (const site of sites) {
      const dbPass = await readEnvPassword(site.rootPath)
      if (!dbPass) {
        console.warn(`  - SKIP ${site.domain}: could not read DB_PASSWORD from ${site.rootPath}/shared/.env`)
        continue
      }
      console.log(`  - ${site.domain} (db: ${site.dbName}, user: ${site.dbUser})`)
      await conn.execute(`CREATE USER IF NOT EXISTS '${site.dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`ALTER USER '${site.dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`GRANT ALL PRIVILEGES ON \`${site.dbName}\`.* TO '${site.dbUser}'@'127.0.0.1'`)
    }
    await conn.execute('FLUSH PRIVILEGES')
    console.log('Done.')
  } finally {
    await conn.end().catch(() => {})
  }
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
