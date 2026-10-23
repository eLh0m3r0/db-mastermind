import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '/nonexistent', on: () => undefined }, powerMonitor: { on: () => undefined } }))

const { scheduleChecks } = await import('../src/main/updates')

const HOUR = 3_600_000

afterEach(() => {
  vi.useRealTimers()
})

describe('scheduleChecks', () => {
  it('checks at start, every few hours, and after waking when the last check is old', async () => {
    vi.useFakeTimers()
    const check = vi.fn(async () => {})
    let wake = () => {}
    const stop = scheduleChecks(check, (listener) => (wake = listener), 4 * HOUR, HOUR)
    expect(check).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    wake()
    expect(check).toHaveBeenCalledTimes(1) // checked half an hour ago
    await vi.advanceTimersByTimeAsync(HOUR)
    wake()
    expect(check).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(check).toHaveBeenCalledTimes(3)
    stop()
    await vi.advanceTimersByTimeAsync(8 * HOUR)
    wake()
    expect(check).toHaveBeenCalledTimes(3)
  })

  it('never runs two checks at once, and a failing check does not stop the schedule', async () => {
    vi.useFakeTimers()
    let finish = () => {}
    const check = vi.fn(() => new Promise<void>((resolve, reject) => (finish = check.mock.calls.length === 1 ? () => reject(new Error('offline')) : resolve)))
    let wake = () => {}
    scheduleChecks(check, (listener) => (wake = listener), 4 * HOUR, 0)
    wake()
    expect(check).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(4 * HOUR)
    expect(check).toHaveBeenCalledTimes(2)
  })
})
