import { describe, expect, it } from 'vitest'
import { reachablePosition } from '../src/main/window-bounds'

const laptop = { x: 0, y: 0, width: 1440, height: 860 }
const monitorRight = { x: 1440, y: 0, width: 2560, height: 1400 }

describe('reachablePosition', () => {
  it('keeps a position on a connected display', () => {
    expect(reachablePosition({ x: 1600, y: 100, width: 1400, height: 900 }, [laptop, monitorRight])).toEqual({ x: 1600, y: 100 })
    expect(reachablePosition({ x: 100, y: 50, width: 1200, height: 800 }, [laptop])).toEqual({ x: 100, y: 50 })
  })

  it('drops a position on a monitor that is no longer connected', () => {
    expect(reachablePosition({ x: 1600, y: 100, width: 1400, height: 900 }, [laptop])).toBeUndefined()
  })

  it('drops a position whose title bar is above the screen or only a sliver is visible', () => {
    expect(reachablePosition({ x: 100, y: -500, width: 1200, height: 800 }, [laptop])).toBeUndefined()
    expect(reachablePosition({ x: 1400, y: 100, width: 1200, height: 800 }, [laptop])).toBeUndefined()
  })

  it('has nothing to restore on the first start', () => {
    expect(reachablePosition({ width: 1440, height: 900 }, [laptop])).toBeUndefined()
  })
})
