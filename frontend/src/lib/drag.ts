/** What is being dragged on the page: reminders, lists, spaces and sections, each with its own data type. */
import type { DragEvent } from 'react'

export const DRAG_REMINDER = 'application/x-nextasks-reminder'
export const DRAG_LIST = 'application/x-nextasks-list'
export const DRAG_SPACE = 'application/x-nextasks-space'
export const DRAG_SECTION = 'application/x-nextasks-section'

/** Kept here too: some browsers hide the data until the drop. */
export const dragging: { reminder: string | null; list: string | null; space: string | null; section: string | null } = { reminder: null, list: null, space: null, section: null }

export function draggedReminder(event: DragEvent): string | null {
  return event.dataTransfer?.getData(DRAG_REMINDER) || dragging.reminder
}
