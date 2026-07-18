// ── VGC Browser — parse a pasted proxy line ──────────────────────────────────
// Shared by the Proxy Manager (bulk import) and the Create-profile modal (nhập tay).
import type { ProxyType, SavedProxy } from '../../shared/types'

export function isPort(x?: string): boolean {
  if (!x) return false
  const n = Number(x)
  return Number.isInteger(n) && n > 0 && n <= 65535
}

// Extract host/port/user/pass from a line that has already had any scheme/marker removed.
function parseCore(s: string, type: ProxyType): Omit<SavedProxy, 'id' | 'label'> | null {
  let host = ''
  let port = 0
  let username: string | undefined
  let password: string | undefined

  if (s.includes('@')) {
    const at = s.split('@')
    if (at.length !== 2) return null
    const aP = at[0].split(':')
    const bP = at[1].split(':')
    const aHost = aP.length === 2 && isPort(aP[1])
    const bHost = bP.length === 2 && isPort(bP[1])
    let hp: string[]
    let cred: string[]
    if (bHost && !aHost) {
      hp = bP // user:pass@host:port
      cred = aP
    } else if (aHost && !bHost) {
      hp = aP // host:port@user:pass
      cred = bP
    } else if (aHost && bHost) {
      // both numeric: host side = the one whose first token looks like a host (has a dot)
      if (/\./.test(aP[0]) && !/\./.test(bP[0])) {
        hp = aP
        cred = bP
      } else {
        hp = bP
        cred = aP
      }
    } else {
      return null
    }
    host = hp[0]
    port = Number(hp[1])
    username = cred[0]
    password = cred[1]
  } else {
    const parts = s.split(':')
    if (parts.length === 2 && isPort(parts[1])) {
      host = parts[0]
      port = Number(parts[1])
    } else if (parts.length === 4 && isPort(parts[1])) {
      host = parts[0]
      port = Number(parts[1])
      username = parts[2]
      password = parts[3]
    } else {
      return null
    }
  }
  if (!host || !isPort(String(port))) return null
  return { type, host, port, username, password }
}

/**
 * Parse one pasted proxy line. Handles, in any order:
 *   user:pass@host:port   ·   host:port@user:pass
 *   host:port:user:pass   ·   host:port   ·   scheme://…   ·   trailing :SOCKS5
 * defaultType applies when the line has no scheme/marker.
 */
export function parseLine(
  line: string,
  defaultType: ProxyType
): Omit<SavedProxy, 'id' | 'label'> | null {
  let s = line.trim()
  if (!s) return null
  let type: ProxyType = defaultType
  const scheme = s.match(/^(https?|socks5):\/\//i)
  if (scheme) {
    const k = scheme[1].toLowerCase()
    type = k === 'socks5' ? 'socks5' : k === 'https' ? 'https' : 'http'
    s = s.slice(scheme[0].length)
  }
  // A trailing ...:SOCKS5 / :HTTP / :HTTPS is usually a type marker — BUT it could also be a
  // literal password of exactly 'http'/'https'/'socks5' in a host:port:user:pass line. Try it
  // as a marker first; only if the stripped remainder fails to parse do we fall back to treating
  // the ':http' etc. as part of the credentials.
  const tail = s.match(/:(socks5|https?)$/i)
  if (tail) {
    const k = tail[1].toLowerCase()
    const markerType: ProxyType = k === 'socks5' ? 'socks5' : k === 'https' ? 'https' : 'http'
    const asMarker = parseCore(s.slice(0, s.length - tail[0].length), markerType)
    if (asMarker) return asMarker
  }
  return parseCore(s, type)
}
