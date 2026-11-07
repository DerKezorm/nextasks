/**
 * The symbol of each collection (docs "Aussehen", principle 4). They are all drawn in petrol, without a ground; the
 * collections have no colours of their own.
 */
import { Bookmark, Calendar, CircleCheck, Inbox, Sun, User, type LucideIcon } from 'lucide-react'

import type { Tile } from '../sync/tiles'

export const TILE_LOOK: Record<Tile, { icon: LucideIcon }> = {
  today: { icon: Sun },
  scheduled: { icon: Calendar },
  all: { icon: Inbox },
  flagged: { icon: Bookmark },
  assigned: { icon: User },
  done: { icon: CircleCheck },
}
