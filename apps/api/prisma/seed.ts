import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const prisma = new PrismaClient()

const DEFAULT_SETTINGS: Record<string, string> = {
  panel_title:    'Orchestrator',
  panel_url:      'http://localhost:3001',
  notify_email:   '',
  deploy_slack_webhook: ''
}

async function main() {
  // Admin user — generate a random password on first seed; existing password is never overwritten
  const plainPassword = crypto.randomBytes(12).toString('base64url')
  const hashed = await bcrypt.hash(plainPassword, 12)

  const existing = await prisma.user.findUnique({ where: { email: 'admin@localhost' } })
  const user = await prisma.user.upsert({
    where:  { email: 'admin@localhost' },
    update: {},                          // never overwrite existing password
    create: { email: 'admin@localhost', password: hashed }
  })

  if (!existing) {
    // Only print the password on the very first seed
    console.log('─────────────────────────────────────────────')
    console.log(`  Admin email:    ${user.email}`)
    console.log(`  Admin password: ${plainPassword}`)
    console.log('  ⚠  Save this — it will not be shown again.')
    console.log('─────────────────────────────────────────────')
  } else {
    console.log(`Seeded user: ${user.email} (existing password kept)`)
  }

  // Default settings (upsert so existing values are never overwritten)
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await prisma.setting.upsert({
      where:  { key },
      update: {},
      create: { key, value }
    })
  }
  console.log(`Seeded ${Object.keys(DEFAULT_SETTINGS).length} default settings`)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())
