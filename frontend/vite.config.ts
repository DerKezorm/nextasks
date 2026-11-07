import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Where the proxy points. It can be redirected via NEXTASKS_API.
const apiTarget = process.env.NEXTASKS_API || 'http://127.0.0.1:8510'

/** Milkdown and the Markdown and ProseMirror packages it needs: left to the chunk of the lazily loaded note editor. */
const EDITOR = /[\\/]node_modules[\\/](@milkdown|prosemirror-|remark-|micromark|mdast-|unist-|unified|vfile|@ocavue|orderedmap|rope-sequence|w3c-keyname|decode-named-character-reference|character-entities|markdown-table|ccount|longest-streak|zwitch|bail|trough|devlop|is-plain-obj|extend|escape-string-regexp|nanoid|tslib|lodash)/

/** The tab's icon with its checksum in the address. A browser keeps a tab icon per address and does not ask again,
 * so an icon that changed under the same address stayed old in the tab (nextasks showed the nexcanvas shapes from its
 * start long after, found 06.10.2026). */
function iconWithChecksum(): Plugin {
  return {
    name: 'icon-with-checksum',
    transformIndexHtml(html) {
      const sum = createHash('sha256').update(readFileSync(new URL('./public/logo.svg', import.meta.url))).digest('hex').slice(0, 12)
      return html.replace('href="/logo.svg"', `href="/logo.svg?v=${sum}"`)
    },
  }
}

/** The files the service worker keeps for the installed app, besides the start page: everything built under
 * assets/ and the shell's own files from public/. */
function shellFiles(dist: string): string[] {
  const own = ['/manifest.webmanifest', '/theme.js', '/logo.svg', ...readdirSync(join(dist, 'icons')).map((name) => `/icons/${name}`)]
  const built = readdirSync(join(dist, 'assets')).map((name) => `/assets/${name}`)
  return [...own, ...built].sort()
}

/** Writes the build's stamp and its files into dist/sw.js (public/sw.js has placeholders). A new build is a new
 * worker, so an open page learns of it and offers to reload; the stamp names the cache it keeps the files in. */
function serviceWorker(): Plugin {
  let dist = ''
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved(config) {
      dist = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const worker = join(dist, 'sw.js')
      if (!existsSync(worker)) return
      const files = shellFiles(dist)
      const stamp = createHash('sha256').update(readFileSync(join(dist, 'index.html'))).update(files.join('\n')).digest('hex').slice(0, 16)
      const source = readFileSync(worker, 'utf8')
      const written = source.replace("'__NEXTASKS_BUILD__'", JSON.stringify(stamp)).replace('/* __NEXTASKS_SHELL__ */ []', JSON.stringify(files))
      if (written === source || written.includes('__NEXTASKS_')) throw new Error('sw.js: the placeholders of the build are missing')
      writeFileSync(worker, written)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), iconWithChecksum(), serviceWorker()],
  build: {
    rollupOptions: {
      output: {
        // Libraries change rarely. In their own file, they stay cached in the browser after an update.
        // The note editor (Milkdown and what it brings) stays out of it: it loads only when a detail opens.
        manualChunks(id) {
          if (EDITOR.test(id)) return undefined
          if (id.includes('node_modules')) return 'vendor'
          return undefined
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    css: false,
    // e2e/: Playwright's own run (npm run e2e), not vitest's.
    exclude: ['node_modules/**', 'dist/**', 'e2e/**'],
  },
  server: {
    // Fixed port: if it is taken, Vite aborts instead of silently falling back to another one.
    port: 5510,
    strictPort: true,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: false },
    },
  },
  preview: {
    port: 5510,
    strictPort: true,
  },
})
