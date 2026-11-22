// The page's small behaviors: the product diagram (drag, lines), the appearance swatches, sharing, copying.
// Everything here is an addition: without this file every link works and the diagram shows its default layout.

// --- Diagram geometry (the same numbers and routes as the app's ER diagram) -------------------------------------
// [route:start]
const DG = { header: 32, row: 24, width: 200 }
const anchorY = (n, i) => n.y + 1 + DG.header + i * DG.row + DG.row / 2
// SVG path through orthogonal points with rounded corners (the app's roundedPath).
const roundedPath = (points, radius = 6) => {
  let d = `M ${points[0][0]} ${points[0][1]}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const r = Math.min(radius, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(c[0] - b[0], c[1] - b[1]) / 2)
    const before = [b[0] - Math.sign(b[0] - a[0]) * r, b[1] - Math.sign(b[1] - a[1]) * r]
    const after = [b[0] + Math.sign(c[0] - b[0]) * r, b[1] + Math.sign(c[1] - b[1]) * r]
    d += ` L ${before[0]} ${before[1]} Q ${b[0]} ${b[1]} ${after[0]} ${after[1]}`
  }
  const last = points[points.length - 1]
  return `${d} L ${last[0]} ${last[1]}`
}
// From a child's foreign key row to the parent's key row: out of the facing sides, or around the right when the
// tables overlap horizontally.
const route = (child, ci, parent, pi) => {
  const cy = anchorY(child, ci)
  const py = anchorY(parent, pi)
  const cr = child.x + DG.width
  const pr = parent.x + DG.width
  let pts
  if (cr + 24 <= parent.x) {
    const mid = (cr + parent.x) / 2
    pts = [[cr, cy], [mid, cy], [mid, py], [parent.x, py]]
  } else if (pr + 24 <= child.x) {
    const mid = (child.x + pr) / 2
    pts = [[child.x, cy], [mid, cy], [mid, py], [pr, py]]
  } else {
    const x = Math.max(cr, pr) + 26
    pts = [[cr, cy], [x, cy], [x, py], [pr, py]]
  }
  if (Math.abs(cy - py) < 0.5) pts = [pts[0], pts[3]]
  return roundedPath(pts, 6)
}
// [route:end]

;(() => {
  const reduce = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const dg = document.querySelector('.dg')
  if (dg) {
    const box = dg.querySelector('.dg-box')
    const nodes = new Map([...dg.querySelectorAll('.node')].map((el) => [el.dataset.node, el]))
    const pos = (el) => ({ x: Number(el.style.getPropertyValue('--x')), y: Number(el.style.getPropertyValue('--y')) })
    const initial = new Map([...nodes].map(([k, el]) => [k, pos(el)]))
    const lines = [...dg.querySelectorAll('.dg-lines path[data-from]')]
    const rowIndex = (ref) => {
      const [n, col] = ref.split('.')
      const items = [...nodes.get(n).querySelectorAll('li')]
      return items.findIndex((li) => li.dataset.col === col)
    }
    const redraw = (only) => {
      for (const p of lines) {
        const [from, to] = [p.dataset.from, p.dataset.to]
        if (only && !from.startsWith(`${only}.`) && !to.startsWith(`${only}.`)) continue
        p.setAttribute('d', route(pos(nodes.get(from.split('.')[0])), rowIndex(from), pos(nodes.get(to.split('.')[0])), rowIndex(to)))
      }
    }
    const reset = dg.querySelector('.dg-reset')
    const absolute = () => window.matchMedia('(min-width: 768px)').matches
    const move = (key, x, y) => {
      const el = nodes.get(key)
      const w = box.clientWidth - DG.width
      const h = box.clientHeight - el.offsetHeight
      const snap = (v) => Math.round(v / 8) * 8
      el.style.setProperty('--x', String(Math.max(0, Math.min(w, snap(x)))))
      el.style.setProperty('--y', String(Math.max(0, Math.min(h, snap(y)))))
      redraw(key)
      reset.hidden = false
    }
    // On a canvas every table is open and its header moves it; on phones the header folds the table.
    const placeTables = () => {
      const canvas = absolute()
      dg.classList.toggle('movable', canvas)
      if (canvas) nodes.forEach((el) => (el.open = true))
    }
    placeTables()
    window.matchMedia('(min-width: 768px)').addEventListener('change', placeTables)
    for (const [key, el] of nodes) {
      const handle = el.querySelector('.node-h')
      handle.addEventListener('click', (e) => {
        if (absolute()) e.preventDefault()
      })
      handle.addEventListener('pointerdown', (e) => {
        if (!absolute() || e.button !== 0) return
        e.preventDefault()
        handle.setPointerCapture(e.pointerId)
        const start = { px: e.clientX, py: e.clientY, ...pos(el) }
        dg.classList.add('dragging')
        el.classList.add('lifted')
        const onMove = (ev) => move(key, start.x + ev.clientX - start.px, start.y + ev.clientY - start.py)
        const onUp = () => {
          handle.removeEventListener('pointermove', onMove)
          dg.classList.remove('dragging')
          el.classList.remove('lifted')
        }
        handle.addEventListener('pointermove', onMove)
        handle.addEventListener('pointerup', onUp, { once: true })
        handle.addEventListener('pointercancel', onUp, { once: true })
      })
      handle.addEventListener('keydown', (e) => {
        const step = e.shiftKey ? 32 : 8
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key]
        if (!d || !absolute()) return
        e.preventDefault()
        const p = pos(el)
        move(key, p.x + d[0], p.y + d[1])
      })
      // A row shows its relationship: the lines attached to it get the active stroke.
      for (const li of el.querySelectorAll('li')) {
        const ref = `${key}.${li.dataset.col}`
        const mine = lines.filter((p) => p.dataset.from === ref || p.dataset.to === ref)
        if (!mine.length) continue
        const on = (v) => mine.forEach((p) => p.classList.toggle('active', v))
        li.addEventListener('pointerenter', () => on(true))
        li.addEventListener('pointerleave', () => on(false))
        li.addEventListener('focusin', () => on(true))
        li.addEventListener('focusout', () => on(false))
      }
    }
    reset.addEventListener('click', () => {
      for (const [key, p] of initial) {
        nodes.get(key).style.setProperty('--x', String(p.x))
        nodes.get(key).style.setProperty('--y', String(p.y))
      }
      redraw()
      reset.hidden = true
    })
    // The one moment on the page: the relationships draw in once, the spine first.
    if (!reduce() && absolute()) {
      lines.forEach((p, i) => {
        const len = p.getTotalLength()
        const ms = 360
        const delay = 120 + i * 110
        p.style.strokeDasharray = `${len}`
        p.style.strokeDashoffset = `${len}`
        p.dataset.markers = `${p.getAttribute('marker-start')}|${p.getAttribute('marker-end')}`
        p.removeAttribute('marker-start')
        p.removeAttribute('marker-end')
        p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: ms, delay, easing: 'cubic-bezier(.3,0,.2,1)', fill: 'forwards' }).finished.then(() => {
          p.style.strokeDasharray = ''
          p.style.strokeDashoffset = ''
          const [s, e] = p.dataset.markers.split('|')
          p.setAttribute('marker-start', s)
          p.setAttribute('marker-end', e)
        })
      })
    }
  }

  // --- Make it yours: the six accents and the six looks, one choice as in the app ------------------------------
  const root = document.documentElement
  const swatches = document.querySelector('.swatches')
  if (swatches) {
    swatches.hidden = false
    const accents = [...swatches.querySelectorAll('[data-accent]')]
    const looks = [...swatches.querySelectorAll('[data-look]')]
    const hint = document.querySelector('.look-hint')
    const theme = [...document.querySelectorAll('.theme-toggle button')]
    const choose = (accent, look) => {
      for (const b of accents) {
        root.classList.toggle(`accent-${b.dataset.accent}`, b.dataset.accent === accent && accent !== 'violet')
        b.setAttribute('aria-pressed', String(b.dataset.accent === accent))
      }
      for (const b of looks) {
        root.classList.toggle(`look-${b.dataset.look}`, b.dataset.look === look)
        b.setAttribute('aria-pressed', String(b.dataset.look === look))
      }
      // A look has its own colors: light / dark doesn't apply to it (the app says the same).
      hint.hidden = !look
      theme.forEach((t) => (t.disabled = Boolean(look)))
    }
    accents.forEach((b) => b.addEventListener('click', () => choose(b.dataset.accent, null)))
    // Pressing the look that is on turns it off again.
    looks.forEach((b) => b.addEventListener('click', () => (b.getAttribute('aria-pressed') === 'true' ? choose('violet', null) : choose(null, b.dataset.look))))
  }

  // --- Phones: send yourself the link -------------------------------------------------------------------------
  const share = document.getElementById('share')
  if (share && navigator.share) {
    share.addEventListener('click', (e) => {
      e.preventDefault()
      navigator.share({ title: 'DB Mastermind', text: 'A free, open-source database client and data modeler for Windows, macOS and Linux.', url: 'https://dbmastermind.app/' }).catch(() => {})
    })
  }

  // --- Copy buttons on code blocks ----------------------------------------------------------------------------
  // The icon turns into a check for a moment; a screen reader hears it through one polite live region.
  const buttons = document.querySelectorAll('button.copy')
  if (navigator.clipboard && buttons.length) {
    const status = document.createElement('p')
    status.className = 'sr-only'
    status.setAttribute('aria-live', 'polite')
    document.body.append(status)
    for (const button of buttons) {
      button.hidden = false
      let timer
      button.addEventListener('click', async () => {
        const code = document.getElementById(button.dataset.copy)
        clearTimeout(timer)
        try {
          await navigator.clipboard.writeText(code.textContent)
          button.classList.add('done')
          status.textContent = 'Copied'
        } catch {
          status.textContent = 'Copying is blocked here: select the text and copy it'
        }
        timer = setTimeout(() => {
          button.classList.remove('done')
          status.textContent = ''
        }, 1500)
      })
    }
  }

  // --- 404: name the address that has no page -----------------------------------------------------------------
  const missing = document.getElementById('missing-path')
  if (missing) missing.textContent = `path = '${decodeURIComponent(location.pathname)}'`
})()
