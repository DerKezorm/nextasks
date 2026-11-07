import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useAnchoredMenu } from '../lib/anchoredMenu'

/**
 * A button with a menu under it. Closes on a click elsewhere, on Escape and after choosing (items call `close`).
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
  const menu = useRef<HTMLDivElement>(null)
  const place = useAnchoredMenu(open, root, menu, { align, up })

  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      const target = e.target as Node
      if (!root.current?.contains(target) && !menu.current?.contains(target)) setOpen(false)
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const gone = () => setOpen(false)
    window.addEventListener('pointerdown', away)
    window.addEventListener('keydown', key)
    window.addEventListener('resize', gone)
    return () => {
      window.removeEventListener('pointerdown', away)
      window.removeEventListener('keydown', key)
      window.removeEventListener('resize', gone)
    }
  }, [open])


  return (
    <div ref={root} className="relative">
      <button type="button" aria-label={label} title={label} aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen((v) => !v)} className={className}>
        {button}
      </button>
      {open && (
        <div ref={menu} role="menu" className="nc-menu" style={place}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}
