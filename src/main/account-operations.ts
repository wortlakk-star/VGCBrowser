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

/** Like runAccountOperation but NEVER rejected by an account transition: a close-time session
 *  save that lands while a switch is waiting for in-flight work must still run (the transition
 *  waits for it like any other active operation). Never use for work that may touch the NEW
 *  account — it is only for finishing what the current account started. */
export function runCloseOperation<T>(fn: () => Promise<T>): Promise<T> {
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

/** Wait for every in-flight account operation (e.g. a close-time session upload started by an
 *  engine 'exit' handler moments before quit) to settle. Snapshots the set each round because
 *  operations remove themselves when done. Bounded by `maxMs` so a stalled upload can never
 *  wedge the caller. Returns true when nothing is left in flight. */
export async function awaitActiveOperations(maxMs: number): Promise<boolean> {
  const deadline = Date.now() + maxMs
  while (active.size > 0 && Date.now() < deadline) {
    const remaining = Math.max(50, deadline - Date.now())
    await Promise.race([
      Promise.allSettled([...active]),
      new Promise((r) => setTimeout(r, remaining))
    ])
  }
  return active.size === 0
}

/** Number of account operations currently in flight (diagnostics). */
export function activeOperationCount(): number {
  return active.size
}
