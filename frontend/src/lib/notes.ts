/** The note of a task is Markdown (data model, "Notiz (Markdown, seit 07.11.2026)"). */

export const NOTES_MAX = 20_000
/** From here on the field says how much room is left. */
export const NOTES_WARN = 19_000
/** Saved this long after typing stops. */
export const SAVE_AFTER_MS = 800

/** The ids of attachments a note shows as pictures (`![Name](attachment:<uuid>)`). */
export function picturedIn(notes: string): Set<string> {
  return new Set([...notes.matchAll(/!\[[^\]]*\]\(attachment:([0-9a-fA-F-]{36})\)/g)].map((m) => m[1].toLowerCase()))
}

const PICTURE: Record<string, string> = { de: '[Bild]', en: '[Image]' }
/** Letters and digits a `_` mark must not touch: the same class as on the server, not `\w` (which differs). */
const WORD = '0-9A-Za-zÀ-ÖØ-öø-ÿ'
const OPEN = ''
const SHUT = ''

const FENCE = /^ {0,3}(`{3,}|~{3,})/
const QUOTE = /^ {0,3}> ?/
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const SETEXT = /^ {0,3}=+[ \t]*$/
const HEADING = /^ {0,3}#{1,6}(?:[ \t]+|$)/
const HEADING_END = /[ \t]+#+[ \t]*$/
const LIST = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/
const TASK = /^\[([ xX])\][ \t]+/
const CODE = /(`+)(.+?)\1/g
const ESCAPE = /\\([!-/:-@[-`{-~])/g
const IMAGE = /!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g
const LINK = /\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g
const AUTOLINK = /<((?:https?:\/\/|mailto:)[^>\s]+)>/g
const KEPT = new RegExp(`${OPEN}(\\d+)${SHUT}`, 'g')
const MARKS = [
  /\*\*(?=\S)(.+?)(?<=\S)\*\*/g,
  new RegExp(`(?<![${WORD}])__(?=\\S)(.+?)(?<=\\S)__(?![${WORD}])`, 'g'),
  /~~(?=\S)(.+?)(?<=\S)~~/g,
  /\*(?=\S)(.+?)(?<=\S)\*/g,
  new RegExp(`(?<![${WORD}])_(?=\\S)(.+?)(?<=\\S)_(?![${WORD}])`, 'g'),
]

function inline(source: string, picture: string): string {
  const kept: string[] = []
  const keep = (value: string) => {
    kept.push(value)
    return `${OPEN}${kept.length - 1}${SHUT}`
  }
  let text = source.replace(CODE, (_all, _ticks: string, inner: string) => keep(inner.length > 1 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() ? inner.slice(1, -1) : inner))
  text = text.replace(ESCAPE, (_all, char: string) => keep(char))
  text = text.replace(IMAGE, () => keep(picture))
  text = text.replace(LINK, (_all, label: string, url: string) => label || keep(url))
  text = text.replace(AUTOLINK, (_all, url: string) => keep(url.replace(/^mailto:/, '')))
  for (const mark of MARKS) {
    let before: string | null = null
    while (before !== text) {
      before = text
      text = text.replace(mark, '$1')
    }
  }
  while (text.includes(OPEN)) text = text.replace(KEPT, (_all, n: string) => kept[Number(n)])
  return text
}

/**
 * The note without Markdown, for search, notifications and previews: marks gone, a picture "[Bild]" ("[Image]"
 * outside German), a link its text, a task box ☐ or ☑. The same rule as the server's `services/notetext.py`;
 * both pass `pruefsaetze/notiz-klartext.json`.
 */
export function plainNotes(notes: string, language = 'de'): string {
  const picture = PICTURE[(language || '').slice(0, 2)] ?? PICTURE.en
  const out: string[] = []
  let fence: string | null = null
  for (let line of notes.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if (fence !== null) {
      const opened = FENCE.exec(line)
      const mark: string = fence
      if (opened && opened[1][0] === mark[0] && opened[1].length >= mark.length && !line.trim().replaceAll(mark[0], '')) fence = null
      else out.push(line.trimEnd())
      continue
    }
    const opened = FENCE.exec(line)
    if (opened) {
      fence = opened[1]
      continue
    }
    while (QUOTE.test(line)) line = line.replace(QUOTE, '')
    if (BREAK.test(line) || SETEXT.test(line)) {
      out.push('')
      continue
    }
    if (HEADING.test(line)) line = line.replace(HEADING, '').replace(HEADING_END, '')
    const listed = LIST.exec(line)
    if (listed) {
      line = line.slice(listed[0].length)
      const task = TASK.exec(line)
      if (task) line = (task[1] === ' ' ? '☐ ' : '☑ ') + line.slice(task[0].length)
    }
    line = inline(line.trim(), picture)
    if (line.endsWith('\\')) line = line.slice(0, -1)
    out.push(line.trimEnd())
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
