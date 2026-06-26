// One-time migration: secondary databases (SiteDatabase rows with isPrimary
// = false) created before the dbPass fix have a MySQL user with NO password
// at all, and an empty dbPass column. This script gives each of them a real
// generated password, on both the 'localhost' and '127.0.0.1' host grants,
// and saves it to the database.
//
// Safe to re-run — it only touches rows where dbPass is still empty.
//
// Usage (from apps/api):
//   npx tsx scripts/backfill-db-passwords.ts

import { PrismaClient } from '@prisma/client'
import mysql from 'mysql2/promise'
import { randomBytes } from 'crypto'

const prisma = new PrismaClient()

function generatePassword(): string {
  return randomBytes(24).toString('base64').replace(/[/+=]/g, '').slice(0, 28)
}

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

async function main() {
  const rootCreds = await getMysqlRootCreds()

  const targets = await prisma.siteDatabase.findMany({
    where: { isPrimary: false, dbPass: '' }
  })

  if (targets.length === 0) {
    console.log('Nothing to backfill — no secondary databases with an empty password.')
    return
  }

  console.log(`Backfilling passwords for ${targets.length} secondary database(s)...`)

  const conn = await mysql.createConnection({
    host: '127.0.0.1',
    user: rootCreds.user,
    password: rootCreds.pass,
    connectTimeout: 10_000
  })

  try {
    for (const db of targets) {
      const dbPass = generatePassword()
      console.log(`  - ${db.dbName} (user: ${db.dbUser})`)

      // Ensure both host grants exist (older rows may predate the
      // localhost/127.0.0.1 fix too) and set the password on both.
      await conn.execute(`CREATE USER IF NOT EXISTS '${db.dbUser}'@'localhost' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`CREATE USER IF NOT EXISTS '${db.dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`ALTER USER '${db.dbUser}'@'localhost' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`ALTER USER '${db.dbUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass}'`)
      await conn.execute(`GRANT ALL PRIVILEGES ON \`${db.dbName}\`.* TO '${db.dbUser}'@'localhost'`)
      await conn.execute(`GRANT ALL PRIVILEGES ON \`${db.dbName}\`.* TO '${db.dbUser}'@'127.0.0.1'`)

      await prisma.siteDatabase.update({ where: { id: db.id }, data: { dbPass } })
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
