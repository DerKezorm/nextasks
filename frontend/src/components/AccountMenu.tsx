import { useAnchoredMenu } from '../lib/anchoredMenu'
import { Globe, Info, LogOut, Settings, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate } from 'react-router-dom'

import { authApi } from '../api/client'
import { byLanguageName, changeLanguage, languageOptions, SHIPPED, type LanguageOption } from '../i18n'
import { useAuth } from '../state/auth'
import { InstallMenuItem } from './AppInstall'
import { Avatar } from './Avatar'

/**
 * The account at the foot of the sidebar: who one is, the language, the own account, the settings, about nextasks,
 * installing as an app (where the browser offers it), signing out. `up` opens the menu above the button, as it sits at the bottom.
 */
export function AccountMenu({ up = false }: { up?: boolean }) {
  const { t, i18n } = useTranslation()
  const auth = useAuth()
  const me = auth.me ? { id: auth.me.id, name: auth.me.name, display_name: auth.me.display_name || auth.me.name, avatar: auth.me.avatar } : { id: 0, name: '', display_name: '', avatar: null }
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // The same languages in the same order as under Settings: by name, an added one among them (decided 06.10.2026).
  const [languages, setLanguages] = useState<LanguageOption[]>(() =>
    byLanguageName(Object.entries(SHIPPED).map(([code, entry]) => ({ code, name: entry.name, added: false }))),
  )
  useEffect(() => {
    if (!open) return
    let alive = true
    void languageOptions().then((list) => alive && setLanguages(list))
    return () => {
      alive = false
    }
  }, [open])
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const place = useAnchoredMenu(open, trigger, panel, { align: 'left', up })

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-mist-300 hover:bg-ink-850 hover:text-mist-100'

  return (
    <div ref={box} className="relative min-w-0 shrink">
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={t('account.menu', { name: me.display_name || me.name })}
        className="flex min-w-0 items-center gap-2 rounded-lg py-1 pr-2 pl-1 text-sm text-mist-100 select-none hover:bg-ink-800"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full">
          <Avatar person={me} className="h-full w-full text-xs" />
        </span>
        <span className="truncate font-medium">{me.display_name}</span>
      </button>
      {open && (
        <div ref={panel} style={place} className="z-40 w-72 rounded-xl border border-ink-700 bg-ink-900 p-2 text-sm shadow-2xl">
          <div className="px-3 py-2">
            <div className="font-semibold text-mist-100">
              {me.display_name}
              <span className="ml-1 text-xs font-normal text-mist-500">@{me.name}</span>
            </div>
            <div className="text-xs text-mist-500">{auth.me?.role === 'operator' ? t('account.operator') : t('server.member')}</div>
          </div>
          <label className="flex items-center justify-between gap-2 rounded-lg px-3 py-2">
            <span className="flex items-center gap-2 text-mist-400">
              <Globe className="h-4 w-4" strokeWidth={1.8} /> {t('account.language')}
            </span>
            <select
              value={i18n.language}
              onChange={(event) => {
                const code = event.target.value
                void changeLanguage(code)
                // Kept with the account, so the next browser speaks it too.
                void authApi.language(code).then(auth.setMe, () => undefined)
              }}
              className="rounded-md border border-ink-700 bg-ink-850 px-2 py-1 text-xs text-mist-100"
            >
              {languages.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.name}
                </option>
              ))}
            </select>
          </label>
          <Link to="/account" onClick={() => setOpen(false)} className={item}>
            <UserRound className="h-4 w-4" strokeWidth={1.8} /> {t('account.mine')}
          </Link>
          <Link to="/settings" onClick={() => setOpen(false)} className={item}>
            <Settings className="h-4 w-4" strokeWidth={1.8} /> {t('settings.title')}
          </Link>
          <Link to="/about" onClick={() => setOpen(false)} className={item}>
            <Info className="h-4 w-4" strokeWidth={1.8} /> {t('about.menu')}
          </Link>
          <InstallMenuItem className={item} onDone={() => setOpen(false)} />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              void auth.signOut().then(() => navigate('/login', { replace: true }))
            }}
            className={item}
          >
            <LogOut className="h-4 w-4" strokeWidth={1.8} /> {t('account.signOut')}
          </button>
        </div>
      )}
    </div>
  )
}
