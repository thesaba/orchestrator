// One-time migration: sites provisioned before the Database Manager feature
// existed have a primary database (Site.dbName / Site.dbUser) but no
// corresponding SiteDatabase row. The Database tab and phpMyAdmin SSO both
// list/operate on SiteDatabase rows, so without this row the primary
// database never appears in the UI at all (no Query/Import/phpMyAdmin
// buttons), even though the database itself works fine.
//
// This creates one SiteDatabase row (isPrimary: true, dbPass: '' — primary
// credentials are read from shared/.env at request time, not stored here)
// for every site that has dbName/dbUser set and doesn't already have a
// matching row.
//
// Safe to re-run — skips sites that already have a SiteDatabase row for
// their dbName.
//
// Usage (from apps/api):
//   npx tsx scripts/backfill-primary-db-records.ts

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const sites = await prisma.site.findMany({
    where: { dbName: { not: null }, dbUser: { not: null } }
  })

  if (sites.length === 0) {
    console.log('No sites with a primary database found.')
    return
  }

  console.log(`Checking ${sites.length} site(s) for missing SiteDatabase records...`)

  let created = 0
  let skipped = 0

  for (const site of sites) {
    const dbName = site.dbName!
    const dbUser = site.dbUser!

    const existing = await prisma.siteDatabase.findUnique({ where: { dbName } })
    if (existing) {
      skipped++
      continue
    }

    await prisma.siteDatabase.create({
      data: { siteId: site.id, dbName, dbUser, dbPass: '', isPrimary: true }
    })
    console.log(`  - created record for ${site.domain} (db: ${dbName}, user: ${dbUser})`)
    created++
  }

  console.log(`Done. Created ${created}, skipped ${skipped} (already had a record).`)
}

main()
  .catch((err) => {
    console.error('Backfill failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
