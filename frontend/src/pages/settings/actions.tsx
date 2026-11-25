/**
 * Helpers of the settings that draw nothing of their own: run a change and remember whether it worked (`useAction`),
 * say so under a card from the ui kit (`Outcome`: a `Notice`), hand a file to the browser (`saveAsFile`).
 */
import { useCallback, useState } from 'react'

import { ApiError } from '../../api/client'
import { errorText } from '../../lib/errors'
import { Notice } from '../../vendor/nexui'

/** Runs a change, remembers whether it worked; the card shows it with `Outcome`. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const run = useCallback(async (work: () => Promise<unknown>, success?: string): Promise<boolean> => {
    setBusy(true)
    setProblem(null)
    setDone(null)
    try {
      await work()
      if (success) setDone(success)
      return true
    } catch (error) {
      setProblem(error instanceof ApiError ? error.code : 'internal_error')
      return false
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, problem, done, run }
}

/** One line under a card: what went wrong (by the server's code), or that it worked. */
export function Outcome({ problem, done = null }: { problem: string | null; done?: string | null }) {
  return (
    <div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
      {problem && <Notice tone="danger">{errorText(problem)}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}
    </div>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function saveAsFile(name: string, data: Blob) {
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}
