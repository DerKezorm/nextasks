import { avatarUrl } from '../api/client'
import { avatarPlaceholder } from '../vendor/nexkonten/konten'

const COLORS = ['#60a5fa', '#f472b6', '#4ade80', '#fbbf24', '#a78bfa', '#2dd4bf', '#fb923c', '#f87171']

/** Everyone gets a colour of their own, the same in every browser: it comes from the name (as in nexcanvas). */
// eslint-disable-next-line react-refresh/only-export-components
export function personColor(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]
}

/** A picture's stand-in as the account module draws it everywhere (server, iPhone, the operator's list): the first
 * letter of the shown name on a hue from that name, saturation, lightness and text colour from the kit's variables. */
// eslint-disable-next-line react-refresh/only-export-components
export function placeholder(shown: string): { letter: string; style: { background: string; color: string } } {
  const { letter, hue } = avatarPlaceholder(shown)
  return {
    letter,
    style: {
      background: `hsl(${hue} var(--nexui-avatar-saturation) var(--nexui-avatar-lightness))`,
      color: 'var(--nexui-avatar-text)',
    },
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
  const stand = placeholder(shown)
  return (
    <span title={shown} className={classes} style={stand.style}>
      {person.gone ? '?' : stand.letter}
    </span>
  )
}
