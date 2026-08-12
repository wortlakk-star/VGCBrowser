export async function readLimitedResponseText(
  response: Response,
  maxBytes: number
): Promise<string> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) {
    throw new Error('Giới hạn HTTP không hợp lệ')
  }
  const declared = Number(response.headers.get('content-length') || 0)
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {})
    throw new Error('Phản hồi HTTP vượt giới hạn')
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Phản hồi HTTP vượt giới hạn')
      chunks.push(Buffer.from(value))
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    throw error
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

export async function readLimitedResponseJson<T>(
  response: Response,
  maxBytes: number
): Promise<T> {
  return JSON.parse(await readLimitedResponseText(response, maxBytes)) as T
}
