/**
 * Whether others are part of a place. Many use nextasks on their own: in "Private", or in a space nobody else has
 * joined. There the family parts stay away (avatars in rows, the assign button, the members in a space's head), and
 * empty pages speak to one person. One check for every page, so each place decides the same way.
 */
import type { Member, Space } from '../sync/types'
import type { View } from '../sync/view'

/** A space others share: not "Private", and more than the own membership in it. */
export function isShared(view: Pick<View, 'membersOf'>, space: Pick<Space, 'id' | 'private'> | undefined): boolean {
  if (!space || space.private) return false
  return view.membersOf(space.id).length > 1
}

/** Whether the list (by id) lies in a shared space. */
export function isSharedList(view: Pick<View, 'membersOf' | 'list' | 'space'>, listId: string): boolean {
  const list = view.list(listId)
  return !!list && isShared(view, view.space(list.space_id))
}

/** Who a task in this list can be assigned to: the members of a shared space, nobody elsewhere. */
export function assignable(view: Pick<View, 'membersOf' | 'list' | 'space'>, listId: string): Member[] {
  const list = view.list(listId)
  const space = list ? view.space(list.space_id) : undefined
  return isShared(view, space) ? view.membersOf(space!.id) : []
}

/** Alone: no space one sees is shared with anybody. */
export function isAlone(view: Pick<View, 'membersOf' | 'shownSpaces'>): boolean {
  return !view.shownSpaces.some((space) => isShared(view, space))
}
