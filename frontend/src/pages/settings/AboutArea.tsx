/**
 * Über nextasks, the ui kit's `AboutPage` (plan "Einstellungen", "Über"): version, what is new, licence, where it comes
 * from, whether a newer one is out, and what it is built with. The last entry of the settings' navigation.
 *
 * The card "Aktualisierungen" comes from the shared module updates (`vendor/nexupdates`, 0.1.3) over its routes
 * (`/api/about`): only the operator sees it, switches the daily check and asks now (U2, U15); a member sees only the
 * own version. The sentence on what goes out names the address asked and nextasks' other calls by itself (U11). The
 * hint under the switch says when nextasks asks: it has no bell, so when an operator opens this page, and once a day
 * while a device of an operator wants to hear of new versions (U24).
 */
import { useTranslation } from 'react-i18next'

import { moduleFetch } from '../../api/client'
import { momentIn } from '../../lib/time'
import { useAuth } from '../../state/auth'
import { AboutPage, Notice, type BuiltWith } from '../../vendor/nexui'
import { dailyHint, useUpdates, useUpdatesTexts, whatGoesOut } from '../../vendor/nexupdates/updates'
import { useAboutWhatsNew } from '../../vendor/nexwasneu'

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

/** nextasks' own way to the modules' routes: every request names its tab (changes are refused without it). */
const fetcher = moduleFetch

export function AboutArea() {
  const { t, i18n } = useTranslation()
  const { me } = useAuth()
  const operator = me?.role === 'operator'
  const language = i18n.language
  const state = useUpdates({ fetcher, operator, language, when: (iso) => momentIn(iso, language, me?.timezone) })
  // "What's new" (wasneu 0.1.0): the newest text up to the running version, with the earlier ones (W18).
  const news = useAboutWhatsNew({ app: 'nextasks', logo: '/logo.svg', fetcher, language })
  const texts = useUpdatesTexts(language)

  const about = state.about
  if (!about) return state.problem ? <Notice tone="danger">{state.problem}</Notice> : null
  return (
    <>
      <AboutPage
        app="nextasks"
        logo="/logo.svg"
        tagline={t('about.subtitle')}
        version={about.version}
        {...news.about}
        licence={{ name: about.license, href: 'https://www.gnu.org/licenses/agpl-3.0.html' }}
        source={about.repo_url}
        releases={about.releases_url}
        project={about.project_url || null}
        updates={state.updates}
        showUpdates={state.showUpdates}
        operator={operator}
        onDaily={state.onDaily}
        onCheck={state.onCheck}
        checking={state.checking}
        builtWith={PARTS}
        problem={state.problem}
        texts={{
          updatesWhatGoesOut: whatGoesOut(texts, 'nextasks', undefined, [t('about.otherCalls')]),
          updatesDailyHint: dailyHint(texts, { bell: false, devices: true }),
        }}
      />
      {news.window}
    </>
  )
}
