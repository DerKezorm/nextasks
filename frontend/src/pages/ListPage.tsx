/**
 * One list, as a card of rows with sections or as columns (one per section, "Without section" first when there are
 * such). The head carries the list's plaque, the switch between list and columns and the menu: edit, view, show
 * completed, delete completed, notify on changes, new section.
 */
import { Bell, BellOff, Check, Columns3, Eye, EyeOff, List as ListIcon, MoreHorizontal, Pencil, Plus, Trash2, Users } from 'lucide-react'
import { useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, useParams } from 'react-router-dom'

import { useContextMenu, type MenuItems } from '../components/ContextMenu'
import { PageHead } from '../components/PageHead'
import { Popover } from '../components/Popover'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup } from '../components/ReminderRow'
import { useShell } from '../components/Shell'
import { dragging, draggedReminder, DRAG_SECTION } from '../lib/drag'
import { clearCompleted, createSection, moveSection, setPref, type Spot } from '../lib/actions'
import { Badge } from '../components/Badge'
import { useEngine, useSyncState, useView } from '../state/sync'
import { byPosition } from '../sync/position'
import type { List, Reminder, Section } from '../sync/types'

export function ListPage() {
  const { id = '' } = useParams()
  const view = useView()
  const sync = useSyncState()
  const list = view.list(id)
  if (!list || view.listInTrash(list)) {
    if (!sync.loaded) return <main className="flex-1" />
    return <Navigate to="/today" replace />
  }
  return <ListBody key={list.id} list={list} />
}

function ListBody({ list }: { list: List }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const shell = useShell()
  const pref = view.pref(list.id)
  const space = view.space(list.space_id)
  const [naming, setNaming] = useState<string | null>(null)
  const [cleared, setCleared] = useState<number | null>(null)
  const showDone = pref.show_completed
  const sections = view.sectionsOf(list.id)
  const top = view.live.filter((r) => r.list_id === list.id && !r.parent_id && (showDone || !r.completed_at)).sort(byPosition)
  const loose = top.filter((r) => !r.section_id)
  const doneCount = view.live.filter((r) => r.list_id === list.id && r.completed_at).length
  const open = view.live.filter((r) => r.list_id === list.id && !r.completed_at).length
  const switchView = () => engine.put('list', list.id, { view: list.view === 'list' ? 'columns' : 'list' })

  return (
    <main className="nc-scroll min-w-0 flex-1 overflow-y-auto" aria-labelledby="list-title">
      <div className="px-4 py-5 sm:px-7 sm:py-6">
        <PageHead id="list-title" target={{ spot: { list_id: list.id, section_id: null, parent_id: null }, defaults: {} }} title={list.name} sub={`${space?.name ?? ''} · ${t('list.open', { count: open })}`} plaque={<Badge color={list.color} icon={list.icon} size="lg" />}>
          <button type="button" className="nc-btn nc-btn-ghost hidden px-3 font-normal sm:inline-flex" onClick={switchView} aria-label={t(list.view === 'list' ? 'list.asColumns' : 'list.asList')}>
            {list.view === 'list' ? <Columns3 className="h-4 w-4" aria-hidden /> : <ListIcon className="h-4 w-4" aria-hidden />}
            <span className="hidden xl:inline">{t(list.view === 'list' ? 'list.asColumns' : 'list.asList')}</span>
          </button>
          <Popover label={t('list.menu')} button={<MoreHorizontal className="h-5 w-5" />} className="rounded-[9px] p-2 text-mist-500 hover:bg-ink-800 hover:text-mist-100">
            {(close) => (
              <>
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), shell.editList(list.id))}>
                  <Pencil className="h-4 w-4" aria-hidden /> {t('list.edit')}
                </button>
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), setNaming(''))}>
                  <Plus className="h-4 w-4" aria-hidden /> {t('list.newSection')}
                </button>
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), switchView())}>
                  {list.view === 'list' ? <Columns3 className="h-4 w-4" aria-hidden /> : <ListIcon className="h-4 w-4" aria-hidden />} {t(list.view === 'list' ? 'list.asColumns' : 'list.asList')}
                </button>
                <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), setPref(engine, list.id, { show_completed: !showDone }))}>
                  {showDone ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />} {t(showDone ? 'list.hideDone' : 'list.showDone')}
                </button>
                <button type="button" className="nc-menu-item" role="menuitem" disabled={!doneCount} onClick={() => (close(), setCleared(clearCompleted(engine, view, list.id)))}>
                  <Trash2 className="h-4 w-4" aria-hidden /> {t('list.clearDone', { count: doneCount })}
                </button>
                {space && !space.private && (
                  <>
                    <button type="button" className="nc-menu-item" role="menuitemcheckbox" aria-checked={pref.notify_changes} onClick={() => (close(), setPref(engine, list.id, { notify_changes: !pref.notify_changes }))}>
                      {pref.notify_changes ? <BellOff className="h-4 w-4" aria-hidden /> : <Bell className="h-4 w-4" aria-hidden />} {t(pref.notify_changes ? 'list.notifyOff' : 'list.notifyOn')}
                    </button>
                    <button type="button" className="nc-menu-item" role="menuitem" onClick={() => (close(), shell.members(space.id))}>
                      <Users className="h-4 w-4" aria-hidden /> {t('members.title')}
                    </button>
                  </>
                )}
              </>
            )}
          </Popover>
        </PageHead>

        {pref.notify_changes && (
          <p className="mb-3 flex items-center gap-2 text-xs text-mist-500">
            <Bell className="h-3.5 w-3.5" aria-hidden /> {t('list.notifyHint')}
          </p>
        )}
        {cleared !== null && (
          <p role="status" className="mb-3 flex items-center gap-2 rounded-lg border border-ok-500/30 bg-ok-500/10 px-3 py-2 text-sm text-ok-500">
            <Check className="h-4 w-4" aria-hidden /> {t('list.cleared', { count: cleared })}
          </p>
        )}

        {list.view === 'columns' ? (
          <Columns list={list} sections={sections} top={top} loose={loose} showDone={showDone} />
        ) : (
          <div className="space-y-5">
            <div className="nt-card overflow-hidden">
              <ReminderGroup
                spot={{ list_id: list.id, section_id: null, parent_id: null }}
                items={loose}
                showDone={showDone}
                empty={sections.length || loose.length ? undefined : t('list.empty')}
                footer={<QuickEntry spot={{ list_id: list.id, section_id: null, parent_id: null }} />}
              />
            </div>
            {sections.map((section, index) => (
              <SectionBlock key={section.id} section={section} index={index} items={top.filter((r) => r.section_id === section.id)} showDone={showDone} />
            ))}
          </div>
        )}

        {naming !== null && (
          <form
            className="mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (naming.trim()) createSection(engine, view, list.id, naming)
              setNaming(null)
            }}
          >
            <input autoFocus value={naming} maxLength={80} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} placeholder={t('list.sectionName')} aria-label={t('list.sectionName')} className="nc-field" />
            <button type="submit" className="nc-btn nc-btn-accent">
              {t('list.addSection')}
            </button>
          </form>
        )}
      </div>
    </main>
  )
}

function SectionHeader({ section, index, count, board = false }: { section: Section; index: number; count?: number; board?: boolean }) {
  const { t } = useTranslation()
  const engine = useEngine()
  const view = useView()
  const [name, setName] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const menu = useContextMenu((): MenuItems => [
    { label: t('menu.rename'), icon: Pencil, run: () => setName(section.name) },
    {
      label: t('menu.newTaskHere'),
      icon: Plus,
      run: () => document.querySelector<HTMLElement>(`[data-section-id="${section.id}"]`)?.closest('section')?.querySelector<HTMLInputElement>('[data-testid="quick-entry"]')?.focus(),
    },
    'line',
    { label: t('menu.deleteSection'), icon: Trash2, danger: true, confirm: t('menu.sure'), run: () => engine.remove('section', section.id) },
  ])
  return (
    <div
      {...menu}
      data-section-id={section.id}
      className={'group flex items-center gap-2 rounded-md px-1 ' + (over ? 'bg-accent-500/10' : '')}
      draggable
      onDragStart={(e) => {
        dragging.section = section.id
        e.dataTransfer.setData(DRAG_SECTION, section.id)
      }}
      onDragEnd={() => (dragging.section = null)}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes(DRAG_SECTION) || dragging.section) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        const dragged = e.dataTransfer?.getData(DRAG_SECTION) || dragging.section
        if (!dragged || dragged === section.id) return
        e.preventDefault()
        moveSection(engine, view, dragged, index)
      }}
    >
      {name === null ? (
        <button type="button" className={'min-w-0 flex-1 truncate py-1 text-left ' + (board ? 'text-[15px] font-bold text-mist-100' : 'nt-sec hover:text-mist-100')} onClick={() => setName(section.name)} title={t('list.renameSection')}>
          {section.name}
        </button>
      ) : (
        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim() && name.trim() !== section.name) engine.put('section', section.id, { name })
            setName(null)
          }}
        >
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Escape' && setName(null)} aria-label={t('list.renameSection')} className="nc-field py-1" />
        </form>
      )}
      <button type="button" className="rounded-md p-1 text-mist-600 opacity-0 group-hover:opacity-100 hover:text-bad-500 focus:opacity-100" aria-label={t('list.deleteSection', { name: section.name })} onClick={() => engine.remove('section', section.id)}>
        <Trash2 className="h-4 w-4" />
      </button>
      {count !== undefined && <span className={'pr-1 ' + (board ? 'text-xs text-mist-500 tabular-nums' : 'nt-sec tabular-nums')}>{count}</span>}
    </div>
  )
}

function SectionBlock({ section, index, items, showDone }: { section: Section; index: number; items: Reminder[]; showDone: boolean }) {
  const { t } = useTranslation()
  const spot: Spot = { list_id: section.list_id, section_id: section.id, parent_id: null }
  return (
    <section aria-label={section.name}>
      <SectionHeader section={section} index={index} count={items.filter((r) => !r.completed_at).length} />
      <div className="nt-card mt-1.5 overflow-hidden">
        <ReminderGroup spot={spot} items={items} showDone={showDone} footer={<QuickEntry spot={spot} register={false} label={t('reminder.new')} />} />
      </div>
    </section>
  )
}

function Columns({ list, sections, top, loose, showDone }: { list: List; sections: Section[]; top: Reminder[]; loose: Reminder[]; showDone: boolean }) {
  const { t } = useTranslation()
  const columns: { section: Section | null; items: Reminder[] }[] = [...(loose.length ? [{ section: null, items: loose }] : []), ...sections.map((s) => ({ section: s, items: top.filter((r) => r.section_id === s.id) }))]
  if (!columns.length) columns.push({ section: null, items: [] })
  return (
    <div className="nc-scroll flex items-start gap-3.5 overflow-x-auto pb-4" data-testid="columns">
      {columns.map(({ section, items }, index) => {
        const spot: Spot = { list_id: list.id, section_id: section?.id ?? null, parent_id: null }
        return (
          <section key={section?.id ?? 'loose'} aria-label={section?.name ?? t('list.noSection')} className="flex w-72 shrink-0 flex-col rounded-xl border border-ink-700 bg-ink-800/70 p-2" onDragOver={(e: DragEvent) => draggedReminder(e) && e.preventDefault()}>
            {section ? (
              <SectionHeader section={section} index={index - (loose.length ? 1 : 0)} count={items.filter((r) => !r.completed_at).length} board />
            ) : (
              <div className="flex items-center gap-2 px-1 py-1 text-[15px] font-bold text-mist-100">
                <span className="flex-1">{t('list.noSection')}</span>
                <span className="text-xs font-normal text-mist-500 tabular-nums">{items.filter((r) => !r.completed_at).length}</span>
              </div>
            )}
            <div className="mt-1.5 flex flex-1 flex-col">
              <ReminderGroup spot={spot} items={items} showDone={showDone} board footer={<QuickEntry spot={spot} register={index === 0} label={t('reminder.new')} />} />
            </div>
          </section>
        )
      })}
    </div>
  )
}
