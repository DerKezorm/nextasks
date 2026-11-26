/**
 * E65 (ui 1.1.2): how the settings write a moment, the one form of all apps ("heute, 14:05", "24.02.2027, 14:05"), in
 * the account's own time zone (E14). Handed to the module cards as their `when` and used for the app's own facts.
 */
import { useTranslation } from 'react-i18next'

import { useAuth } from '../state/auth'
import { momentIn } from './time'

export function useWhen(): (iso: string, language?: string) => string {
  const { i18n } = useTranslation()
  const zone = useAuth().me?.timezone
  return (iso, language) => momentIn(iso, language ?? i18n.language, zone)
}
