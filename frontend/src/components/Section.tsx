import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * A card of the settings that lays out its own inside: the frame, the symbol in its small box and the title of every
 * other card (`pages/settings/ui.tsx`, `Card`, as nexnotes'), with an optional line below the title.
 */
export function Section({ icon: Icon, title, text, children, id }: { icon: LucideIcon; title: string; text?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-[12px] border border-ink-700 bg-ink-850 p-5">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-wash text-accent-400">
          <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
        </span>
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="font-semibold text-mist-100">
            {title}
          </h2>
          {text && <p className="text-sm text-mist-500">{text}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}
