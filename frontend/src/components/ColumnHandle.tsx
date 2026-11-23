/**
 * The handle on the right edge of the sidebar, as nexnotes' `ColumnHandle`: drag it, or focus it and use the arrow
 * keys; Home and End go to the narrowest and widest, a double click back to the default. Only where the column is
 * beside something: never on a phone.
 */
import { type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { COLUMN_STEP, COLUMNS, useColumnWidth, type Column } from '../lib/columns'

export function ColumnHandle({ column }: { column: Column }) {
  const { t } = useTranslation()
  const [width, setWidth] = useColumnWidth(column)
  const { min, max } = COLUMNS[column]

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    const target = event.currentTarget
    const startX = event.clientX
    const startWidth = width
    target.setPointerCapture?.(event.pointerId)
    const move = (next: PointerEvent) => setWidth(startWidth + next.clientX - startX)
    const up = () => {
      target.removeEventListener('pointermove', move)
      target.removeEventListener('pointerup', up)
      target.removeEventListener('pointercancel', up)
    }
    target.addEventListener('pointermove', move)
    target.addEventListener('pointerup', up)
    target.addEventListener('pointercancel', up)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(`columns.${column}`)}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      tabIndex={0}
      title={t('columns.hint')}
      data-testid={`column-handle-${column}`}
      className="group absolute inset-y-0 -right-[5px] z-10 flex w-[10px] cursor-col-resize touch-none justify-center outline-offset-[-2px]"
      onPointerDown={onPointerDown}
      onDoubleClick={() => setWidth(null)}
      onKeyDown={(event) => {
        const step = { ArrowLeft: -COLUMN_STEP, ArrowRight: COLUMN_STEP }[event.key]
        if (step) setWidth(width + step)
        else if (event.key === 'Home') setWidth(min)
        else if (event.key === 'End') setWidth(max)
        else return
        event.preventDefault()
      }}
    >
      <span aria-hidden className="h-full w-[2px] bg-transparent transition-colors group-hover:bg-ink-600 group-focus-visible:bg-accent-500" />
    </div>
  )
}
