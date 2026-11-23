import { Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { applyMode, storedMode, type Mode } from '../lib/theme'

/** Light, dark or as the system, as nexnotes': the choice belongs to this device and stays here. */
export function ThemeSwitcher({ withWords = false }: { withWords?: boolean }) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<Mode>(storedMode())
  const modes = [
    { value: 'light' as const, label: t('theme.light'), Icon: Sun },
    { value: 'dark' as const, label: t('theme.dark'), Icon: Moon },
    { value: 'system' as const, label: t('theme.system'), Icon: Monitor },
  ]
  return (
    <div className="inline-flex flex-wrap items-center gap-0.5 rounded-[9px] border border-ink-700 bg-ink-850 p-0.5" role="radiogroup" aria-label={t('theme.group')}>
      {modes.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          onClick={() => {
            applyMode(value)
            setMode(value)
          }}
          aria-checked={mode === value}
          title={label}
          aria-label={withWords ? undefined : label}
          className={
            'inline-flex items-center gap-1.5 rounded-[7px] px-2 py-1.5 text-sm transition-colors ' +
            (mode === value ? 'bg-accent-500 font-semibold text-on-accent' : 'text-mist-500 hover:text-mist-100')
          }
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2.2} aria-hidden />
          {withWords && <span className="max-w-[9rem] truncate">{label}</span>}
        </button>
      ))}
    </div>
  )
}
