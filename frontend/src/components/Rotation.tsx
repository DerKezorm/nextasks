/**
 * Taking turns ("Reihum", `sync/rotation.ts`): in a row "Leo's turn" and Leo's picture with a small round arrow
 * instead of the stack of assignees; in the detail a switch under "Assigned to", the people of the row in their order
 * (dragged, or moved with Alt and the arrow keys), whose turn it is and who comes after.
 */
import { GripVertical, Plus, RefreshCw, X } from 'lucide-react'
import { useState, type DragEvent, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { useView } from '../state/sync'
import { takesTurns, turnOf, whoseTurn, nextAfter } from '../sync/rotation'
import type { Data, Member, Reminder } from '../sync/types'
import { AvatarStack, personName, PersonAvatar } from './People'

const DRAG_TURN = 'application/x-nextasks-turn'

/** The picture of whose turn it is, with a small round arrow at its foot. */
function TurnAvatar({ id, size }: { id: number; size: 'row' | 'card' }) {
  const { t } = useTranslation()
  const view = useView()
  const name = personName(view.people.get(id), t)
  return (
    <span className="relative inline-flex" role="img" aria-label={t('rotation.row', { name })} title={t('rotation.row', { name })} data-testid="turn-avatar">
      <PersonAvatar id={id} person={view.people.get(id)} className={(size === 'row' ? 'h-[22px] w-[22px]' : 'h-5 w-5') + ' text-[11px]'} ring />
      <span className="absolute -right-1 -bottom-1 grid h-[13px] w-[13px] place-items-center rounded-full bg-accent-500 text-white ring-2 ring-ink-850" aria-hidden>
        <RefreshCw className="h-[8px] w-[8px]" strokeWidth={3} />
      </span>
    </span>
  )
}

/** Who a task is for, at the right of a row or a card: whose turn it is, or the stack of assignees. */
export function TaskPeople({ reminder, max = 3, size = 'row' }: { reminder: Reminder; max?: number; size?: 'row' | 'card' }) {
  const view = useView()
  const turn = turnOf(reminder)
  if (turn) return <TurnAvatar id={turn.now} size={size} />
  return <AvatarStack ids={reminder.assignees} people={view.people} max={max} />
}

/** "Leo's turn" among the small things below a row's title. */
export function TurnMeta({ reminder }: { reminder: Reminder }) {
  const { t } = useTranslation()
  const view = useView()
  const turn = turnOf(reminder)
  if (!turn || reminder.completed_at) return null
  return (
    <span className="inline-flex items-center gap-1 font-medium text-mist-300" data-testid="turn">
      <RefreshCw className="h-[12px] w-[12px]" aria-hidden />
      {t('rotation.now', { name: personName(view.people.get(turn.now), t) })}
    </span>
  )
}

/** The order with `from` taken out and put in at `to`. */
function moved(order: number[], from: number, to: number): number[] {
  const out = [...order]
  const [person] = out.splice(from, 1)
  out.splice(to, 0, person)
  return out
}

/**
 * The detail's part for taking turns: the switch (only on a repeating task), then the row of people. `put` writes the
 * task; whose turn it is goes along in `assignees`, so an app without the field sees it as an assignment.
 */
export function RotationField({ reminder, members, put }: { reminder: Reminder; members: Member[]; put: (fields: Data) => void }) {
  const { t } = useTranslation()
  const view = useView()
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)
  const repeating = !!reminder.repeat && !!reminder.due_date
  const memberIds = members.map((m) => m.account_id)
  const order = reminder.rotation.filter((id) => memberIds.includes(id))
  const on = order.length > 0
  const name = (id: number) => personName(view.people.get(id), t)

  const turnOn = () => {
    // Whoever is in charge now begins; the others follow in the order of the space.
    const first = reminder.assignees.find((id) => memberIds.includes(id))
    const all = first === undefined ? memberIds : [first, ...memberIds.filter((id) => id !== first)]
    put({ rotation: all, assignees: [all[0]] })
  }
  const write = (next: number[], current = reminder.assignees) => put({ rotation: next, assignees: [whoseTurn(next, current)] })
  const remove = (id: number) => {
    const next = order.filter((x) => x !== id)
    // Was it their turn, the one after them takes it.
    const now = whoseTurn(order, reminder.assignees)
    write(next, now === id ? [nextAfter(order, id)] : reminder.assignees)
  }
  const onKey = (event: KeyboardEvent, index: number) => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    const to = index + (event.key === 'ArrowUp' ? -1 : 1)
    if (to < 0 || to >= order.length) return
    event.preventDefault()
    write(moved(order, index, to))
  }
  const dropAt = (event: DragEvent, index: number) => {
    const from = dragged ?? Number(event.dataTransfer?.getData(DRAG_TURN) || NaN)
    setDragged(null)
    setOver(null)
    if (!Number.isInteger(from) || from === index) return
    event.preventDefault()
    write(moved(order, from, index))
  }

  if (!repeating && !on) return <p className="mt-1 text-xs text-mist-500">{t('rotation.onlyRepeating')}</p>
  const now = takesTurns({ ...reminder, rotation: order }) ? whoseTurn(order, reminder.assignees) : null
  const then = now !== null && order.length > 1 ? nextAfter(order, now) : null
  const outside = memberIds.filter((id) => !order.includes(id))
  return (
    <div className="mt-2" data-testid="rotation">
      <label className="flex items-center gap-2 text-sm text-mist-100">
        <input type="checkbox" role="switch" checked={on} onChange={() => (on ? put({ rotation: [] }) : turnOn())} className="h-4 w-4 accent-accent-500" data-testid="rotation-switch" />
        <RefreshCw className="h-3.5 w-3.5 text-mist-500" aria-hidden />
        {t('rotation.toggle')}
        {now !== null && (
          <span className="ml-auto truncate text-xs font-medium text-accent-400" data-testid="rotation-now">
            {then !== null ? t('rotation.nowThen', { name: name(now), next: name(then) }) : t('rotation.now', { name: name(now) })}
          </span>
        )}
      </label>
      {on && (
        <>
          <ol className="mt-2 flex flex-col gap-1" aria-label={t('rotation.order')} data-testid="rotation-order">
            {order.map((id, index) => (
              <li
                key={id}
                draggable
                onDragStart={(event) => {
                  setDragged(index)
                  event.dataTransfer?.setData(DRAG_TURN, String(index))
                  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  setDragged(null)
                  setOver(null)
                }}
                onDragOver={(event) => {
                  if (dragged === null && !event.dataTransfer?.types.includes(DRAG_TURN)) return
                  event.preventDefault()
                  setOver(index)
                }}
                onDrop={(event) => dropAt(event, index)}
                className={'group flex items-center gap-2 rounded-lg border px-1.5 py-1 text-sm ' + (over === index && dragged !== index ? 'border-accent-500 bg-accent-wash' : 'border-ink-700')}
                data-testid="rotation-person"
              >
                <span className="cursor-grab text-mist-600" aria-hidden>
                  <GripVertical className="h-4 w-4" />
                </span>
                <span className="w-4 text-center text-xs font-bold text-mist-500 tabular-nums" aria-hidden>
                  {index + 1}
                </span>
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                  aria-pressed={id === now}
                  aria-label={t('rotation.makeTurn', { name: name(id) })}
                  title={t('rotation.grip', { name: name(id) })}
                  onClick={() => id !== now && put({ assignees: [id] })}
                  onKeyDown={(event) => onKey(event, index)}
                >
                  <PersonAvatar id={id} person={view.people.get(id)} className="h-5 w-5 text-[10px]" />
                  <span className={'truncate ' + (id === now ? 'font-semibold text-accent-400' : 'text-mist-100')}>{name(id)}</span>
                </button>
                {order.length > 1 && (
                  <button
                    type="button"
                    className="rounded-md p-0.5 text-mist-500 opacity-0 group-hover:opacity-100 hover:text-mist-100 focus:opacity-100"
                    aria-label={t('rotation.remove', { name: name(id) })}
                    title={t('rotation.remove', { name: name(id) })}
                    onClick={() => remove(id)}
                  >
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ol>
          {outside.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5" aria-label={t('rotation.more')} role="group">
              {outside.map((id) => (
                <button key={id} type="button" className="nt-toggle h-7 pr-2.5 pl-1 text-xs" onClick={() => write([...order, id])} aria-label={t('rotation.add', { name: name(id) })}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  {name(id)}
                </button>
              ))}
            </div>
          )}
          <p className="mt-1 text-xs text-mist-500">{t('rotation.hint')}</p>
        </>
      )}
    </div>
  )
}
