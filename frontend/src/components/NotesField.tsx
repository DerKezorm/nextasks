/**
 * The note of a task: a clearly visible field with its own ground and edge, petrol when in focus. The editor itself
 * (Milkdown, see `NoteEditor`) is loaded only when a detail opens; until it is there, the field shows the note as it
 * stands, or "Add a note …".
 */
import { lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'

import { plainNotes } from '../lib/notes'
import type { Reminder } from '../sync/types'

const NoteEditor = lazy(() => import('./NoteEditor'))

export function NotesField({ reminder, label, onSave, locked = null }: { reminder: Reminder; label: string; onSave: (notes: string) => void; locked?: string | null }) {
  const { t, i18n } = useTranslation()
  const waiting = (
    <div className="nt-notes nt-note" aria-busy="true">
      <div className="h-[33px] border-b border-ink-700" />
      <p className={'min-h-24 px-3 py-2 text-sm whitespace-pre-wrap ' + (reminder.notes ? 'text-mist-100' : 'text-mist-500')}>{reminder.notes ? plainNotes(reminder.notes, i18n.language) : t('detail.notesPlaceholder')}</p>
    </div>
  )
  return (
    <Suspense fallback={waiting}>
      <NoteEditor reminder={reminder} label={label} onSave={onSave} locked={locked} />
    </Suspense>
  )
}
