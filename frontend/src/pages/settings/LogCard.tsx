/**
 * Server › Log: the card "Log" of the shared module log (`vendor/nexlog`, bauplaene/log 1.0.0), built from the ui kit.
 * nextasks hands it its client, its word for what it keeps and its way of writing a moment (in the account's time
 * zone, E14, E40).
 */
import { useTranslation } from 'react-i18next'

import { api } from '../../api/client'
import { clockIn, momentIn } from '../../lib/time'
import { useAuth } from '../../state/auth'
import { LogCard as SharedLogCard } from '../../vendor/nexlog/LogCard'
import type { LogLine, LogRequest } from '../../vendor/nexlog/log'

const request: LogRequest = <T,>(path: string, init: Parameters<LogRequest>[1] = {}) => api<T>(path, init)

/** Lines and the end of a deep level in the account's time zone (E14, decided E40). */
export function LogCard() {
  const { t } = useTranslation()
  const zone = useAuth().me?.timezone
  const when = (line: LogLine, language: string) => (line.at ? momentIn(line.at, language, zone) : line.time)
  const clock = (iso: string, language: string) => clockIn(iso, language, zone)
  return <SharedLogCard request={request} base="/api/logs" things={t('settings.things')} thingsDative={t('settings.thingsDative')} when={when} clock={clock} />
}
