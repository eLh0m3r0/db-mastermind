/**
 * The model's undo history: the text before each change, and the tab's settings the change also made (Switch database
 * changes the project's database, a batch rename the layout keys and the renames Save writes). Undo puts both back,
 * so the text and the settings never disagree.
 */
export interface ModelStep<M> {
  text: string
  meta?: Partial<M>
}

export interface ModelSteps<M> {
  past: ModelStep<M>[]
  future: ModelStep<M>[]
}

const LIMIT = 100

/** The settings named by `keys` as they are now (undefined values too: undo must clear what the change set). */
export function pick<M extends object>(source: M, keys: (keyof M)[]): Partial<M> {
  return Object.fromEntries(keys.map((k) => [k, source[k]])) as Partial<M>
}

/** Before a change: the text and the settings `patch` is about to change. */
export function remembered<M extends object>(steps: ModelSteps<M>, text: string, tab: M, patch: Partial<M> = {}, ignore: (keyof M)[] = []): ModelSteps<M> {
  const keys = (Object.keys(patch) as (keyof M)[]).filter((k) => !ignore.includes(k))
  return { past: [...steps.past.slice(-(LIMIT - 1)), { text, ...(keys.length ? { meta: pick(tab, keys) } : {}) }], future: [] }
}

/** Undo (`from` past, `to` future) or redo (the other way): the step to go to, and the current state kept for the way back. */
export function stepTo<M extends object>(steps: ModelSteps<M>, direction: 'undo' | 'redo', text: string, tab: M): ModelStep<M> | undefined {
  const [from, to] = direction === 'undo' ? [steps.past, steps.future] : [steps.future, steps.past]
  const step = from.pop()
  if (!step) return undefined
  to.push({ text, ...(step.meta ? { meta: pick(tab, Object.keys(step.meta) as (keyof M)[]) } : {}) })
  return step
}
