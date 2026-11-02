/**
 * The server couldn't be reached at all (VPN down, Wi-Fi off, host asleep): worth trying again later, unlike a wrong
 * password, an unknown database or a certificate the client refuses. Works on `{ code, message }` so the renderer can
 * classify errors that crossed IPC.
 */
export function isUnreachableError(err: unknown): boolean {
  const e = (typeof err === 'string' ? { message: err } : err) as { code?: string | number; message?: string } | null | undefined
  if (!e) return false
  const code = String(e.code ?? '')
  if (UNREACHABLE_CODES.has(code)) return true
  return UNREACHABLE_MESSAGE.test(e.message ?? '')
}

const UNREACHABLE_CODES = new Set([
  'ETIMEDOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  // tedious (SQL Server)
  'ESOCKET',
  'ETIMEOUT',
])

const UNREACHABLE_MESSAGE =
  /\b(ETIMEDOUT|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN)\b|getaddrinfo|connect(ion)? timed? ?out|Connection terminated|Timed out while waiting for handshake|Failed to connect to .+ in \d+ ?ms|Could not connect \(sequence\)|socket hang up|network is unreachable/i
