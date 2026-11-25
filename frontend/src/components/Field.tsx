/** That something worked, and a problem as a red box: small pieces of the settings, as in nexlore. */

/** That it worked, as nexnotes' settings say it: one green line, no box (a box stays for what went wrong). */
export function Done({ text, className = '' }: { text: string | null; className?: string }) {
  if (!text) return null
  return (
    <p role="status" className={'text-sm text-ok-500 ' + className}>
      {text}
    </p>
  )
}

export function Problem({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="rounded-[9px] border border-bad-500/30 bg-bad-500/10 px-3 py-2 text-sm text-bad-500">
      {text}
    </p>
  )
}
