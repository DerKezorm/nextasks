/** nextasks mark: a tick in a box in petrol. A white tile in light mode, a dark one in dark mode; the colours are
 * `--nt-logo-*` in styles/index.css (source nexapps/icons-vergleich/neu.py, like public/logo.svg). */
export function Logo({ className = 'h-8 w-8', withWordmark = false }: { className?: string; withWordmark?: boolean }) {
  // userSpaceOnUse, so the gradient runs across the whole mark instead of restarting for each stroke.
  const mark = (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="nextasks-mark" gradientUnits="userSpaceOnUse" x1="10" y1="10" x2="54" y2="54">
          <stop offset="0" style={{ stopColor: 'var(--nt-logo-verlauf-1)' }} />
          <stop offset=".5" style={{ stopColor: 'var(--nt-logo-verlauf-2)' }} />
          <stop offset="1" style={{ stopColor: 'var(--nt-logo-verlauf-3)' }} />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" style={{ fill: 'var(--nt-logo-grund)' }} />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" strokeWidth="1.5" style={{ stroke: 'var(--nt-logo-rand)', strokeOpacity: 'var(--nt-logo-rand-deckung)' }} />
      <rect x="16" y="16" width="32" height="32" rx="7" fill="none" stroke="url(#nextasks-mark)" strokeWidth="4.5" />
      <path d="M23 32.5l6.5 6.5L42 25" fill="none" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" style={{ stroke: 'var(--nt-logo-haken)' }} />
    </svg>
  )
  if (!withWordmark) return mark
  return (
    <span className="flex items-center gap-2.5">
      {mark}
      <span className="hidden text-lg font-bold tracking-tight sm:inline">
        NEX<span className="text-accent-500">TASKS</span>
      </span>
    </span>
  )
}
