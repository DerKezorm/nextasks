import { createElement } from 'react'

import { colorOf, iconFor } from '../lib/look'

const SIZES = {
  // 20 px in tight places, 28 px in rows, 36 px in the head of a list (docs "Aussehen", principle 2).
  xs: { box: 'h-5 w-5 rounded-[6px]', glyph: 'h-3 w-3' },
  sm: { box: 'h-7 w-7 rounded-lg', glyph: 'h-4 w-4' },
  md: { box: 'h-7 w-7 rounded-lg', glyph: 'h-4 w-4' },
  lg: { box: 'h-9 w-9 rounded-[10px]', glyph: 'h-5 w-5' },
} as const

/** The plaque of a list: a rounded square in the list's colour with its symbol in white. */
export function Badge({ color, icon, size = 'md', label }: { color: string; icon: string; size?: keyof typeof SIZES; label?: string }) {
  const { box, glyph } = SIZES[size]
  return (
    <span className={`grid shrink-0 place-items-center text-white ${box}`} style={{ background: colorOf(color) }} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-plaque>
      {createElement(iconFor(icon), { className: glyph, strokeWidth: 2.2 })}
    </span>
  )
}

/** Where there is no room for a plaque (the line under a task): a small square in the list's colour. */
export function ListDot({ color }: { color: string }) {
  return <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(color) }} aria-hidden />
}
