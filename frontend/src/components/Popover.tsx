import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useAnchoredMenu } from '../lib/anchoredMenu'

/**
 * A button with a menu under it, as nexnotes' `Menu`: the card of the one menu (`.nt-menu`), 4 px from its button. The
 * first entry takes the focus, the arrow keys go through the entries, Home and End to the first and last; Escape, Tab,
 * a click elsewhere and choosing (items call `close`) close it, and the focus goes back to the button.
 *
 * The menu is fixed to the window, not to the button's box: inside the sidebar it was cut off by the sidebar's own
 * scrolling and pushed a horizontal scrollbar into it. It opens at the button and stays inside the window.
 */
export function Popover({
  button,
  label,
  children,
  align = 'right',
  className = '',
  up = false,
}: {
  button: ReactNode
  label: string
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  className?: string
  up?: boolean
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const opener = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const place = useAnchoredMenu(open, root, menu, { align, up })
  const placed = open && place.visibility !== 'hidden'

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const gone = () => setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('resize', gone)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('resize', gone)
    }
  }, [open])

  // The first entry takes the focus once the menu stands where it belongs.
  useEffect(() => {
    if (placed) menu.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus({ preventScroll: true })
  }, [placed])

  const keys = (event: KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => items[(index + items.length) % items.length]?.focus()
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(items.length - 1)
    else if (event.key === 'Escape' || event.key === 'Tab') {
      setOpen(false)
      opener.current?.focus()
    } else return
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <div ref={root} className="relative">
      <button ref={opener} type="button" aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} className={className}>
        {button}
      </button>
      {open && (
        <div ref={menu} role="menu" aria-label={label} className="nt-menu" style={place} onKeyDown={keys}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
