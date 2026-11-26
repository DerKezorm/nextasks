/**
 * Server › Storage and backups: the cards "Speicher" and "Sicherung" of the shared module sicherung
 * (`vendor/nexsicherung`, bauplaene/sicherung 1.0.1) over its routes (`/api/server/storage`). nextasks hands it its
 * sentence of what a backup holds, the counts of an entry and what a restore changes in the media folder (counts only:
 * the operator never reads what others wrote).
 */
import { useTranslation } from 'react-i18next'

import { tabId } from '../../api/client'
import { momentIn } from '../../lib/time'
import { useAuth } from '../../state/auth'
import { StorageArea as SharedStorageArea } from '../../vendor/nexsicherung/StorageArea'
import { makeSicherungApi, type Brief, type Entry } from '../../vendor/nexsicherung/sicherung'
import { languageOf } from '../../vendor/nexui'

/** nextasks' own client for the module: every request names its tab (changes are refused without it). */
const api = makeSicherungApi((path, init) => {
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('X-Nextasks-Client', tabId())
  return fetch(path, { ...init, headers })
}, '/api/server/storage')

const number = (value: unknown) => (typeof value === 'number' ? value : 0)

export function StorageArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const facts = (entry: Entry) =>
    entry.facts && ('tasks' in entry.facts || 'files' in entry.facts)
      ? t('server.backupContent', { tasks: t('server.backupTasks', { count: number(entry.facts.tasks) }), files: t('server.backupFiles', { count: number(entry.facts.files) }) })
      : null
  const details = (brief: Brief) => {
    const found = brief.details ?? {}
    return (
      <p className="m-0" data-testid="restore-files">
        {t('server.restoreChanges', {
          add: t('server.backupFiles', { count: number(found.would_add) }),
          change: t('server.backupFiles', { count: number(found.would_change) }),
          remove: t('server.backupFiles', { count: number(found.would_remove) }),
        })}
      </p>
    )
  }
  return (
    <SharedStorageArea
      app="nextasks"
      things={t('settings.things')}
      holds={t('server.backupHolds')}
      api={api}
      password={me?.sign_in === 'password'}
      facts={facts}
      details={details}
      language={languageOf(i18n.language)}
      when={(iso, language) => momentIn(iso, language, me?.timezone)}
    />
  )
}
