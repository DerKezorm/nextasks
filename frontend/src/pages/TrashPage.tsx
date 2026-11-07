/**
 * The trash: spaces, lists and reminders deleted themselves (not those that only went along with a parent). They
 * come back with "Restore" for 30 days from deleting; then the server removes them for good.
 */
import { RotateCcw, Trash2 } from 'lucide-react'
import { type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { Badge } from '../components/Badge'
import { useTrashMenu } from '../components/Menus'
import { useEngine, useView } from '../state/sync'

function daysLeft(deletedAt: string | null): number {
  if (!deletedAt) return 30
  return Math.max(0, 30 - Math.floor((Date.now() - Date.parse(deletedAt)) / 86_400_000))
}

/** An entry with "Restore" in its context menu, where one may restore it. */
function TrashRow({ restore, children }: { restore: (() => void) | null; children: ReactNode }) {
  const menu = useTrashMenu(restore)
  return (
    <li {...menu} className="flex items-center gap-3 px-3 py-2.5 text-sm">
      {children}
    </li>
  )
}

export function TrashPage() {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const { spaces, lists, reminders } = view.trash
  const empty = !spaces.length && !lists.length && !reminders.length
  const restore = (kind: 'space' | 'list' | 'reminder', id: string, name: string) => (
    <button type="button" className="nc-btn nc-btn-ghost" aria-label={t('trash.restoreName', { name })} onClick={() => engine.trash(kind, id, true)}>
      <RotateCcw className="h-3.5 w-3.5" /> {t('trash.restore')}
    </button>
  )
  return (
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-5 px-4 py-5 sm:px-6">
        <header className="flex items-center gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-ink-800 text-mist-500">
            <Trash2 className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-mist-100 sm:text-[26px]">{t('trash.title')}</h1>
            <p className="text-xs text-mist-500">{t('trash.hint')}</p>
          </div>
        </header>
        {empty && <p className="py-8 text-center text-sm text-mist-500">{t('trash.empty')}</p>}
        {spaces.length > 0 && (
          <section aria-label={t('trash.spaces')}>
            <h2 className="nt-sec mb-1.5 px-1">{t('trash.spaces')}</h2>
            <ul className="nt-card divide-y divide-ink-700">
              {spaces.map((s) => (
                <TrashRow key={s.id} restore={s.role === 'manager' ? () => engine.trash('space', s.id, true) : null}>
                  <Badge color={s.color} icon={s.icon} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-mist-100">{s.name}</span>
                  <span className="text-xs text-mist-500">{t('trash.days', { count: daysLeft(s.deleted_at) })}</span>
                  {s.role === 'manager' && restore('space', s.id, s.name)}
                </TrashRow>
              ))}
            </ul>
          </section>
        )}
        {lists.length > 0 && (
          <section aria-label={t('trash.lists')}>
            <h2 className="nt-sec mb-1.5 px-1">{t('trash.lists')}</h2>
            <ul className="nt-card divide-y divide-ink-700">
              {lists.map((l) => (
                <TrashRow key={l.id} restore={() => engine.trash('list', l.id, true)}>
                  <Badge color={l.color} icon={l.icon} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-mist-100">
                    {l.name} <span className="text-xs text-mist-500">· {view.space(l.space_id)?.name}</span>
                  </span>
                  <span className="text-xs text-mist-500">{t('trash.days', { count: daysLeft(l.deleted_at) })}</span>
                  {restore('list', l.id, l.name)}
                </TrashRow>
              ))}
            </ul>
          </section>
        )}
        {reminders.length > 0 && (
          <section aria-label={t('trash.reminders')}>
            <h2 className="nt-sec mb-1.5 px-1">{t('trash.reminders')}</h2>
            <ul className="nt-card divide-y divide-ink-700" data-testid="trash-reminders">
              {reminders.map((r) => (
                <TrashRow key={r.id} restore={() => engine.trash('reminder', r.id, true)}>
                  <span className="min-w-0 flex-1 truncate text-mist-100">
                    {r.title} <span className="text-xs text-mist-500">· {view.list(r.list_id)?.name}</span>
                  </span>
                  <span className="text-xs text-mist-500">{t('trash.days', { count: daysLeft(r.deleted_at) })}</span>
                  {restore('reminder', r.id, r.title)}
                </TrashRow>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  )
}
