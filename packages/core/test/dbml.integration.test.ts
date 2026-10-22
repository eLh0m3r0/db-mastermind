import { rmSync } from 'node:fs'
import { afterAll, describe, expect, it } from 'vitest'
import { compareSchemas, DatabaseService, parseDbml, toDbml } from '../src/index.js'
import { engines, setupEngine, skip, tmp } from './fixtures.js'

afterAll(() => rmSync(tmp, { recursive: true, force: true }))

for (const engine of engines) {
  describe.skipIf(skip.has(engine.id))(`DBML round trip on ${engine.id}`, () => {
    it('a live schema survives DBML export and import unchanged', async () => {
      const svc = new DatabaseService()
      try {
        const config = await setupEngine(svc, engine)
        const snapshot = await svc.schema(config.id, true)
        const live = snapshot.tables.filter((t) => t.type === 'table' && (t.schema ?? '') === engine.schema && ['customers', 'orders'].includes(t.name))
        const text = toDbml(live, { defaultSchema: snapshot.defaultSchema })
        const model = parseDbml(text, { defaultSchema: snapshot.defaultSchema })
        expect(model.errors).toEqual([])
        expect(compareSchemas(model.tables, live, { keepExtra: false }), text).toEqual([])
      } finally {
        await svc.disconnectAll()
      }
    })
  })
}
