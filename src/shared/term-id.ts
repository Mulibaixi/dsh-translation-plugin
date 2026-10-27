/** One identity style for every new term: `term:<lowercase uuid>`. Stored legacy ids stay readable and updatable. */
export function newTermId(): string {
  return `term:${randomUuid()}`
}

interface WebCryptoLike {
  randomUUID?(): string
  getRandomValues?(array: Uint8Array): Uint8Array
}

function randomUuid(): string {
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto
  const uuid = webcrypto?.randomUUID?.()
  if (typeof uuid === 'string' && uuid.length === 36) return uuid.toLowerCase()
  const bytes = new Uint8Array(16)
  if (typeof webcrypto?.getRandomValues === 'function') webcrypto.getRandomValues(bytes)
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
