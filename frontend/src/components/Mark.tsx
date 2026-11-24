/**
 * The look of a list, a space or an own filter, as nexnotes shows a folder (`FolderMark`): its symbol in its colour,
 * without a tile behind it. In the head of a page the symbol stands on a tile tinted with the colour (nexnotes'
 * `ListHead`).
 */
import { createElement } from 'react'

import { colorOf, iconFor } from '../lib/look'

export function Mark({ color, icon, size = 14, label }: { color: string; icon: string; size?: number; label?: string }) {
  return createElement(iconFor(icon), {
    className: 'shrink-0',
    style: { width: size, height: size, color: colorOf(color) },
    strokeWidth: 2,
    role: label ? 'img' : undefined,
    'aria-label': label,
    'aria-hidden': label ? undefined : true,
    'data-mark': icon,
  } as Parameters<typeof createElement>[1])
}

/** The symbol on a tile tinted with its colour: the head of a list or a filter. */
export function MarkTile({ color, icon }: { color: string; icon: string }) {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px]" style={{ background: `color-mix(in srgb, ${colorOf(color)} 16%, transparent)` }} data-mark-tile>
      <Mark color={color} icon={icon} size={17} />
    </span>
  )
}

/**
 * The plaque of a list (docs "Aussehen", principle 2): a rounded square in the list's colour (corners about 28 % of
 * its edge) with the symbol in white. The rows of the sidebar carry it.
 */
export function Plaque({ color, icon, size = 22 }: { color: string; icon: string; size?: number }) {
  const inner = Math.round(size * 0.6)
  return (
    <span className="grid shrink-0 place-items-center" style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), background: colorOf(color) }} data-plaque>
      {createElement(iconFor(icon), {
        style: { width: inner, height: inner, color: '#ffffff' },
        strokeWidth: 2.2,
        'aria-hidden': true,
        'data-mark': icon,
      } as Parameters<typeof createElement>[1])}
    </span>
  )
}
