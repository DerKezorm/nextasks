/**
 * The note editor alone, for the iPhone and iPad app (nextasks-ios, docs/editor-bruecke.md): note-app.html into
 * dist-note/, every path relative (`base: './'`), so the app opens it from a file:// URL inside its bundle. One
 * classic script instead of a module (a module script does not load from file://), no React, no public/ folder.
 *
 *   node scripts/note-app-pack.mjs     builds this and writes dist-note/manifest.json
 */
import { defineConfig, type Plugin } from 'vite'

/** Vite writes `<script type="module" crossorigin>`; a file:// page would refuse both. A plain deferred script. */
function classicScript(): Plugin {
  return {
    name: 'nextasks-classic-script',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler: (html) => html.replace(/<script type="module" crossorigin /g, '<script defer ').replace(/ crossorigin(?=[ >])/g, ''),
    },
  }
}

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [classicScript()],
  build: {
    outDir: 'dist-note',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    target: 'es2022',
    rollupOptions: {
      input: { 'note-app': 'note-app.html' },
      output: { format: 'iife', inlineDynamicImports: true },
    },
  },
})
