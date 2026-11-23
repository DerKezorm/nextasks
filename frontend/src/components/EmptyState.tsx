/** A place with nothing in it, as nexnotes shows an empty folder: a dashed box with a symbol, a title, a line, a button. */
import { Plus, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function EmptyState({ icon: Icon, title, text, action, onAction, children }: { icon: LucideIcon; title: string; text?: string; action?: string; onAction?: () => void; children?: ReactNode }) {
  return (
    <div data-testid="empty-state" className="mb-3 flex min-h-[260px] flex-col items-center justify-center gap-3.5 rounded-[16px] border border-dashed border-ink-600 p-6 text-center">
      <Icon aria-hidden className="h-12 w-12 text-accent-400" strokeWidth={1.3} />
      <p className="text-lg font-semibold text-mist-100">{title}</p>
      {text && <p className="max-w-sm text-sm leading-relaxed text-mist-500">{text}</p>}
      {action && onAction && (
        <button type="button" className="nt-btn nt-btn-accent" onClick={onAction} data-testid="empty-new">
          <Plus aria-hidden className="h-4 w-4" />
          {action}
        </button>
      )}
      {children}
    </div>
  )
}
