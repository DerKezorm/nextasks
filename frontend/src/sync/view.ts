/**
 * What the page shows, built from the stored records with the reading rules of the data model ("Lesen: was gilt")
 * and the trash rules ("Papierkorb und Grabsteine"). Every side reads the same way, so field-wise mixed states never
 * contradict each other.
 */
import { byPosition } from './position'
import type { Attachment, Data, Filter, Kind, List, ListPref, Member, Person, Reminder, Section, Space, SpacePref, TilePref } from './types'

export interface Rec {
  kind: Kind
  id: string
  data: Data
  clock: Record<string, number>
}

export interface View {
  me: number
  people: Map<number, Person>
  /** Spaces not in the trash, in the order of the own sidebar, hidden ones included. */
  spaces: Space[]
  /** The spaces the sidebar shows: not hidden (`space_pref`). */
  shownSpaces: Space[]
  /** The spaces one hid, in the same order: at the bottom of the sidebar to show again. */
  hiddenSpaces: Space[]
  /** Whether one hid this space for oneself. */
  isHidden(spaceId: string): boolean
  space(id: string): Space | undefined
  list(id: string): List | undefined
  section(id: string): Section | undefined
  /** Lists of a space not in the trash, by position. */
  listsOf(spaceId: string): List[]
  sectionsOf(listId: string): Section[]
  /** Every reminder as it reads (rules applied), the trash included. */
  reminder(id: string): Reminder | undefined
  reminders: Reminder[]
  /** Reminders outside the trash. */
  live: Reminder[]
  /** Reminders outside the trash and outside hidden spaces: what the collections and the search go through. */
  visible: Reminder[]
  childrenOf(id: string): Reminder[]
  inTrash(reminder: Reminder): boolean
  listInTrash(list: List): boolean
  attachmentsOf(reminderId: string): Attachment[]
  membersOf(spaceId: string): Member[]
  pref(listId: string): ListPref
  /** The own space "Privat" and its first list (where orphans go). */
  privateSpace: Space | undefined
  firstPrivateList: List | undefined
  /** Where a new task goes when nothing else is chosen: the first list of "Privat", else of the first space shown;
   * never a list in a hidden space. */
  defaultList: List | undefined
  trash: { spaces: Space[]; lists: List[]; reminders: Reminder[] }
  /** The own filters by position, hidden ones included (the settings list them all). */
  filters: Filter[]
  /** The filters the sidebar shows. */
  shownFilters: Filter[]
  filter(id: string): Filter | undefined
  /** Whether one hid the collection with this fixed id (`tile_pref`). */
  isTileHidden(tileId: string): boolean
  /** Space order: index in the sidebar, for sorting across spaces. */
  spaceIndex(id: string): number
  listIndex(id: string): number
}

/** Applies the reading rules to one reminder. */
export function readReminder(raw: Reminder, reminders: Map<string, Reminder>, sections: Map<string, Section>): Reminder {
  const out = { ...raw }
  if (out.parent_id) {
    const parent = reminders.get(out.parent_id)
    if (!parent || parent.parent_id || parent.list_id !== out.list_id) out.parent_id = null
  }
  if (out.parent_id) out.section_id = null
  else if (out.section_id) {
    const section = sections.get(out.section_id)
    if (!section || section.list_id !== out.list_id) out.section_id = null
  }
  if (!out.due_date) {
    out.due_time = null
    out.repeat = null
  }
  return out
}

export function buildView(records: Iterable<Rec>, people: Map<number, Person>, me: number): View {
  const spaces = new Map<string, Space>()
  const lists = new Map<string, List>()
  const sections = new Map<string, Section>()
  const rawReminders = new Map<string, Reminder>()
  const attachments = new Map<string, Attachment[]>()
  const members = new Map<string, Member[]>()
  const prefs = new Map<string, ListPref>()
  const hidden = new Set<string>()
  const filters = new Map<string, Filter>()
  const hiddenTiles = new Set<string>()
  for (const rec of records) {
    const data = { ...rec.data, id: rec.id }
    switch (rec.kind) {
      case 'space':
        spaces.set(rec.id, data as unknown as Space)
        break
      case 'list':
        lists.set(rec.id, data as unknown as List)
        break
      case 'section':
        sections.set(rec.id, data as unknown as Section)
        break
      case 'reminder':
        rawReminders.set(rec.id, data as unknown as Reminder)
        break
      case 'attachment': {
        const a = data as unknown as Attachment
        attachments.set(a.reminder_id, [...(attachments.get(a.reminder_id) ?? []), a])
        break
      }
      case 'member': {
        const m = data as unknown as Member
        members.set(m.space_id, [...(members.get(m.space_id) ?? []), m])
        break
      }
      case 'list_pref':
        prefs.set(rec.id, data as unknown as ListPref)
        break
      case 'space_pref':
        if ((data as unknown as SpacePref).hidden) hidden.add(rec.id)
        break
      case 'filter': {
        // Rules that are not an object read as none (`{}`: everything open).
        const raw = (data as Data).rules
        const rules = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
        filters.set(rec.id, { ...(data as unknown as Filter), rules: rules as Filter['rules'] })
        break
      }
      case 'tile_pref':
        if ((data as unknown as TilePref).hidden) hiddenTiles.add(rec.id)
        break
    }
  }

  // Reminders whose list is not there (not delivered, or the list left our sight) are not shown.
  const reminders = new Map<string, Reminder>()
  for (const raw of rawReminders.values()) {
    if (!lists.has(raw.list_id)) continue
    reminders.set(raw.id, readReminder(raw, rawReminders, sections))
  }
  const children = new Map<string, Reminder[]>()
  for (const r of reminders.values()) if (r.parent_id) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r])
  for (const list of children.values()) list.sort(byPosition)

  const spaceGone = (id: string) => {
    const s = spaces.get(id)
    return !s || !!s.deleted_at
  }
  const listInTrash = (list: List) => !!list.deleted_at || spaceGone(list.space_id)
  const inTrash = (r: Reminder): boolean => {
    if (r.deleted_at) return true
    if (r.parent_id) {
      const parent = reminders.get(r.parent_id)
      if (parent?.deleted_at) return true
    }
    const list = lists.get(r.list_id)
    return !list || listInTrash(list)
  }

  const own = (spaceId: string) => (members.get(spaceId) ?? []).find((m) => m.account_id === me)
  const ordered = [...spaces.values()]
    .filter((s) => !s.deleted_at)
    .sort((a, b) => {
      const pa = own(a.id)?.position ?? null
      const pb = own(b.id)?.position ?? null
      if (pa && pb && pa !== pb) return pa < pb ? -1 : 1
      if (pa && !pb) return -1
      if (!pa && pb) return 1
      if (a.private !== b.private) return a.private ? -1 : 1
      return a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1)
    })
  const spaceOrder = new Map(ordered.map((s, i) => [s.id, i]))

  const listsBySpace = new Map<string, List[]>()
  for (const list of lists.values()) if (!list.deleted_at) listsBySpace.set(list.space_id, [...(listsBySpace.get(list.space_id) ?? []), list])
  for (const group of listsBySpace.values()) group.sort(byPosition)
  const listOrder = new Map<string, number>()
  let n = 0
  for (const s of ordered) for (const l of listsBySpace.get(s.id) ?? []) listOrder.set(l.id, n++)

  const sectionsByList = new Map<string, Section[]>()
  for (const section of sections.values()) sectionsByList.set(section.list_id, [...(sectionsByList.get(section.list_id) ?? []), section])
  for (const group of sectionsByList.values()) group.sort(byPosition)

  const all = [...reminders.values()]
  const live = all.filter((r) => !inTrash(r))
  const isHidden = (spaceId: string) => hidden.has(spaceId)
  const visible = live.filter((r) => !isHidden(lists.get(r.list_id)?.space_id ?? ''))
  const shownSpaces = ordered.filter((s) => !isHidden(s.id))
  const privateSpace = ordered.find((s) => s.private) ?? [...spaces.values()].find((s) => s.private)
  const firstPrivateList = privateSpace ? (listsBySpace.get(privateSpace.id) ?? [])[0] : undefined
  const defaultSpace = [...shownSpaces].sort((a, b) => Number(b.private) - Number(a.private)).find((s) => (listsBySpace.get(s.id) ?? []).length)

  const trash = {
    spaces: [...spaces.values()].filter((s) => s.deleted_at),
    lists: [...lists.values()].filter((l) => l.deleted_at && !spaceGone(l.space_id)),
    reminders: all.filter((r) => {
      if (!r.deleted_at) return false
      const list = lists.get(r.list_id)
      if (!list || listInTrash(list)) return false
      if (r.parent_id && reminders.get(r.parent_id)?.deleted_at) return false
      return true
    }),
  }

  const filterList = [...filters.values()].sort(byPosition)

  return {
    me,
    people,
    spaces: ordered,
    shownSpaces,
    hiddenSpaces: ordered.filter((s) => isHidden(s.id)),
    isHidden,
    space: (id) => spaces.get(id),
    list: (id) => lists.get(id),
    section: (id) => sections.get(id),
    listsOf: (spaceId) => listsBySpace.get(spaceId) ?? [],
    sectionsOf: (listId) => sectionsByList.get(listId) ?? [],
    reminder: (id) => reminders.get(id),
    reminders: all,
    live,
    visible,
    childrenOf: (id) => children.get(id) ?? [],
    inTrash,
    listInTrash,
    attachmentsOf: (id) => (attachments.get(id) ?? []).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)),
    membersOf: (spaceId) => members.get(spaceId) ?? [],
    pref: (listId) => prefs.get(listId) ?? { id: listId, show_completed: false, notify_changes: false },
    privateSpace,
    firstPrivateList,
    defaultList: defaultSpace ? (listsBySpace.get(defaultSpace.id) ?? [])[0] : undefined,
    trash,
    filters: filterList,
    shownFilters: filterList.filter((f) => !f.hidden),
    filter: (id) => filters.get(id),
    isTileHidden: (tileId) => hiddenTiles.has(tileId),
    spaceIndex: (id) => spaceOrder.get(id) ?? 9999,
    listIndex: (id) => listOrder.get(id) ?? 99999,
  }
}
