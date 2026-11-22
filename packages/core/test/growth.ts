/**
 * How the time of the work `prepare(n)` returns grows from an input of size n to one of 4n (best of three runs each, so a GC pause or a
 * cold JIT doesn't count): about 4 for linear work, 16 for quadratic. Tests assert on this ratio instead of on
 * milliseconds, which differ several times between a Mac and CI runners. `n` should make the small run take a few
 * milliseconds; below 2 ms the ratio is taken against 2 ms, so noise in a tiny run can't make it look quadratic.
 */
export function growth(prepare: (n: number) => () => unknown, n: number): { ratio: number; small: number; large: number } {
  const best = (size: number) => {
    // (Making the input isn't timed: only what `prepare` returns.)
    const run = prepare(size)
    let ms = Infinity
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      try {
        run()
      } catch {
        // Refusing the input is an outcome too: its time counts the same.
      }
      ms = Math.min(ms, performance.now() - start)
    }
    return ms
  }
  // The whole measurement is repeated when it looks super-linear and the lowest ratio counts: on a machine busy with
  // other test files one of the two sizes can be slowed several times over, while quadratic work measures about 16
  // every time, however often it is asked.
  let result = { ratio: Infinity, small: 0, large: 0 }
  for (let attempt = 0; attempt < ATTEMPTS && result.ratio >= LINEAR; attempt++) {
    const small = best(n)
    const large = best(4 * n)
    const ratio = large / Math.max(small, 2)
    if (ratio < result.ratio) result = { ratio, small, large }
  }
  return result
}

const ATTEMPTS = 4

/** Linear work grows about 4 times; quadratic 16. Anything under 10 is taken as linear. */
export const LINEAR = 10

/** `growth` for async work (the DDL reader runs DuckDB). */
export async function growthAsync(prepare: (n: number) => () => Promise<unknown>, n: number): Promise<{ ratio: number; small: number; large: number }> {
  const best = async (size: number) => {
    const run = prepare(size)
    let ms = Infinity
    for (let i = 0; i < 3; i++) {
      const start = performance.now()
      try {
        await run()
      } catch {
        // Refusing the input is an outcome too.
      }
      ms = Math.min(ms, performance.now() - start)
    }
    return ms
  }
  let result = { ratio: Infinity, small: 0, large: 0 }
  for (let attempt = 0; attempt < ATTEMPTS && result.ratio >= LINEAR; attempt++) {
    const small = await best(n)
    const large = await best(4 * n)
    const ratio = large / Math.max(small, 2)
    if (ratio < result.ratio) result = { ratio, small, large }
  }
  return result
}
