// The tab strip (launch UX review, UX-01…07): "+" always there and clickable (with 3–30 tabs, short and long names,
// 900–1920 px, without a connection), the selected tab fully in view after opening, closing, switching, split view,
// restoring and resizing, fades only on a side with hidden tabs, ⇧⌘] / ⇧⌘[ and Ctrl+PageDown / PageUp, the strip
// reachable with the keyboard, new tabs never repeating a name, a reopened tab back in its place, and the strip's
// empty part still dragging the window.
import { _electron as electron } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? tmpdir()
const dir = mkdtempSync(join(tmpdir(), 'dbm-ui116-'))
const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, HOME: join(dir, 'home'), DBM_USER_DATA: join(dir, 'data'), DBM_NO_UPDATE_CHECK: '1', DBM_LANGUAGE: 'en', DBM_E2E_BACKGROUND: '1' } })
const win = await app.firstWindow()
const errors = []
win.on('pageerror', (e) => errors.push(e.message))
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` (${detail})`}`)
  if (!ok) process.exitCode = 1
}
const size = async (w, h = 800) => {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [w, h])
  await win.waitForTimeout(350)
}
const menu = (command) => app.evaluate(({ BrowserWindow }, command) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', command), command)
const api = (fn, ...args) => win.evaluate(([fn, args]) => window.mastermind.api[fn](...args), [fn, args])

/** Where "+" and the selected tab are, against the strip and its fades. */
const strip = () =>
  win.evaluate(() => {
    const el = document.querySelector('[role="tablist"]')
    const plus = document.querySelector('[data-testid="new-tab"]')
    const s = el.getBoundingClientRect()
    const fade = el.dataset.fade ?? ''
    const lo = s.left + (fade.includes('left') ? 28 : 0) - 1
    const hi = s.right - (fade.includes('right') ? 28 : 0) + 1
    const tabs = [...el.querySelectorAll('[role="tab"]')]
    const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true')
    const a = active?.getBoundingClientRect()
    const p = plus?.getBoundingClientRect()
    const hit = p && document.elementFromPoint(p.left + p.width / 2, p.top + p.height / 2)
    const max = el.scrollWidth - el.clientWidth
    return {
      plus: !!p && p.width > 0 && p.right <= innerWidth && !!hit && (hit === plus || plus.contains(hit)),
      activeInView: !!a && a.left >= lo && a.right <= hi,
      fadesRight: fade.includes('left') === el.scrollLeft > 1 && fade.includes('right') === el.scrollLeft < max - 1,
      titles: tabs.map((t) => t.innerText.trim()),
      active: tabs.indexOf(active),
    }
  })

try {
  await win.waitForTimeout(800)
  await api('createSampleDatabase')
  const connId = (await api('listConnections'))[0].id
  const setTabs = async (n, long, activeIndex = n - 1) => {
    const names = long ? ['Monthly revenue by customer segment', 'order_items_with_product_details', 'Find duplicated customers (email)'] : ['Q', 'orders', 'sql']
    const tabs = Array.from({ length: n }, (_, i) => ({ id: `t${i}`, kind: 'query', connectionId: connId, title: `${names[i % 3]} ${i + 1}`, sql: '' }))
    await api('saveWorkspace', { tabs, activeTabId: `t${activeIndex}` })
    await win.reload()
    await win.waitForTimeout(1200)
  }

  // The matrix: "+" clickable and the selected (last) tab in view everywhere; fades where tabs are hidden.
  const bad = []
  for (const w of [900, 1280, 1920]) {
    await size(w)
    for (const n of [3, 8, 15, 30]) {
      for (const long of [false, true]) {
        await setTabs(n, long)
        const s = await strip()
        if (!s.plus || !s.activeInView || !s.fadesRight) bad.push(`${w}px ${n} ${long ? 'long' : 'short'}: ${JSON.stringify({ plus: s.plus, active: s.activeInView, fades: s.fadesRight })}`)
      }
    }
  }
  check('"+" clickable, selected tab in view, fades only where tabs are hidden: 24 cases', bad.length === 0, bad.join(' | '))

  // The same matrix in Shrink mode (Settings → Appearance): the selected tab keeps its natural width, the others never
  // go below the floor (92 px), no scrolling before the floor is reached, then the strip scrolls as in Scroll mode.
  await api('updateSettings', { tabOverflow: 'shrink' })
  const badShrink = []
  for (const w of [900, 1280, 1920]) {
    await size(w)
    for (const n of [3, 8, 15, 30]) {
      for (const long of [false, true]) {
        await setTabs(n, long)
        const s = await strip()
        const m = await win.evaluate(() => {
          const el = document.querySelector('[role="tablist"]')
          const tabs = [...el.querySelectorAll('[role="tab"]')]
          const active = tabs.find((t) => t.getAttribute('aria-selected') === 'true')
          const title = active.querySelector('[data-tab-title]')
          const inactive = tabs.filter((t) => t !== active).map((t) => Math.round(t.getBoundingClientRect().width))
          return { whole: title.scrollWidth <= title.clientWidth + 1 || Math.round(active.getBoundingClientRect().width) >= 220, min: Math.min(...inactive), scroll: el.scrollWidth - el.clientWidth }
        })
        const ok = s.plus && s.activeInView && s.fadesRight && m.whole && m.min >= 92 && (m.scroll <= 1 || m.min === 92)
        if (!ok) badShrink.push(`${w}px ${n} ${long ? 'long' : 'short'}: ${JSON.stringify({ plus: s.plus, active: s.activeInView, fades: s.fadesRight, ...m })}`)
        if (n === 30 && long && m.scroll > 1) {
          // At the floor the strip scrolls: the wheel moves it.
          await win.evaluate(() => (document.querySelector('[role="tablist"]').scrollLeft = 0))
          const before = await win.evaluate(() => document.querySelector('[role="tablist"]').scrollLeft)
          await win.locator('[role="tab"]').first().hover()
          await win.mouse.wheel(0, 400)
          await win.waitForTimeout(200)
          if ((await win.evaluate(() => document.querySelector('[role="tablist"]').scrollLeft)) <= before) badShrink.push(`${w}px: the wheel did not scroll at the floor`)
        }
      }
    }
  }
  check('Shrink: selected tab whole, others ≥ 92 px, no scrolling before the floor, "+" clickable, fades right: 24 cases', badShrink.length === 0, badShrink.join(' | '))
  await size(1280)
  await setTabs(12, true, 2)
  const widthsOf = () => win.evaluate(() => [...document.querySelectorAll('[role="tab"]')].map((t) => Math.round(t.getBoundingClientRect().width)))
  const w1 = await widthsOf()
  await win.keyboard.press('Meta+6')
  await win.waitForTimeout(400)
  const w2 = await widthsOf()
  const changed = w1.map((x, i) => (x !== w2[i] ? i : -1)).filter((i) => i >= 0)
  check('Shrink: selecting another tab changes only the two that trade widths', changed.join() === '2,5', changed.join())
  await win.locator('[role="tab"]').nth(8).hover()
  await win.waitForTimeout(250)
  const closeShown = await win.evaluate(() => getComputedStyle(document.querySelectorAll('[role="tab"]')[8].querySelector('button[aria-label="Close tab"]')).opacity)
  check('Shrink: a narrowed tab shows its close button on hover', closeShown === '1', closeShown)
  await win.locator('[role="tab"]').nth(8).click({ button: 'middle' })
  await win.waitForTimeout(300)
  check('Shrink: middle-click still closes a narrowed tab', (await strip()).titles.length === 11)
  await api('updateSettings', { tabOverflow: 'scroll' })

  // Restored with a middle tab selected, then every way of moving around.
  await size(1280)
  await setTabs(15, true, 7)
  let s = await strip()
  check('restored with the 8th tab selected: in view', s.active === 7 && s.activeInView && s.plus)
  for (const [label, key, expect] of [
    ['⌘1', 'Meta+1', 0],
    ['⌘9 (last)', 'Meta+9', 14],
    ['Ctrl+Tab wraps to the first', 'Control+Tab', 0],
    ['Ctrl+Shift+Tab back to the last', 'Control+Shift+Tab', 14],
    ['⇧⌘] wraps to the first', 'Meta+Shift+BracketRight', 0],
    ['⇧⌘[ back to the last', 'Meta+Shift+BracketLeft', 14],
    ['Ctrl+PageUp', 'Control+PageUp', 13],
    ['Ctrl+PageDown', 'Control+PageDown', 14],
  ]) {
    await win.keyboard.press(key)
    await win.waitForTimeout(250)
    s = await strip()
    check(`${label}: tab ${expect + 1} selected and in view`, s.active === expect && s.activeInView, JSON.stringify({ active: s.active, inView: s.activeInView }))
  }

  // ⌘T from the 3rd tab: the new tab goes last (where "+" is), named after the highest number.
  await win.keyboard.press('Meta+3')
  await win.keyboard.press('Meta+t')
  await win.waitForTimeout(400)
  s = await strip()
  check('⌘T adds the tab last, selected and in view', s.active === 15 && s.titles.length === 16 && s.activeInView)
  check('the new tab is "Query 1" (no query tab named so yet)', s.titles[15] === 'Query 1', s.titles[15])
  await win.locator('[data-testid="new-tab"]').click()
  await win.waitForTimeout(400)
  s = await strip()
  check('"+" adds the next one, last and in view', s.titles[16] === 'Query 2' && s.active === 16 && s.activeInView, s.titles.slice(-2).join(', '))
  // Close Query 1 (the 16th) and add another: Query 3, never a second Query 2.
  await win.keyboard.press('Meta+9')
  await win.keyboard.press('Control+PageUp')
  await win.keyboard.press('Meta+w')
  await win.waitForTimeout(300)
  await win.keyboard.press('Meta+t')
  await win.waitForTimeout(300)
  s = await strip()
  check('after closing Query 1, the next new tab is Query 3', s.titles.at(-1) === 'Query 3' && s.titles.filter((x) => x === 'Query 2').length === 1, s.titles.slice(-3).join(', '))

  // Close the 5th and reopen it: back in 5th place, selected and in view.
  await win.keyboard.press('Meta+5')
  const fifth = (await strip()).titles[4]
  await win.keyboard.press('Meta+w')
  await win.waitForTimeout(300)
  s = await strip()
  check('closing the selected tab selects its neighbour, in view', s.titles[4] !== fifth && s.active === 4 && s.activeInView)
  await win.keyboard.press('Meta+Shift+t')
  await win.waitForTimeout(300)
  s = await strip()
  check('⌘⇧T puts it back in its place', s.titles[4] === fifth && s.active === 4 && s.activeInView, `${s.titles[4]} vs ${fifth}`)

  // Split view: the selected tab gets the split mark and still fits.
  await setTabs(12, true)
  await menu('split-view')
  await win.waitForTimeout(600)
  s = await strip()
  check('split view: the selected tab stays clear of the fade', s.activeInView && s.plus)
  await menu('split-view')
  // Resizing keeps it in view.
  for (const w of [900, 1440, 1100]) {
    await size(w)
    s = await strip()
    check(`resized to ${w}px: selected tab in view, "+" clickable`, s.activeInView && s.plus)
  }
  await size(1280)

  // Close tabs to the left / right (right-click menu): order, disabled at the ends, the selection, reopening.
  await setTabs(10, false, 0)
  const menuOf = async (index) => {
    await win.locator('[role="tab"]').nth(index).click({ button: 'right' })
    await win.waitForTimeout(250)
    const items = win.getByRole('menu').last().getByRole('menuitem')
    const labels = (await items.allInnerTexts()).map((x) => x.split('\n')[0].trim())
    const disabled = async (name) => win.getByRole('menuitem', { name, exact: true }).isDisabled()
    return { labels, left: await disabled('Close tabs to the left'), right: await disabled('Close tabs to the right') }
  }
  let m = await menuOf(0)
  check('menu: Close, Close others, then Close tabs to the left / to the right', JSON.stringify(m.labels.slice(0, 4)) === JSON.stringify(['Close', 'Close others', 'Close tabs to the left', 'Close tabs to the right']), JSON.stringify(m.labels))
  check('first tab: "to the left" disabled, "to the right" enabled', m.left && !m.right, JSON.stringify(m))
  await win.keyboard.press('Escape')
  m = await menuOf(9)
  check('last tab: "to the right" disabled, "to the left" enabled', m.right && !m.left, JSON.stringify(m))
  await win.keyboard.press('Escape')
  const before = (await strip()).titles
  await win.keyboard.press('Meta+8')
  await menuOf(4)
  await win.getByRole('menuitem', { name: 'Close tabs to the right', exact: true }).click()
  await win.waitForTimeout(400)
  s = await strip()
  check('to the right: the 5 tabs after it are gone, the right-clicked one selected (the selected one was closed), in view', s.titles.length === 5 && s.titles.join() === before.slice(0, 5).join() && s.active === 4 && s.activeInView && s.plus, JSON.stringify(s.titles))
  for (let i = 0; i < 5; i++) {
    await win.keyboard.press('Meta+Shift+t')
    await win.waitForTimeout(150)
  }
  s = await strip()
  check('⇧⌘T five times brings them back, each in its place', s.titles.join() === before.join(), JSON.stringify(s.titles))
  await win.keyboard.press('Meta+2')
  await menuOf(3)
  await win.getByRole('menuitem', { name: 'Close tabs to the left', exact: true }).click()
  await win.waitForTimeout(400)
  s = await strip()
  check('to the left: the 3 before it are gone, the right-clicked one selected, in view', s.titles.join() === before.slice(3).join() && s.active === 0 && s.activeInView && s.plus, JSON.stringify(s.titles))
  // A table with unsaved edits among them: the question comes first, and Cancel closes nothing.
  await api('saveWorkspace', { tabs: [{ id: 'q0', kind: 'query', connectionId: connId, title: 'Q one', sql: '' }, { id: 'tt', kind: 'table', connectionId: connId, table: { name: 'orders' }, title: 'orders' }, { id: 'q2', kind: 'query', connectionId: connId, title: 'Q two', sql: '' }, { id: 'q3', kind: 'query', connectionId: connId, title: 'Q three', sql: '' }], activeTabId: 'tt' })
  await win.reload()
  await win.locator('[role="gridcell"]').first().waitFor({ timeout: 15000 })
  await win.locator('[role="gridcell"]').nth(6).dblclick()
  await win.keyboard.press('Meta+a')
  await win.keyboard.type('x')
  await win.keyboard.press('Enter')
  await win.waitForTimeout(300)
  await menuOf(3)
  await win.getByRole('menuitem', { name: 'Close tabs to the left', exact: true }).click()
  await win.getByRole('dialog').waitFor({ timeout: 3000 })
  check('unsaved edits among them: Save / Discard / Cancel first', (await win.getByRole('dialog').innerText()).includes('Save the changes to orders?'))
  await win.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
  await win.waitForTimeout(300)
  check('Cancel closes nothing', (await strip()).titles.length === 4)
  await win.getByRole('button', { name: 'Discard changes' }).click()
  await win.waitForTimeout(300)

  // Keyboard: the strip is one Tab stop; arrows select, Delete closes; the close buttons are out of the Tab order.
  await setTabs(4, false, 1)
  const tabStops = await win.evaluate(() => [...document.querySelectorAll('[role="tablist"] [tabindex="0"], [role="tablist"] button:not([tabindex="-1"])')].length)
  check('the strip is a single Tab stop (no hidden close buttons in the Tab order)', tabStops === 1, String(tabStops))
  await win.locator('[role="tab"][aria-selected="true"]').focus()
  await win.keyboard.press('ArrowRight')
  await win.waitForTimeout(200)
  s = await strip()
  const focused = await win.evaluate(() => document.activeElement?.getAttribute('aria-selected'))
  check('→ selects the next tab and moves the focus with it', s.active === 2 && focused === 'true')
  await win.keyboard.press('Delete')
  await win.waitForTimeout(300)
  check('Delete closes the focused tab', (await strip()).titles.length === 3)
  const closeOpacity = await win.evaluate(() => {
    const tab = document.querySelector('[role="tab"][aria-selected="true"]')
    tab.focus()
    return getComputedStyle(tab.querySelector('button[aria-label="Close tab"]')).opacity
  })
  check('the focused tab shows its close button', closeOpacity === '1', closeOpacity)

  // The empty part of the strip drags the window; the tabs and "+" don't.
  const regions = await win.evaluate(() => {
    const bar = document.querySelector('[role="tablist"]').parentElement
    const spacer = document.querySelector('[data-testid="new-tab"]').nextElementSibling
    return { bar: getComputedStyle(bar).webkitAppRegion ?? getComputedStyle(bar).getPropertyValue('-webkit-app-region'), strip: getComputedStyle(document.querySelector('[role="tablist"]')).getPropertyValue('-webkit-app-region'), plus: getComputedStyle(document.querySelector('[data-testid="new-tab"]')).getPropertyValue('-webkit-app-region'), spacerWidth: spacer.getBoundingClientRect().width, spacerInBar: bar.contains(spacer) }
  })
  check('the empty part after "+" drags the window', regions.bar === 'drag' && regions.spacerInBar && regions.spacerWidth > 100, JSON.stringify(regions))
  check('tabs and "+" do not drag it', regions.strip === 'no-drag' && regions.plus === 'no-drag', JSON.stringify(regions))

  // Without a selected connection "+" is still there and does what ⌘T does: the New connection form.
  await win.getByRole('button', { name: 'Home (all connections)' }).click()
  await win.waitForTimeout(400)
  s = await strip()
  check('Home with tabs open: "+" still clickable', s.plus)
  await win.locator('[data-testid="new-tab"]').click()
  await win.waitForTimeout(500)
  check('without a connection "+" opens New connection', await win.getByRole('dialog').filter({ hasText: 'New connection' }).isVisible())
  await win.keyboard.press('Escape')

  // The palette lists the open tabs; Enter switches.
  await setTabs(15, true, 0)
  await win.keyboard.press('Meta+k')
  await win.keyboard.type('order_items 14')
  await win.waitForTimeout(300)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(400)
  s = await strip()
  check('palette: an open tab found by name and switched to, in view', s.active === 13 && s.activeInView, String(s.active))
  await win.screenshot({ path: join(out, 'r116-strip.png') })
  console.log(errors.length ? `page errors: ${errors.join(' | ')}` : 'page errors: none')
} finally {
  await app.close()
}
