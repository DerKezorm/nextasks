/**
 * Server › Log: the card "Log" of the shared module log (`vendor/nexlog`, bauplaene/log 1.0.0), built from the ui kit.
 * nextasks hands it its client, its word for what it keeps and its way of writing a moment (the reader's own time, as
 * everywhere in nextasks).
 */
import { useTranslation } from 'react-i18next'

import { api } from '../../api/client'
import { moment } from '../../lib/time'
import { LogCard as SharedLogCard } from '../../vendor/nexlog/LogCard'
import type { LogLine, LogRequest } from '../../vendor/nexlog/log'

const request: LogRequest = <T,>(path: string, init: Parameters<LogRequest>[1] = {}) => api<T>(path, init)

const when = (line: LogLine, language: string) => (line.at ? moment(line.at, language) : line.time)

const clock = (iso: string, language: string) => new Date(iso).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })

export function LogCard() {
  const { t } = useTranslation()
  return <SharedLogCard request={request} base="/api/logs" things={t('settings.things')} when={when} clock={clock} />
}
