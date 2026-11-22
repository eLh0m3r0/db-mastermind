/**
 * Leaving the app (quitting, closing the window, restarting into an update) asks what would be lost: unsaved grid
 * edits (the page asks Save / Discard / Cancel) and open transactions (Commit / Roll back / Cancel). Each attempt asks
 * afresh: nothing it learned outlives it. An attempt that a Cancel ended leaves nothing behind, so edits made after it
 * are asked about at the next quit (a flag that remembered "edits settled" let them be lost). Only the exit an attempt
 * starts itself (the app quitting after the window closed or after "Restart now") passes without asking again: once,
 * cancelled as soon as that exit is known not to happen, and expiring within seconds if nothing says either way.
 */
export type ExitKind = 'quit' | 'close-window' | 'close-last-window'

export interface ExitSteps {
  /** Unsaved grid edits: true when saved, discarded or there were none; false for Cancel (or a failed save). */
  edits: () => Promise<boolean>
  /** Open transactions: true when committed, rolled back or there were none; false for Cancel (or a failed commit). */
  transactions: () => Promise<boolean>
}

export class ExitGuard {
  private running: { kind: ExitKind; result: Promise<boolean> } | undefined
  /** The pass for the quit an agreed exit starts itself (an object, so a stale cancel can't cancel a newer pass). */
  private pass: { until: number } | undefined

  constructor(
    private readonly steps: ExitSteps,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * One attempt: the questions in order, every answer Cancel ends it with nothing remembered. Closing the window on a
   * Mac (the app stays) asks only about the edits, which go with the page; quitting and closing the last window also
   * about transactions. Callers that come while an attempt runs share it.
   */
  attempt(kind: ExitKind): Promise<boolean> {
    const pass = this.pass
    if (kind !== 'close-window' && pass) {
      this.pass = undefined
      if (pass.until > this.now()) return Promise.resolve(true)
    }
    if (this.running && (this.running.kind === kind || this.running.kind !== 'close-window')) return this.running.result
    const result = (async () => {
      try {
        if (!(await this.steps.edits())) return false
        if (kind !== 'close-window' && !(await this.steps.transactions())) return false
        return true
      } finally {
        this.running = undefined
      }
    })()
    this.running = { kind, result }
    return result
  }

  /**
   * The user agreed to an exit that the app now starts itself (the last window closes and the app quits, or
   * "Restart now" quits into the update): the quit it causes passes once without asking again. The returned function
   * cancels the pass as soon as that quit is known not to come (the installer threw, the window stayed); if nothing
   * says either way, the pass expires after `ms`, and the next quit asks as usual.
   */
  passNextQuit(ms = 2_000): () => void {
    const pass = { until: this.now() + ms }
    this.pass = pass
    return () => {
      if (this.pass === pass) this.pass = undefined
    }
  }
}

/**
 * Asks the page about unsaved grid edits. Whether there are any is a quick question: a page that doesn't answer it
 * within `timeoutMs` (busy, crashed) doesn't keep the app from quitting. The question itself, and a Save it leads to,
 * are waited for however long they take.
 */
export async function askPageAboutEdits(run: <T>(code: string) => Promise<T>, timeoutMs = 1500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const has = await Promise.race([
    run<boolean>('!!window.__dbmHasUnsavedEdits?.()').catch(() => false),
    new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
  ])
  clearTimeout(timer)
  if (!has) return true
  return (await run<boolean>('window.__dbmSettleUnsavedEdits ? window.__dbmSettleUnsavedEdits() : true').catch(() => true)) !== false
}
