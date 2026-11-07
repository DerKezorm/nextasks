/**
 * Colours and symbols of spaces and lists: the names the data model stores (`symbole.json`, column `lucide`), drawn
 * with lucide-react. An unknown name shows `list`.
 */
import {
  Banknote,
  Bell,
  Bike,
  Book,
  Bookmark,
  Briefcase,
  Cake,
  Calendar,
  Camera,
  Car,
  Clock,
  Coffee,
  CreditCard,
  Dumbbell,
  FileText,
  Film,
  Flag,
  Folder,
  Gamepad2,
  Gift,
  Globe,
  GraduationCap,
  Hammer,
  Heart,
  House,
  Inbox,
  Laptop,
  Leaf,
  Lightbulb,
  List,
  Lock,
  Moon,
  Music,
  Paintbrush,
  PawPrint,
  Pill,
  Plane,
  ShoppingCart,
  Smartphone,
  Star,
  Stethoscope,
  Sun,
  Trophy,
  User,
  Users,
  Utensils,
  type LucideIcon,
} from 'lucide-react'

import { COLORS } from '../sync/types'

/** The symbols in the order of `symbole.json`. */
export const ICONS: [string, LucideIcon][] = [
  ['list', List],
  ['cart', ShoppingCart],
  ['house', House],
  ['briefcase', Briefcase],
  ['gift', Gift],
  ['heart', Heart],
  ['star', Star],
  ['book', Book],
  ['school', GraduationCap],
  ['sport', Dumbbell],
  ['car', Car],
  ['bike', Bike],
  ['plane', Plane],
  ['food', Utensils],
  ['coffee', Coffee],
  ['health', Pill],
  ['doctor', Stethoscope],
  ['pet', PawPrint],
  ['plant', Leaf],
  ['tools', Hammer],
  ['paint', Paintbrush],
  ['music', Music],
  ['game', Gamepad2],
  ['film', Film],
  ['camera', Camera],
  ['calendar', Calendar],
  ['clock', Clock],
  ['bell', Bell],
  ['flag', Flag],
  ['bookmark', Bookmark],
  ['inbox', Inbox],
  ['folder', Folder],
  ['document', FileText],
  ['money', Banknote],
  ['card', CreditCard],
  ['people', Users],
  ['person', User],
  ['computer', Laptop],
  ['phone', Smartphone],
  ['globe', Globe],
  ['sun', Sun],
  ['moon', Moon],
  ['party', Cake],
  ['trophy', Trophy],
  ['idea', Lightbulb],
  ['lock', Lock],
]

const BY_NAME = new Map(ICONS)

export function iconFor(name: string | null | undefined): LucideIcon {
  return BY_NAME.get(name ?? '') ?? List
}

/**
 * nextasks' own list colours (docs "Aussehen", principle 2): a little calmer than system colours, each dark enough to
 * carry the white symbol of a plaque. The names are the data model's.
 */
const HEX: Record<string, string> = {
  red: '#d9534f',
  orange: '#dd7a2e',
  yellow: '#d39b12',
  green: '#4f9e3f',
  teal: '#22a08a',
  blue: '#3a84d0',
  indigo: '#5b68cc',
  purple: '#8a59c0',
  pink: '#d65a7c',
  brown: '#9a7550',
  gray: '#7a8890',
}

export const COLOR_NAMES = COLORS

export function colorOf(name: string | null | undefined): string {
  return HEX[name ?? ''] ?? HEX.blue
}
