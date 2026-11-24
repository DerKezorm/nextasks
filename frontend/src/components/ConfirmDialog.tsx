/**
 * The question before deleting, as nexnotes asks it: what goes, then in red that it cannot be undone where it really
 * is for good, otherwise where it goes (the trash); "Cancel" and the red button on the right.
 */
import { useTranslation } from 'react-i18next'

import { Dialog } from './Dialog'

export interface Question {
  title: string
  text: string
  /** Gone for good: the red line "This cannot be undone." */
  final?: boolean
  /** The red button's word. */
  confirm: string
  /** Nothing goes: the button in the accent's colour instead of red. */
  calm?: boolean
  run: () => void
}

export function ConfirmDialog({ question, onClose }: { question: Question; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <Dialog title={question.title} onClose={onClose}>
      <div className="flex flex-col gap-3.5" data-testid="confirm-dialog">
        <p className="text-sm leading-relaxed text-mist-300">{question.text}</p>
        {question.final && <p className="text-sm font-semibold text-bad-500">{t('common.final')}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="nt-btn nt-btn-ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={'nt-btn ' + (question.calm ? 'nt-btn-accent' : 'nt-btn-danger')}

            data-testid="confirm-go"
            onClick={() => {
              onClose()
              question.run()
            }}
          >
            {question.confirm}
          </button>
        </div>
      </div>
    </Dialog>
  )
}
