/**
 * Builds the note editor alone for the iPhone and iPad app (vite.note.config.ts) into dist-note/ and writes
 * dist-note/manifest.json beside it: the version of nextasks, the commit, and the sha256 of every file. The app copies
 * the folder into its bundle with its tools/editor-paket.sh (nextasks-ios, docs/editor-bruecke.md).
 *
 * It refuses a build the app could not open from a file:// URL (a module script, an address starting at the root)
 * and one that could reach out (an address with http in the script or the styles' url()).
 *
 *   node scripts/note-app-pack.mjs
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const out = path.join(frontend, 'dist-note')

const vite = path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js')
const built = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.note.config.ts'], { cwd: frontend, stdio: 'inherit' })
if (built.status !== 0) process.exit(built.status ?? 1)

const version = /__version__\s*=\s*"([^"]+)"/.exec(fs.readFileSync(path.join(frontend, '..', 'backend', 'app', '__init__.py'), 'utf8'))[1]
const git = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: frontend, encoding: 'utf8' })
const commit = git.status === 0 ? git.stdout.trim() : 'unknown'

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    return entry.isDirectory() ? walk(full) : [full]
  })
}

const html = fs.readFileSync(path.join(out, 'note-app.html'), 'utf8')
const problems = []
if (/type="module"/.test(html)) problems.push('note-app.html loads a module script')
if (/\s(?:src|href)="\/(?!\/)/.test(html)) problems.push('note-app.html has an address starting at the root')
if (!/img-src nextasks-file: data:;/.test(html)) problems.push('note-app.html lost its Content Security Policy')
for (const file of walk(out).filter((name) => name.endsWith('.css'))) {
  const css = fs.readFileSync(file, 'utf8')
  if (/url\(\s*["']?\/(?!\/)/.test(css)) problems.push(`${path.relative(out, file)} has an address starting at the root`)
  if (/url\(\s*["']?https?:/.test(css)) problems.push(`${path.relative(out, file)} loads from the net`)
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}

const files = {}
let bytes = 0
for (const file of walk(out).sort()) {
  const name = path.relative(out, file).split(path.sep).join('/')
  if (name === 'manifest.json') continue
  const data = fs.readFileSync(file)
  bytes += data.length
  files[name] = createHash('sha256').update(data).digest('hex')
}
const manifest = { name: 'nextasks-note', version, commit, entry: 'note-app.html', files }
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`dist-note: nextasks ${version} (${commit}), ${Object.keys(files).length} files, ${(bytes / 1024).toFixed(0)} KB`)
