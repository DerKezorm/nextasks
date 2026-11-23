/**
 * A picture of a note over the whole page, as nexnotes' large view (`Lightbox` there): it covers the app in both modes,
 * nothing of it shows through; the bar on top has a ground of its own with the name and "Close", readable at 4.5:1 and
 * more (`.nt-viewer`, `.nt-viewer-bar`). Over the page, outside the editor; a click on the picture, "Close" and Escape
 * close it, focus comes back afterwards.
 */
import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

export function PictureViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const { t } = useTranslation()
  const closeButton = useRef<HTMLButtonElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    closeButton.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        close.current()
      }
    }
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      before?.focus?.()
    }
  }, [])
  const title = name || t('detail.picture')
  return createPortal(
    <div className="nt-viewer fixed inset-0 z-[80] flex flex-col" role="dialog" aria-modal="true" aria-label={title} data-testid="picture-viewer">
      <div className="nt-viewer-bar flex items-center gap-3 px-4 py-3 text-sm" data-testid="viewer-bar">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <button ref={closeButton} type="button" className="nt-btn nt-btn-ghost h-9 w-9 px-0" onClick={onClose} aria-label={t('common.close')}>
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <button type="button" className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center p-4" onClick={onClose} aria-label={t('common.close')}>
        <img src={url} alt={name} className="max-h-full max-w-full object-contain" />
      </button>
    </div>,
    document.body,
  )
}
