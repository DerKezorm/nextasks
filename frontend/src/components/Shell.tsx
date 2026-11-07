/** What every part of the frame may ask of it: open a task, the chosen row, the quick entry, the search. */
import { createContext, useContext } from 'react'

import type { NewTarget } from './DetailPane'

export interface Shell {
  /** The task shown open: in the card over the page (`?reminder=`), else in the side column (`?pane=`). */
  selected: string | null
  /** The task in the side column, if it is shown. */
  pane: string | null
  /** Opens a task: in the side column when it is shown, else in the card in the middle. */
  openReminder: (id: string) => void
  /** Opens a task in the card in the middle, whatever the side column does. */
  showPopup: (id: string) => void
  closeReminder: () => void
  /** Shows a task in the side column, or hides the column when it shows that task already. */
  togglePane: (id: string) => void
  closePane: () => void
  /** The row with the focus (keys act on it). */
  select: (id: string | null) => void
  /** Puts the cursor into the quick entry of the page (N). */
  focusQuick: () => void
  registerQuick: (focus: (() => void) | null) => void
  /** "+ New task" and N: an empty task in the detail, for `target` or what the page registered. */
  newTask: (target?: NewTarget) => void
  /** Where the page puts a new task (its list, what its collection stands for). */
  registerTarget: (target: NewTarget | null) => void
  openSearch: () => void
  /** The list of keys (?). */
  openKeys: () => void
  /** Opens the dialog for a new list (in a space), a new space, or the shortcuts. */
  newList: (spaceId?: string) => void
  newSpace: () => void
  editList: (listId: string) => void
  editSpace: (spaceId: string) => void
  members: (spaceId: string) => void
  /** The dialog for a new own filter, or to change one. */
  newFilter: () => void
  editFilter: (filterId: string) => void
}

const noop = () => undefined

export const ShellContext = createContext<Shell>({
  selected: null,
  pane: null,
  openReminder: noop,
  showPopup: noop,
  closeReminder: noop,
  togglePane: noop,
  closePane: noop,
  select: noop,
  focusQuick: noop,
  registerQuick: noop,
  newTask: noop,
  registerTarget: noop,
  openSearch: noop,
  openKeys: noop,
  newList: noop,
  newSpace: noop,
  editList: noop,
  editSpace: noop,
  members: noop,
  newFilter: noop,
  editFilter: noop,
})

export function useShell(): Shell {
  return useContext(ShellContext)
}
