/**
 * After "restore a backup" the server ends itself and comes back with the archive (Docker starts it again). The page
 * reloads only once the server answers again: a reload after a fixed time could hit the gap and leave the browser's
 * own error page ("This site can't be reached") where nextasks was.
 */

export type RestartTiming = {
  /** Between two looks at the server. */
  step?: number
  /** A server that never seemed away came back quicker than one look; after this long an answer counts too. */
  quickBack?: number
  /** Then the page reloads in any case, and the browser says what it sees. */
  giveUp?: number
}

/** Resolves once the server went away and answers again (or after `giveUp`). */
export async function untilBack(
  answers: () => Promise<boolean>,
  wait: (ms: number) => Promise<void>,
  { step = 1500, quickBack = 20_000, giveUp = 180_000 }: RestartTiming = {},
): Promise<void> {
  let waited = 0
  let wentAway = false
  for (;;) {
    const up = await answers()
    if (!up) wentAway = true
    else if (wentAway || waited >= quickBack) return
    if (waited >= giveUp) return
    await wait(step)
    waited += step
  }
}

/** Whether the server answers its health check. */
export function serverAnswers(): Promise<boolean> {
  return fetch('/api/health', { cache: 'no-store' }).then(
    (answer) => answer.ok,
    () => false,
  )
}

export function pause(ms: number): Promise<void> {
  return new Promise((done) => window.setTimeout(done, ms))
}
