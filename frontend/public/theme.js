// Before the first paint: otherwise the dark side briefly flashes when "light" is set.
// Own file instead of an inline script, because the server's Content Security Policy only allows its own files.
try {
  var mode = localStorage.getItem('nextasks.theme')
  var light =
    // Nobody chose yet (the sign-in page of a new browser), or the system was chosen: as the system is set.
    mode === 'system' || mode === null
      ? window.matchMedia('(prefers-color-scheme: light)').matches
      : mode === 'light'
  if (light) document.documentElement.setAttribute('data-theme', 'light')
  // The frame of the installed app in the ground of the mode that shows (both entries, light and dark).
  var metas = document.querySelectorAll('meta[name="theme-color"]')
  for (var i = 0; i < metas.length; i++) metas[i].content = light ? '#f4f6f7' : '#0f1417'
} catch (e) {
  /* private mode without localStorage */
}
