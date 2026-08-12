const active = new Set<Promise<unknown>>()
let transitions: Promise<unknown> = Promise.resolve()
let blocked = false

export function runAccountOperation<T>(fn: () => Promise<T>): Promise<T> {
  if (blocked) return Promise.reject(new Error('Đang chuyển tài khoản; vui lòng thử lại sau.'))
  const task = Promise.resolve().then(fn)
  active.add(task)
  void task.finally(() => active.delete(task)).catch(() => {})
  return task
}

export function runAccountTransition<T>(fn: () => Promise<T>): Promise<T> {
  const execute = async (): Promise<T> => {
    blocked = true
    try {
      while (active.size > 0) {
        await Promise.allSettled([...active])
      }
      return await fn()
    } finally {
      blocked = false
    }
  }
  const run = transitions.then(execute, execute)
  transitions = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function accountTransitionInProgress(): boolean {
  return blocked
}
