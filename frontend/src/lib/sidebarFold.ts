/**
 * Which parts of the sidebar are folded (the filters, each space, the hidden spaces), kept on this device for the
 * account signed in (`nextasks.sidebar.fold.<part>.<account>`), as the width of the column. Only a choice away from
 * the default is stored.
 */
import { useDevicePref } from './devicePref'

/** What a stored value means: "open" or "shut"; anything else is the default. */
export function parseFold(raw: string | null, openByDefault: boolean): boolean {
  return raw === 'open' ? true : raw === 'shut' ? false : openByDefault
}

/** Whether the part `name` is open, and how to open or fold it. */
export function useFold(name: string, openByDefault = true): [boolean, (open: boolean) => void] {
  const [open, set] = useDevicePref(`sidebar.fold.${name}`, (raw) => parseFold(raw, openByDefault))
  return [open, (next) => set(next === openByDefault ? null : next ? 'open' : 'shut')]
}
