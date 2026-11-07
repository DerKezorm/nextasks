import { avatarUrl } from '../api/client'

const COLORS = ['#60a5fa', '#f472b6', '#4ade80', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#f87171']

/** Everyone gets a colour of their own, the same in every browser: it comes from the name (as in nexcanvas). */
// eslint-disable-next-line react-refresh/only-export-components
export function personColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

/** The round letter: a tint of the person's colour behind, the colour mixed with the text colour in front. The pure
 * colour on its tint read 1.2 to 1.9 to 1 in the light theme (Prüfgang G7); mixed, it is 5 to 1 or more in both. */
// eslint-disable-next-line react-refresh/only-export-components
export function letterColors(color: string): { background: string; color: string } {
  return {
    background: `color-mix(in srgb, ${color} 24%, var(--color-ink-850))`,
    color: `color-mix(in srgb, ${color} 45%, var(--color-mist-100))`,
  }
}

/** A person as their picture, or a round letter in their colour, as nexlore shows accounts. */
export function Avatar({
  person,
  className = 'h-8 w-8 text-sm',
  ring = false,
}: {
  person: { id: number; name: string; display_name?: string; avatar: string | null; gone?: boolean }
  className?: string
  ring?: boolean
}) {
  const shown = person.display_name || person.name
  const classes = 'grid shrink-0 place-items-center overflow-hidden rounded-full font-semibold ' + (ring ? 'ring-2 ring-ink-950 ' : '') + className
  const url = avatarUrl(person)
  if (url) return <img src={url} alt="" title={shown} className={classes + ' object-cover'} />
  const color = personColor(person.name)
  return (
    <span title={shown} className={classes} style={letterColors(color)}>
      {person.gone ? '?' : (shown.trim()[0] ?? '?').toUpperCase()}
    </span>
  )
}
