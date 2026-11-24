/**
 * One list, as cards of rows in a column one reads at a glance (the tasks without section first, then a card per
 * section with its head inside) or as columns (one per section, "Without section" first when there are such), which
 * grow with the window and keep their heads at the top while they scroll. The head carries the list's plaque, the
 * switch between list and columns and the menu: edit, view, show completed, delete completed, notify on changes, new
 * section. An empty list says so in a line and leads to the quick entry.
 */
import { Bell, Check, Columns3, Eye, EyeOff, List as ListIcon, ListChecks, MoreHorizontal, Pencil, Plus, Trash2, Users, type LucideIcon } from 'lucide-react'
import { createElement, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'

import { useContextMenu, type MenuItems } from '../components/ContextMenu'
import { PageHead } from '../components/PageHead'
import { Popover } from '../components/Popover'
import { QuickEntry } from '../components/QuickEntry'
import { ReminderGroup } from '../components/ReminderRow'
import { useShell } from '../components/Shell'
import { dragging, draggedReminder, DRAG_SECTION } from '../lib/drag'
import { clearCompleted, createSection, moveSection, setPref, type Spot } from '../lib/actions'
import { QuietEmpty } from '../components/EmptyState'
import { MarkTile } from '../components/Mark'
import { NotFound } from '../components/NotFound'
import { isShared } from '../lib/shared'
import { useEngine, useSyncState, useView } from '../state/sync'
import { byPosition } from '../sync/position'
import type { List, Reminder, Section } from '../sync/types'

export function ListPage() {
  const { id = '' } = useParams()
  const view = useView()
  const sync = useSyncState()
  const list = view.list(id)
  const { t } = useTranslation()
  if (!list || view.listInTrash(list)) {
    if (!sync.loaded) return <main className="flex-1" />
    return <NotFound text={t('notFound.list')} />
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
  const showDone = pref.show_completed
  const sections = view.sectionsOf(list.id)
  const top = view.live.filter((r) => r.list_id === list.id && !r.parent_id && (showDone || !r.completed_at)).sort(byPosition)
  const loose = top.filter((r) => !r.section_id)
  const doneCount = view.live.filter((r) => r.list_id === list.id && r.completed_at).length
  const open = view.live.filter((r) => r.list_id === list.id && !r.completed_at).length
  const switchView = () => engine.put('list', list.id, { view: list.view === 'list' ? 'columns' : 'list' })
  const target = { spot: { list_id: list.id, section_id: null, parent_id: null }, defaults: {} }
  const symbol = (icon: LucideIcon) => createElement(icon, { className: 'h-4 w-4', strokeWidth: 1.8, 'aria-hidden': true })
  const board = list.view === 'columns'
  const empty = !sections.length && !loose.length

  return (
    // The columns scroll in a box of their own below the head, so their heads can stay at its top.
    <main className={'min-w-0 flex-1 ' + (board ? 'flex flex-col overflow-hidden' : 'nt-scroll overflow-y-auto')} aria-labelledby="list-title">
      <div className={'px-4 py-5 sm:px-7 sm:py-6 ' + (board ? 'flex min-h-0 flex-1 flex-col pb-0 sm:pb-0' : '')}>
        <PageHead id="list-title" target={target} title={list.name} count={t('list.open', { count: open })} sub={space?.name} icon={<MarkTile color={list.color} icon={list.icon} />}>
          <button type="button" className="nt-icon-btn hidden sm:inline-flex" onClick={switchView} aria-label={t(list.view === 'list' ? 'list.asColumns' : 'list.asList')} title={t(list.view === 'list' ? 'list.asColumns' : 'list.asList')}>
            {symbol(list.view === 'list' ? Columns3 : ListIcon)}
          </button>
          <Popover label={t('list.menu')} button={<MoreHorizontal className="h-4 w-4" />} className="nt-icon-btn">
            {(close) => (
              <>
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.editList(list.id))}>
                  {symbol(Pencil)} {t('list.edit')}
                </button>
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), setNaming(''))}>
                  {symbol(Plus)} {t('list.newSection')}
                </button>
                <div className="nt-menu-line" role="separator" />
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), switchView())}>
                  {symbol(list.view === 'list' ? Columns3 : ListIcon)} {t(list.view === 'list' ? 'list.asColumns' : 'list.asList')}
                </button>
                <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), setPref(engine, list.id, { show_completed: !showDone }))}>
                  {symbol(showDone ? EyeOff : Eye)} {t(showDone ? 'list.hideDone' : 'list.showDone')}
                </button>
                {space && !space.private && (
                  <>
                    <button type="button" className="nt-menu-item" role="menuitemcheckbox" aria-checked={pref.notify_changes} onClick={() => (close(), setPref(engine, list.id, { notify_changes: !pref.notify_changes }))}>
                      {symbol(Bell)} <span className="min-w-0 flex-1">{t('list.notifyOn')}</span>
                      <Check className={'h-4 w-4 shrink-0 ' + (pref.notify_changes ? '' : 'invisible')} aria-hidden />
                    </button>
                    <button type="button" className="nt-menu-item" role="menuitem" onClick={() => (close(), shell.members(space.id))}>
                      {symbol(Users)} {t('members.title')}
                    </button>
                  </>
                )}
                <div className="nt-menu-line" role="separator" />
                <button type="button" className="nt-menu-item nt-menu-danger" role="menuitem" disabled={!doneCount} onClick={() => (close(), clearCompleted(engine, view, list.id, (count) => t('list.cleared', { count })))}>
                  {symbol(Trash2)} {t('list.clearDone', { count: doneCount })}
                </button>
              </>
            )}
          </Popover>
        </PageHead>

        {pref.notify_changes && (
          <p className="mb-3 flex items-center gap-2 px-1 text-xs text-mist-500">
            <Bell className="h-3.5 w-3.5" aria-hidden /> {t('list.notifyHint')}
          </p>
        )}

        {board ? (
          <Columns list={list} sections={sections} top={top} loose={loose} showDone={showDone} />
        ) : (
          <div className="nt-read space-y-4">
            {empty && (
              <QuietEmpty icon={ListChecks} title={t('list.emptyTitle', { name: list.name })} text={isShared(view, space) ? t('list.emptyShared', { space: space?.name ?? '' }) : t('list.emptyText')} />
            )}
            <div className={empty ? 'rounded-[13px] ring-2 ring-accent-500/35' : undefined}>
              <ReminderGroup spot={{ list_id: list.id, section_id: null, parent_id: null }} items={loose} showDone={showDone} footer={<QuickEntry spot={{ list_id: list.id, section_id: null, parent_id: null }} />} />
            </div>
            {sections.map((section, index) => (
              <SectionBlock key={section.id} section={section} index={index} items={top.filter((r) => r.section_id === section.id)} showDone={showDone} />
            ))}
          </div>
        )}

        {naming !== null && (
          <form
            className="nt-read mt-4 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              if (naming.trim()) createSection(engine, view, list.id, naming)
              setNaming(null)
            }}
          >
            <input autoFocus value={naming} maxLength={80} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} placeholder={t('list.sectionName')} aria-label={t('list.sectionName')} className="nt-field" />
            <button type="submit" className="nt-btn nt-btn-accent">
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
  const shell = useShell()
  const remove = () =>
    shell.ask({ title: t('list.deleteSectionTitle', { name: section.name }), text: t('list.deleteSectionText'), final: true, confirm: t('menu.deleteSection'), run: () => engine.remove('section', section.id) })
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
    { label: t('menu.deleteSection'), icon: Trash2, danger: true, run: remove },
  ])
  return (
    <div
      {...menu}
      data-section-id={section.id}
      className={'group flex items-center gap-1.5 ' + (board ? 'rounded-md px-1 ' : 'nt-card-head ') + (over ? 'bg-accent-wash' : '')}
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
        <button type="button" className={'min-w-0 truncate py-1 text-left ' + (board ? 'flex-1 text-[15px] font-bold text-mist-100' : 'nt-sec hover:text-mist-300')} onClick={() => setName(section.name)} title={t('list.renameSection')}>
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
          <input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Escape' && setName(null)} aria-label={t('list.renameSection')} className="nt-field h-8" />
        </form>
      )}
      {count !== undefined && (board ? <span className="text-xs text-mist-500 tabular-nums">{count}</span> : <span className="ml-auto shrink-0 text-[11px] font-semibold text-mist-600 tabular-nums">{count}</span>)}
      <button type="button" className={'nt-icon-btn h-7 w-7 opacity-0 group-hover:opacity-100 not-disabled:hover:text-bad-500 focus:opacity-100 ' + (board || count !== undefined ? '' : 'ml-auto')} aria-label={t('list.deleteSection', { name: section.name })} onClick={remove}>
        <Trash2 className="h-4 w-4" strokeWidth={1.8} />
      </button>
    </div>
  )
}

function SectionBlock({ section, index, items, showDone }: { section: Section; index: number; items: Reminder[]; showDone: boolean }) {
  const { t } = useTranslation()
  const spot: Spot = { list_id: section.list_id, section_id: section.id, parent_id: null }
  return (
    <section aria-label={section.name}>
      <ReminderGroup spot={spot} items={items} showDone={showDone} head={<SectionHeader section={section} index={index} count={items.filter((r) => !r.completed_at).length} />} footer={<QuickEntry spot={spot} register={false} label={t('reminder.new')} />} />
    </section>
  )
}

function Columns({ list, sections, top, loose, showDone }: { list: List; sections: Section[]; top: Reminder[]; loose: Reminder[]; showDone: boolean }) {
  const { t } = useTranslation()
  const columns: { section: Section | null; items: Reminder[] }[] = [...(loose.length ? [{ section: null, items: loose }] : []), ...sections.map((s) => ({ section: s, items: top.filter((r) => r.section_id === s.id) }))]
  if (!columns.length) columns.push({ section: null, items: [] })
  return (
    <div className="nt-scroll -mx-4 flex min-h-0 flex-1 items-start gap-3.5 overflow-auto px-4 pb-4 sm:-mx-7 sm:px-7" data-testid="columns">
      {columns.map(({ section, items }, index) => {
        const spot: Spot = { list_id: list.id, section_id: section?.id ?? null, parent_id: null }
        return (
          <section key={section?.id ?? 'loose'} aria-label={section?.name ?? t('list.noSection')} className="flex max-w-[420px] min-w-[280px] flex-[1_0_280px] flex-col rounded-[12px] border border-ink-700 bg-ink-900 px-2 pb-2" onDragOver={(e: DragEvent) => draggedReminder(e) && e.preventDefault()}>
            {/* The head stays at the top of the box while the column scrolls. */}
            <div className="sticky top-0 z-[1] -mx-2 rounded-t-[12px] bg-ink-900 px-2 pt-2" data-testid="column-head">
              {section ? (
                <SectionHeader section={section} index={index - (loose.length ? 1 : 0)} count={items.filter((r) => !r.completed_at).length} board />
              ) : (
                <div className="flex items-center gap-2 px-1 py-1 text-[15px] font-bold text-mist-100">
                  <span className="flex-1">{t('list.noSection')}</span>
                  <span className="text-xs font-normal text-mist-500 tabular-nums">{items.filter((r) => !r.completed_at).length}</span>
                </div>
              )}
            </div>
            <div className="mt-1.5 flex flex-1 flex-col">
              <ReminderGroup spot={spot} items={items} showDone={showDone} board footer={<QuickEntry spot={spot} register={index === 0} label={t('reminder.new')} />} />
            </div>
          </section>
        )
      })}
    </div>
  )
}
