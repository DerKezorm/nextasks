/** The notice itself, at the bottom in the middle, as nexnotes draws it: no cross, "Undo" where there is a way back. */
import { useTranslation } from 'react-i18next'

import { hideNotice, useNotice } from '../lib/notice'

export function NoticeHost() {
  const { t } = useTranslation()
  const shown = useNotice()
  if (!shown) return null
  return (
    <div className="nt-safe-bottom pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4" aria-live="polite">
      <div
        key={shown.key}
        role="status"
        data-testid="notice"
        className="pointer-events-auto flex max-w-full items-center gap-3 rounded-[12px] border border-ink-600 bg-ink-800 py-2.5 pr-3 pl-4 text-[13.5px] text-mist-100 shadow-xl shadow-black/50"
      >
        <span className="min-w-0">{shown.text}</span>
        {shown.undo && (
          <button
            type="button"
            data-testid="notice-undo"
            onClick={() => {
              shown.undo?.()
              hideNotice()
            }}
            className="shrink-0 rounded-md px-2 py-1 font-semibold text-accent-400 hover:bg-ink-700"
          >
            {t('notice.undo')}
          </button>
        )}
      </div>
    </div>
  )
}
