import crypto from 'crypto'

// Symmetric encryption for secrets we must store but never display back in
// plaintext (e.g. private-repo Git access tokens). Uses AES-256-GCM.
//
// ENCRYPTION_KEY can be any string — it's hashed with SHA-256 to derive a
// proper 32-byte key, so users don't need to generate one in a special format.
// Falls back to JWT_SECRET if ENCRYPTION_KEY isn't set, so existing deployments
// don't need a new env var just to use this feature (but setting a dedicated
// ENCRYPTION_KEY is recommended).

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET
  if (!secret) {
    throw new Error('ENCRYPTION_KEY (or JWT_SECRET) must be set to store encrypted secrets')
  }
  return crypto.createHash('sha256').update(secret).digest()
}

const IV_LENGTH = 12 // recommended IV length for GCM

/** Encrypts a plaintext string. Output format: "<ivHex>:<tagHex>:<cipherHex>" */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`
}

/** Decrypts a string produced by encryptSecret(). Returns null if malformed. */
export function decryptSecret(payload: string): string | null {
  try {
    const [ivHex, tagHex, dataHex] = payload.split(':')
    if (!ivHex || !tagHex || !dataHex) return null
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivHex, 'hex'))
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final()
    ])
    return decrypted.toString('utf8')
  } catch {
    return null
  }
}
