/**
 * The head inside a card of tasks (a section, a day, a list in a collection): small, in capitals, grey, the number
 * after it, room for one action on the right. `tone` "late" draws it red (overdue), "today" in petrol.
 */
import type { ReactNode } from 'react'

export function CardHead({ children, count, tone, action, testid }: { children: ReactNode; count?: number; tone?: 'late' | 'today'; action?: ReactNode; testid?: string }) {
  const color = tone === 'late' ? 'text-late' : tone === 'today' ? 'text-accent-400' : 'text-mist-600'
  return (
    <div className="nt-card-head" data-testid={testid ?? 'card-head'}>
      <h2 className={'nt-sec flex min-w-0 flex-1 items-baseline gap-1.5 ' + color}>{children}</h2>
      {count !== undefined && <span className={'shrink-0 text-[11px] font-semibold tabular-nums ' + color}>{count}</span>}
      {action && <span className="ml-1 flex shrink-0 items-center">{action}</span>}
    </div>
  )
}
