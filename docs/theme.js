// Light, dark or the system's choice, remembered on this device. Loaded in <head> so the page never flashes.
;(() => {
  const root = document.documentElement
  const saved = () => {
    try {
      return localStorage.getItem('theme') ?? 'system'
    } catch {
      return 'system'
    }
  }
  const apply = (choice) => {
    if (choice === 'light' || choice === 'dark') root.dataset.theme = choice
    else delete root.dataset.theme
    document.querySelectorAll('.theme-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.choice === choice)))
  }
  apply(saved())
  document.addEventListener('DOMContentLoaded', () => {
    apply(saved())
    document.querySelectorAll('.theme-toggle button').forEach((b) =>
      b.addEventListener('click', () => {
        try {
          if (b.dataset.choice === 'system') localStorage.removeItem('theme')
          else localStorage.setItem('theme', b.dataset.choice)
        } catch {
          // Private window: the choice lasts until the page is closed.
        }
        apply(b.dataset.choice)
      }),
    )
  })
})()
