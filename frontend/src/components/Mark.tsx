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
