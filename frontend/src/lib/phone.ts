/** Whether the window is as narrow as a phone's (below `md`, where the sidebar becomes a page of its own). */
import { useEffect, useState } from 'react'

export const PHONE = '(max-width: 767px)'

/** Followed as the window changes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(PHONE).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE)
    const change = () => setPhone(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [])
  return phone
}
