/**
 * How wide the sidebar is on this device, as nexnotes' `lib/columns.ts`: dragged at its edge or moved with the arrow
 * keys, a double click goes back to the default. The same default and bounds as there.
 */
import { useDevicePref } from './devicePref'

export type Column = 'sidebar'

export const COLUMNS: Record<Column, { fallback: number; min: number; max: number }> = {
  // As nexnotes: 260 px. Narrower, the names of lists and the account line no longer read.
  sidebar: { fallback: 260, min: 200, max: 440 },
}

/** One press of an arrow key on the handle. */
export const COLUMN_STEP = 16

export function clampColumn(column: Column, width: number): number {
  const { min, max } = COLUMNS[column]
  return Math.round(Math.min(max, Math.max(min, width)))
}

export function parseColumn(column: Column, raw: string | null): number {
  const value = raw === null ? NaN : Number(raw)
  return Number.isFinite(value) ? clampColumn(column, value) : COLUMNS[column].fallback
}

/** The width of `column` and how to set it (clamped); `null` back to the default. */
export function useColumnWidth(column: Column): [number, (width: number | null) => void] {
  const [width, set] = useDevicePref(`column.${column}`, (raw) => parseColumn(column, raw))
  return [width, (next) => set(next === null ? null : String(clampColumn(column, next)))]
}
