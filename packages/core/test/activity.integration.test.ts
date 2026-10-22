import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { DatabaseService, listActivity, stopSession } from '../src/index.js'
import { engines, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines.filter((e) => e.id !== 'sqlite')) {
  describe.skipIf(skip.has(engine.id))(`server activity on ${engine.id}`, () => {
    it('lists a long-running query and cancels it', async () => {
      const svc = new DatabaseService()
      try {
        await svc.connect(engine.config)
        const running = svc.runScript(engine.config.id, engine.sleep, { session: 'slow' })
        let target: string | undefined
        for (let i = 0; i < 20 && !target; i++) {
          await new Promise((r) => setTimeout(r, 300))
          const sessions = await listActivity(svc, engine.config.id)
          expect(sessions.some((s) => s.own)).toBe(true)
          target = sessions.find((s) => !s.own && /sleep|waitfor/i.test(s.query ?? ''))?.id
        }
        expect(target).toBeDefined()
        const started = Date.now()
        await stopSession(svc, engine.config.id, target!, 'cancel')
        await running
        // MySQL's SLEEP() returns 1 when interrupted instead of failing, so check that it ended early.
        expect(Date.now() - started).toBeLessThan(15_000)
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}
