// Stable per-profile seed used by VGC Core's native fingerprint surfaces.

/** Stable 32-bit FNV-1a hash of a string. */
export function seedFromString(value: string): number {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}
