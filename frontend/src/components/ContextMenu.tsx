/**
 * One context menu for the whole web: a right click (or Shift+F10, the menu key, a long press on a phone) on a task,
 * a list, a space, a section or an entry of the trash opens the entries that part offers. A card with rows, lines
 * between groups, submenus behind ▸ and the key on the right where there is one; at the edge of the window it turns
 * inwards. Up and down move, Enter or Space choose, right opens a submenu, left and Escape go back, the focus returns
 * to where it was. On a phone or after a long press it comes up from below as a sheet; a submenu then takes its place.
 * In a text field, or with text selected, the browser's own menu stays, so copying and pasting go on as before.
 */
import { Check, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react'
import { createContext, createElement, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref } from 'react'
import { useTranslation } from 'react-i18next'

export interface MenuEntry {
  label: string
  icon?: LucideIcon
  /** The key that does the same, shown on the right. */
  keys?: string
  /** Red: it deletes. */
  danger?: boolean
  /** A choice that is on or off (a check in front). */
  checked?: boolean
  disabled?: boolean
  /** A first choice turns the entry into this question; the second one does it. */
  confirm?: string
  /** Shows a small square in this colour in front (a list). */
  color?: string
  run?: () => void
  items?: MenuItems
}
export type MenuItems = (MenuEntry | 'line' | false | null | undefined)[]

interface Open {
  x: number
  y: number
  items: MenuEntry[][]
  sheet: boolean
  back: HTMLElement | null
}

const MenuContext = createContext<(open: Open) => void>(() => undefined)

/** Groups split at the lines, the empty ones and the left-out entries dropped. */
function groups(items: MenuItems): MenuEntry[][] {
  const out: MenuEntry[][] = [[]]
  for (const item of items) {
    if (item === 'line') out.push([])
    else if (item) out.at(-1)!.push(item)
  }
  return out.filter((group) => group.length)
}

const keepsBrowserMenu = (target: EventTarget | null) => {
  const el = target as HTMLElement | null
  if (el?.closest?.('input, textarea, select, [contenteditable="true"]')) return true
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== ''
}

const narrow = () => typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 639px)').matches

/**
 * The handlers that give an element its context menu: `{...useContextMenu(() => [...])}`. The entries are built when
 * the menu opens, so they show the state of that moment.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useContextMenu(build: () => MenuItems): { onContextMenu: (e: ReactMouseEvent<HTMLElement>) => void; onPointerDown: (e: ReactPointerEvent<HTMLElement>) => void; onPointerUp: () => void; onPointerMove: (e: ReactPointerEvent<HTMLElement>) => void; onPointerCancel: () => void } {
  const open = useContext(MenuContext)
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null)
  const touched = useRef(0)
  const stop = () => {
    if (press.current) clearTimeout(press.current.timer)
    press.current = null
  }
  const show = (target: HTMLElement, x: number, y: number, sheet: boolean) => {
    const items = groups(build())
    if (!items.length) return false
    const back = target.tabIndex >= 0 ? target : (document.activeElement as HTMLElement | null)
    open({ x, y, items, sheet: sheet || narrow(), back })
    return true
  }
  return {
    onContextMenu: (e) => {
      if (keepsBrowserMenu(e.target)) return
      // A long press already opened it (some phones send this event afterwards as well).
      if (Date.now() - touched.current < 800) {
        e.preventDefault()
        return
      }
      const fromKeys = e.clientX === 0 && e.clientY === 0
      const rect = e.currentTarget.getBoundingClientRect()
      if (show(e.currentTarget, fromKeys ? rect.left + 24 : e.clientX, fromKeys ? rect.top + Math.min(rect.height, 32) : e.clientY, false)) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onPointerDown: (e) => {
      if (e.pointerType !== 'touch' || keepsBrowserMenu(e.target)) return
      const target = e.currentTarget
      const { clientX: x, clientY: y } = e
      stop()
      press.current = {
        x,
        y,
        timer: setTimeout(() => {
          press.current = null
          if (show(target, x, y, true)) touched.current = Date.now()
        }, 500),
      }
    },
    onPointerMove: (e) => {
      if (press.current && Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > 8) stop()
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  }
}

/** Holds the one open menu; Shift+F10 and the menu key open the menu of the element in focus. */
export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [menu, setMenu] = useState<Open | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return
      const el = document.activeElement as HTMLElement | null
      if (!el || el === document.body || keepsBrowserMenu(el)) return
      e.preventDefault()
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 0, clientY: 0 }))
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])
  const close = useCallback(
    (focusBack = true) => {
      const back = menu?.back
      setMenu(null)
      if (focusBack && back?.isConnected) back.focus({ preventScroll: true })
    },
    [menu],
  )
  return (
    <MenuContext.Provider value={setMenu}>
      {children}
      {menu && <MenuView key={`${menu.x}:${menu.y}:${menu.sheet}`} menu={menu} onClose={close} />}
    </MenuContext.Provider>
  )
}

/** The entries of one card (the menu or a submenu). */
function Card({ items, onChoose, onBack, title, sheet, style, cardRef, level }: { items: MenuEntry[][]; onChoose: (entry: MenuEntry, row: HTMLElement) => void; onBack?: () => void; title?: string; sheet: boolean; style?: CSSProperties; cardRef?: Ref<HTMLDivElement>; level: number }) {
  const { t } = useTranslation()
  const [asking, setAsking] = useState<MenuEntry | null>(null)
  return (
    <div
      ref={cardRef}
      role="menu"
      aria-label={title}
      data-level={level}
      className={sheet ? 'nt-pop nt-sheet max-h-[75dvh] w-full overflow-y-auto rounded-t-2xl border-t border-ink-700 bg-ink-900 px-2 pt-2 shadow-2xl' : 'nt-menu fixed z-[70] max-h-[calc(100dvh-16px)] min-w-56 overflow-y-auto rounded-[10px] border border-ink-700 bg-ink-900 p-1 shadow-xl shadow-black/25'}
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      {sheet && <span className="mx-auto mb-2 block h-1 w-10 rounded-full bg-ink-600" aria-hidden />}
      {onBack && (
        <button type="button" role="menuitem" data-back className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-semibold text-accent-400 hover:bg-ink-800" onClick={onBack}>
          <ChevronLeft className="h-4 w-4" aria-hidden /> {title ?? t('menu.back')}
        </button>
      )}
      {items.map((group, g) => (
        <div key={g} role="group" className={g ? 'mt-1 border-t border-ink-700 pt-1' : ''}>
          {group.map((entry, n) => {
            const question = asking === entry
            const checkable = entry.checked !== undefined
            return (
              <button
                key={n}
                type="button"
                role={checkable ? 'menuitemcheckbox' : 'menuitem'}
                aria-checked={checkable ? entry.checked : undefined}
                aria-haspopup={entry.items ? 'menu' : undefined}
                disabled={entry.disabled}
                data-entry={entry.label}
                className={
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none disabled:opacity-40 ' +
                  (sheet ? 'py-2.5 ' : 'py-1.5 ') +
                  (entry.danger || question ? 'text-bad-500 hover:bg-bad-500/10 focus:bg-bad-500/10 ' : 'text-mist-100 hover:bg-ink-800 focus:bg-ink-800 ') +
                  (question ? 'font-semibold' : '')
                }
                onClick={(e) => {
                  if (entry.confirm && !question) {
                    setAsking(entry)
                    return
                  }
                  onChoose(entry, e.currentTarget)
                }}
              >
                <span className="grid w-4 shrink-0 place-items-center text-mist-500" aria-hidden>
                  {checkable ? entry.checked && <Check className="h-4 w-4 text-accent-400" /> : entry.color ? <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: entry.color }} /> : entry.icon && createElement(entry.icon, { className: 'h-4 w-4 ' + (entry.danger ? 'text-bad-500' : '') })}
                </span>
                <span className="min-w-0 flex-1 truncate">{question ? entry.confirm : entry.label}</span>
                {entry.keys && !sheet && <kbd className="ml-3">{entry.keys}</kbd>}
                {entry.items && <ChevronRight className="h-4 w-4 shrink-0 text-mist-500" aria-hidden />}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}

const rowsOf = (card: HTMLElement | null) => [...(card?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? [])]

function MenuView({ menu, onClose }: { menu: Open; onClose: (focusBack?: boolean) => void }) {
  // The path of open submenus: for each, the entry it belongs to and where its row sits.
  const [path, setPath] = useState<{ entry: MenuEntry; row: DOMRect }[]>([])
  const cards = useRef<(HTMLDivElement | null)[]>([])
  const levels = useMemo(() => [menu.items, ...path.map(({ entry }) => groups(entry.items ?? []))], [menu.items, path])

  // Where each card goes: by the pointer or beside its row, turned inwards at the edges of the window.
  useLayoutEffect(() => {
    if (menu.sheet) return
    levels.forEach((_, level) => {
      const card = cards.current[level]
      if (!card) return
      const { width, height } = card.getBoundingClientRect()
      const W = window.innerWidth
      const H = window.innerHeight
      let left: number
      let top: number
      if (level === 0) {
        left = menu.x + width > W - 8 ? Math.max(8, menu.x - width) : menu.x
        top = menu.y + height > H - 8 ? Math.max(8, H - 8 - height) : menu.y
      } else {
        const row = path[level - 1].row
        left = row.right + width > W - 8 ? Math.max(8, row.left - width) : row.right
        top = Math.max(8, Math.min(row.top - 5, H - 8 - height))
      }
      card.style.left = `${left}px`
      card.style.top = `${top}px`
    })
  }, [levels, menu.x, menu.y, menu.sheet, path])

  // The focus goes to the first entry of the card that just opened.
  useEffect(() => {
    const level = levels.length - 1
    const card = menu.sheet ? cards.current[0] : cards.current[level]
    const rows = rowsOf(card)
    ;(rows.find((row) => !row.hasAttribute('data-back')) ?? rows[0])?.focus({ preventScroll: true })
  }, [levels.length, menu.sheet])

  // A click elsewhere, scrolling or a new size of the window close it.
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!cards.current.some((card) => card?.contains(e.target as Node))) onClose(false)
    }
    const gone = () => onClose(false)
    window.addEventListener('pointerdown', away, true)
    window.addEventListener('resize', gone)
    return () => {
      window.removeEventListener('pointerdown', away, true)
      window.removeEventListener('resize', gone)
    }
  }, [onClose])

  const choose = (entry: MenuEntry, row: HTMLElement, level: number) => {
    if (entry.items) {
      setPath((p) => [...p.slice(0, level), { entry, row: row.getBoundingClientRect() }])
      return
    }
    onClose()
    entry.run?.()
  }

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const level = menu.sheet ? 0 : Math.max(0, cards.current.findIndex((card) => card?.contains(document.activeElement)))
    const card = menu.sheet ? cards.current[0] : cards.current[level]
    const rows = rowsOf(card)
    const at = rows.indexOf(document.activeElement as HTMLButtonElement)
    const back = () => {
      const opener = path[path.length - 1]?.entry.label
      setPath((p) => p.slice(0, -1))
      setTimeout(() => rowsOf(menu.sheet ? cards.current[0] : cards.current[level - 1]).find((row) => row.dataset.entry === opener)?.focus(), 0)
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus()
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      rows[e.key === 'Home' ? 0 : rows.length - 1]?.focus()
    } else if (e.key === 'ArrowRight') {
      const row = rows[at]
      if (row?.getAttribute('aria-haspopup')) {
        e.preventDefault()
        row.click()
      }
    } else if (e.key === 'ArrowLeft' && path.length) {
      e.preventDefault()
      back()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (path.length) back()
      else onClose()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      onClose()
    }
  }

  if (menu.sheet) {
    const level = levels.length - 1
    return (
      <div className="nt-veil fixed inset-0 z-[70] flex items-end" onKeyDown={onKey} data-testid="context-menu">
        <Card
          cardRef={(el) => {
            cards.current[0] = el
          }}
          items={levels[level]}
          sheet
          level={level}
          title={path.at(-1)?.entry.label}
          onBack={level ? () => setPath((p) => p.slice(0, -1)) : undefined}
          onChoose={(entry, row) => choose(entry, row, level)}
        />
      </div>
    )
  }
  return (
    <div onKeyDown={onKey} data-testid="context-menu">
      {levels.map((items, level) => (
        <Card
          key={level}
          cardRef={(el) => {
            cards.current[level] = el
          }}
          items={items}
          sheet={false}
          level={level}
          title={level ? path[level - 1].entry.label : undefined}
          style={{ left: -9999, top: -9999 }}
          onChoose={(entry, row) => choose(entry, row, level)}
        />
      ))}
    </div>
  )
}
