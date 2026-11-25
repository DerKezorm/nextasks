/**
 * Über nextasks, the ui kit's `AboutPage` (plan "Einstellungen", "Über"): version, what is new, licence, where it comes
 * from, whether a newer one is out, and what it is built with. The last entry of the settings' navigation.
 *
 * The switch for the daily check stands here, where its answer shows, and the page says what goes out: the question
 * to GitHub is the one call nextasks makes by itself. Every account sees the answer; switching and asking now belong
 * to the operator, because the question goes out for the whole installation.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { api, ApiError } from '../../api/client'
import { errorText, problemText } from '../../lib/errors'
import { moment } from '../../lib/time'
import { useWhatsNew } from '../../lib/whatsNew'
import { useAuth } from '../../state/auth'
import { AboutPage, Notice, type BuiltWith } from '../../vendor/nexui'

type About = { version: string; license: string; repo_url: string; releases_url: string; project_url: string }
type Updates = { update_check: boolean; checked: boolean; latest: string | null; newer: boolean; checked_at: string | null; release_url: string | null }

const PARTS: BuiltWith[] = [
  { name: 'FastAPI', url: 'https://fastapi.tiangolo.com', licence: 'MIT' },
  { name: 'SQLAlchemy', url: 'https://www.sqlalchemy.org', licence: 'MIT' },
  { name: 'SQLite', url: 'https://sqlite.org', licence: 'Public Domain' },
  { name: 'Pillow', url: 'https://python-pillow.org', licence: 'MIT-CMU' },
  { name: 'pillow-heif', url: 'https://github.com/bigcat88/pillow_heif', licence: 'BSD-3' },
  { name: 'React', url: 'https://react.dev', licence: 'MIT' },
  { name: 'Vite', url: 'https://vite.dev', licence: 'MIT' },
  { name: 'Tailwind CSS', url: 'https://tailwindcss.com', licence: 'MIT' },
  { name: 'Lucide', url: 'https://lucide.dev', licence: 'ISC' },
  { name: 'i18next', url: 'https://www.i18next.com', licence: 'MIT' },
  { name: 'Inter', url: 'https://rsms.me/inter/', licence: 'OFL-1.1' },
]

function says(error: unknown): string {
  return error instanceof ApiError ? problemText(error) : errorText('internal_error')
}

export function AboutArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const [about, setAbout] = useState<About | null>(null)
  const [updates, setUpdates] = useState<Updates | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // The written text of the running version, to read again at any time.
  const { entry } = useWhatsNew(me?.version, i18n.language)

  const load = useCallback(() => {
    api<About>('/api/about').then(setAbout, (error: unknown) => setProblem(says(error)))
    // The answer is a side matter: when it does not come, the page simply shows none.
    api<Updates>('/api/about/updates').then(setUpdates, () => setUpdates(null))
  }, [])
  useEffect(load, [load])

  async function checkNow() {
    setBusy(true)
    try {
      setUpdates(await api<Updates>('/api/about/updates/check', { method: 'POST' }))
      setProblem(null)
    } catch (error) {
      setProblem(says(error))
    } finally {
      setBusy(false)
    }
  }

  async function switchCheck(on: boolean) {
    if (updates) setUpdates({ ...updates, update_check: on })
    try {
      setUpdates(await api<Updates>('/api/about/updates', { method: 'PUT', body: { update_check: on } }))
    } catch (error) {
      setProblem(says(error))
      load()
    }
  }

  if (!about) return problem ? <Notice tone="danger">{problem}</Notice> : null
  return (
    <AboutPage
      app="nextasks"
      logo="/logo.svg"
      tagline={t('about.subtitle')}
      version={about.version}
      whatsNew={entry}
      licence={{ name: about.license, href: 'https://www.gnu.org/licenses/agpl-3.0.html' }}
      source={about.repo_url}
      releases={about.releases_url}
      project={about.project_url || null}
      updates={
        updates
          ? {
              checkDaily: updates.update_check,
              checked: updates.checked,
              latest: updates.latest,
              newer: updates.newer,
              checkedAt: updates.checked_at ? moment(updates.checked_at, i18n.language) : null,
              releaseUrl: updates.release_url,
            }
          : null
      }
      operator={me?.role === 'operator'}
      onDaily={(on) => void switchCheck(on)}
      onCheck={() => void checkNow()}
      checking={busy}
      builtWith={PARTS}
      problem={problem}
      texts={{ updatesWhatGoesOut: t('about.updates.whatGoesOut') }}
    />
  )
}
