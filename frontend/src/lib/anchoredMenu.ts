import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

/** Space kept between the menu and the edge of the window. */
const EDGE = 8
/** Space between the menu and its button, as nexnotes'. */
const GAP = 4

/**
 * Where a menu at an anchor goes: fixed to the window, at the anchor, inside the window. Fixed and not absolute,
 * because the sidebar scrolls and would cut the menu off and grow a horizontal scrollbar (07.11.2026).
 */
export function useAnchoredMenu(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  menu: RefObject<HTMLElement | null>,
  { align = 'right', up = false }: { align?: 'left' | 'right'; up?: boolean } = {},
): CSSProperties {
  const [place, setPlace] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })
  useLayoutEffect(() => {
    if (!open) {
      setPlace({ position: 'fixed', visibility: 'hidden' })
      return
    }
    const at = anchor.current?.getBoundingClientRect()
    const box = menu.current?.getBoundingClientRect()
    if (!at || !box) return
    const width = window.innerWidth
    const height = window.innerHeight
    const left = Math.max(EDGE, Math.min(align === 'right' ? at.right - box.width : at.left, width - box.width - EDGE))
    let top = up ? at.top - box.height - GAP : at.bottom + GAP
    if (!up && top + box.height > height - EDGE) top = at.top - box.height - GAP
    if (top < EDGE) top = Math.min(at.bottom + GAP, height - box.height - EDGE)
    setPlace({ position: 'fixed', left, top: Math.max(EDGE, top) })
  }, [open, anchor, menu, align, up])
  return place
}
