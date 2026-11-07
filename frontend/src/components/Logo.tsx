/** nextasks mark: a tick in a box, in petrol on a white ground, the same in light and dark. */
export function Logo({ className = 'h-8 w-8', withWordmark = false }: { className?: string; withWordmark?: boolean }) {
  // userSpaceOnUse, so the gradient runs across the whole mark instead of restarting for each stroke.
  const mark = (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="nextasks-mark" gradientUnits="userSpaceOnUse" x1="8" y1="8" x2="56" y2="56">
          <stop offset="0" stopColor="#7fd0e3" />
          <stop offset=".5" stopColor="#38a9c4" />
          <stop offset="1" stopColor="#0b5c70" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#fff" />
      <rect x="2.75" y="2.75" width="58.5" height="58.5" rx="15.3" fill="none" stroke="#38a9c4" strokeOpacity=".35" strokeWidth="1.5" />
      <rect x="16" y="16" width="32" height="32" rx="7" fill="none" stroke="url(#nextasks-mark)" strokeWidth="4.5" />
      <path d="M23 32.5l6.5 6.5L42 25" fill="none" stroke="#1f8fab" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
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
