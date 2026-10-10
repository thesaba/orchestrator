export function domainToSlug(domain: string): string {
  return domain
    .replace(/^www\./, '')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .substring(0, 16)
    .toLowerCase()
}

export function generatePassword(length = 20): string {
  // Symbol set is deliberately shell-, SQL- and .env-safe: no $ ` ' " \ space { }
  // so the value passes through mysql "IDENTIFIED BY '…'", a .env file and wp-cli
  // without quoting surprises. Still strong (62+ alphabet).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#%^*-_=+.?'
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
}
