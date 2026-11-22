import { afterEach, describe, expect, it, vi } from 'vitest'
import { askPageAboutEdits, ExitGuard, type ExitKind } from '../src/main/exit-guard'

type EditsAnswer = 'none' | 'save' | 'discard' | 'cancel' | 'save-fails'
type TxAnswer = 'none' | 'commit' | 'rollback' | 'cancel' | 'commit-fails'

/** A guard whose questions answer from a script, counting how often each was asked. */
function guardWith(edits: EditsAnswer[], tx: TxAnswer[], now = () => Date.now()) {
  const asked = { edits: 0, tx: 0 }
  const guard = new ExitGuard(
    {
      edits: async () => {
        const a = edits[Math.min(asked.edits++, edits.length - 1)]!
        return a !== 'cancel' && a !== 'save-fails'
      },
      transactions: async () => {
        const a = tx[Math.min(asked.tx++, tx.length - 1)]!
        return a !== 'cancel' && a !== 'commit-fails'
      },
    },
    now,
  )
  return { guard, asked }
}

const KINDS: ExitKind[] = ['quit', 'close-window', 'close-last-window']
const EDITS: EditsAnswer[] = ['none', 'save', 'discard', 'cancel', 'save-fails']
const TXS: TxAnswer[] = ['none', 'commit', 'rollback', 'cancel', 'commit-fails']

describe('leaving the app: every trigger × every answer', () => {
  for (const kind of KINDS)
    for (const e of EDITS)
      for (const x of TXS) {
        it(`${kind}: edits ${e}, transactions ${x}`, async () => {
          const { guard, asked } = guardWith([e, 'save'], [x, 'commit'])
          const editsGoOn = e !== 'cancel' && e !== 'save-fails'
          const txAsked = editsGoOn && kind !== 'close-window'
          const expected = editsGoOn && (kind === 'close-window' || (x !== 'cancel' && x !== 'commit-fails'))
          expect(await guard.attempt(kind)).toBe(expected)
          expect(asked).toEqual({ edits: 1, tx: txAsked ? 1 : 0 })
          // Whatever happened, the next attempt asks again from the start: nothing carries over.
          await guard.attempt('quit')
          expect(asked.edits).toBe(2)
        })
      }
})

describe('the reviewer’s sequence', () => {
  it('quit → Discard the edits → Cancel the transactions → more edits → quit asks about the edits again', async () => {
    const { guard, asked } = guardWith(['discard', 'cancel'], ['cancel'])
    expect(await guard.attempt('quit')).toBe(false)
    expect(asked).toEqual({ edits: 1, tx: 1 })
    expect(await guard.attempt('quit')).toBe(false)
    expect(asked.edits).toBe(2)
  })

  it('the same after closing the last window (Windows, Linux) and cancelling the transactions', async () => {
    const { guard, asked } = guardWith(['save', 'cancel'], ['cancel'])
    expect(await guard.attempt('close-last-window')).toBe(false)
    expect(await guard.attempt('close-last-window')).toBe(false)
    expect(asked.edits).toBe(2)
  })
})

describe('"Restart now" and the quit an agreed exit causes', () => {
  it('passes the one quit it starts without asking again, then asks as usual', async () => {
    const { guard, asked } = guardWith(['discard'], ['rollback'])
    expect(await guard.attempt('quit')).toBe(true) // "Restart now" asked both
    guard.passNextQuit()
    expect(await guard.attempt('quit')).toBe(true) // the quit into the update
    expect(asked).toEqual({ edits: 1, tx: 1 })
    expect(await guard.attempt('quit')).toBe(true) // a later quit asks again
    expect(asked).toEqual({ edits: 2, tx: 2 })
  })

  it('a pass whose quit never came expires within seconds (2 s by default)', async () => {
    let t = 1000
    const { guard, asked } = guardWith(['none'], ['none'], () => t)
    guard.passNextQuit()
    t += 2_001
    await guard.attempt('quit')
    expect(asked).toEqual({ edits: 1, tx: 1 })
  })

  for (const [what, edits, tx] of [
    ['unsaved edits', 'cancel', 'none'],
    ['an open transaction', 'none', 'cancel'],
  ] as [string, EditsAnswer, TxAnswer][]) {
    it(`a failed restart (the installer threw) cancels the pass: a quit right after with ${what} asks both questions`, async () => {
      const { guard, asked } = guardWith(['discard', edits], ['rollback', tx])
      expect(await guard.attempt('quit')).toBe(true) // "Restart now" agreed
      const cancel = guard.passNextQuit()
      cancel() // the installer threw, no quit is coming
      expect(await guard.attempt('quit')).toBe(edits !== 'cancel' && tx !== 'cancel')
      expect(asked).toEqual({ edits: 2, tx: edits === 'cancel' ? 1 : 2 })
    })
  }

  it('the pass is used up by the quit it was made for, and only by that one', async () => {
    const { guard, asked } = guardWith(['save'], ['commit'])
    guard.passNextQuit()
    expect(await guard.attempt('quit')).toBe(true)
    expect(asked).toEqual({ edits: 0, tx: 0 })
    await guard.attempt('quit')
    expect(asked).toEqual({ edits: 1, tx: 1 })
  })

  it('cancelling an old pass leaves a newer one alone', async () => {
    const { guard, asked } = guardWith(['save'], ['commit'])
    const old = guard.passNextQuit()
    guard.passNextQuit()
    old()
    expect(await guard.attempt('quit')).toBe(true)
    expect(asked).toEqual({ edits: 0, tx: 0 })
  })

  it('a pass that expired is not used later either', async () => {
    let t = 0
    const { guard, asked } = guardWith(['save'], ['commit'], () => t)
    guard.passNextQuit()
    t = 5_000
    await guard.attempt('quit')
    await guard.attempt('quit')
    expect(asked).toEqual({ edits: 2, tx: 2 })
  })

  it('"Restart now" cancelled at either question: the update waits and the next quit asks', async () => {
    for (const [e, x] of [['cancel', 'commit'], ['save', 'cancel']] as [EditsAnswer, TxAnswer][]) {
      const { guard, asked } = guardWith([e, 'none'], [x, 'none'])
      expect(await guard.attempt('quit')).toBe(false)
      await guard.attempt('quit')
      expect(asked.edits).toBe(2)
    }
  })

  it('closing a window on a Mac never passes a quit', async () => {
    const { guard, asked } = guardWith(['none'], ['none'])
    guard.passNextQuit()
    await guard.attempt('close-window')
    expect(asked.edits).toBe(1)
  })
})

describe('asking the page', () => {
  afterEach(() => vi.useRealTimers())

  it('a page that doesn’t say whether it has edits within 1.5 s doesn’t stop the quit', async () => {
    vi.useFakeTimers()
    const result = askPageAboutEdits(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(1500)
    await expect(result).resolves.toBe(true)
  })

  it('a slow Save is waited for, however long it takes (the 1.5 s only covers the first question)', async () => {
    vi.useFakeTimers()
    let saved = false
    const run = <T,>(code: string): Promise<T> =>
      (code.includes('__dbmHasUnsavedEdits') ? Promise.resolve(true) : new Promise((r) => setTimeout(() => ((saved = true), r(true)), 5000))) as Promise<T>
    let done = false
    const result = askPageAboutEdits(run).then((ok) => ((done = true), ok))
    await vi.advanceTimersByTimeAsync(4000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1500)
    await expect(result).resolves.toBe(true)
    expect(saved).toBe(true)
  })

  it('Cancel in the page, or a Save that fails, stops the quit', async () => {
    const run = (answer: boolean) => <T,>(code: string): Promise<T> => Promise.resolve((code.includes('__dbmHasUnsavedEdits') ? true : answer) as T)
    await expect(askPageAboutEdits(run(false))).resolves.toBe(false)
    await expect(askPageAboutEdits(run(true))).resolves.toBe(true)
  })
})
