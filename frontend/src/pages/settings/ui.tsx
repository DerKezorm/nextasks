/**
 * Building blocks of the settings, the same as nexnotes' (`pages/settings/ui.tsx` there): whoever knows one app finds
 * the same card, row, field and button in the other.
 */
import type { LucideIcon } from 'lucide-react'
import { useCallback, useId, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiError } from '../../api/client'
import { errorText } from '../../lib/errors'
import { copyText } from '../../lib/copy'
import { Dialog } from '../../components/Dialog'

/** A card with its symbol in a small box, a title and a line of explanation. */
export function Card({ icon: Icon, title, text, children, id }: { icon: LucideIcon; title: string; text?: string; children: ReactNode; id?: string }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-[12px] border border-ink-700 bg-ink-850 p-5">
      <div className="mb-4 flex gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent-500/12 text-accent-400">
          <Icon className="h-4 w-4" strokeWidth={1.8} aria-hidden />
        </span>
        <div>
          <h2 id={id ? `${id}-title` : undefined} className="font-semibold text-mist-100">
            {title}
          </h2>
          {text && <p className="text-sm text-mist-500">{text}</p>}
        </div>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  )
}

/** A heading inside a card, for a second part of it (as nexlore's "OpenID Connect" under "Sign-in"). */
export function SubHead({ title, text }: { title: string; text?: string }) {
  return (
    <div className="pt-3">
      <h3 className="text-sm font-semibold text-mist-100">{title}</h3>
      {text && <p className="text-xs text-mist-500">{text}</p>}
    </div>
  )
}

/** A switch with its name and a line of explanation; the whole row is the label (a checkbox, as in nexnotes). */
export function Toggle({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  const hintId = useId()
  return (
    <label className="flex items-center justify-between gap-4 rounded-[12px] border border-ink-700 bg-ink-900 px-4 py-3 text-sm">
      <span>
        <span className="font-medium text-mist-100">{label}</span>
        {hint && (
          <span id={hintId} className="block text-xs text-mist-500">
            {hint}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        role="switch"
        className="h-5 w-5 shrink-0 accent-accent-500"
      />
    </label>
  )
}

/** A field with its name above it and an optional line below. */
export function Input({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  hint,
  className = '',
  autoComplete = 'off',
  min,
  max,
  list,
  maxLength,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  type?: string
  placeholder?: string
  hint?: string
  className?: string
  autoComplete?: string
  min?: number
  max?: number
  /** The id of a datalist with suggestions. */
  list?: string
  maxLength?: number
}) {
  const hintId = useId()
  return (
    <div className={'text-sm ' + className}>
      <label className="block">
        <span className="text-xs font-medium text-mist-400">{label}</span>
        <input
          type={type}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          min={min}
          max={max}
          list={list}
          maxLength={maxLength}
          aria-describedby={hint ? hintId : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="nt-field mt-1"
        />
      </label>
      {hint && (
        <span id={hintId} className="mt-1 block text-xs text-mist-500">
          {hint}
        </span>
      )}
    </div>
  )
}

export function Select<T extends string>({ label, value, options, onChange, className = '' }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void; className?: string }) {
  return (
    <label className={'block text-sm ' + className}>
      <span className="text-xs font-medium text-mist-400">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} className="nt-field mt-1 px-2">
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

export function Button({
  children,
  onClick,
  busy = false,
  accent = false,
  danger = false,
  small = false,
  type = 'button',
  disabled = false,
  label,
}: {
  children: ReactNode
  onClick?: () => void
  busy?: boolean
  accent?: boolean
  danger?: boolean
  small?: boolean
  type?: 'button' | 'submit'
  disabled?: boolean
  label?: string
}) {
  const look = accent ? 'nt-btn-accent' : danger ? 'nt-btn-ghost hover:border-bad-500/50 hover:text-bad-500' : 'nt-btn-ghost'
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={busy || disabled}
      aria-label={label}
      className={`nt-btn ${small ? 'h-8 px-2.5 text-xs' : ''} ${look}`}
    >
      {children}
    </button>
  )
}

/** One line under a card: what went wrong, or that it worked. */
export function Feedback({ problem, done = null }: { problem: string | null; done?: string | null }) {
  return (
    <div aria-live="polite">
      {problem && (
        <p role="alert" className="text-sm text-bad-500">
          {errorText(problem)}
        </p>
      )}
      {done && (
        <p role="status" className="text-sm text-ok-500">
          {done}
        </p>
      )}
    </div>
  )
}

/** A link or value to copy: the field and the button that copies it. */
export function CopyLink({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-[12px] border border-accent-500/40 bg-accent-500/10 p-2">
      <input readOnly value={value} aria-label={label} onFocus={(event) => event.target.select()} className="min-w-0 flex-1 bg-transparent px-2 font-mono text-xs text-mist-100 outline-none" />
      <button
        type="button"
        onClick={() => void copyText(value).then(setCopied)}
        className="nt-btn nt-btn-accent h-8 shrink-0 px-3 text-xs"
      >
        {copied ? '✓' : t('common.copy')}
      </button>
    </div>
  )
}

/** Runs a change, remembers whether it worked; the card shows it with `Feedback`. */
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

/** "Really?" with the operator's password where the server asks for it again. */
export function Confirm({ title, text, confirm, danger = false, password = false, onCancel, onConfirm }: {
  title: string
  text: string
  confirm: string
  danger?: boolean
  password?: boolean
  onCancel: () => void
  onConfirm: (password: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')
  const { busy, problem, run } = useAction()
  /** One request at a time: a second click before the button shows busy does nothing. */
  const running = useRef(false)
  return (
    <Dialog title={title} onClose={onCancel}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (running.current) return
          running.current = true
          void run(() => onConfirm(value)).finally(() => {
            running.current = false
          })
        }}
      >
        <p className="text-sm text-mist-300">{text}</p>
        {password && <input className="nt-field" type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('settings.ownPassword')} autoComplete="current-password" autoFocus />}
        <Feedback problem={problem} />
        <div className="flex justify-end gap-2">
          <button type="button" className="nt-btn nt-btn-ghost" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button type="submit" disabled={busy} className={'nt-btn ' + (danger ? 'nt-btn-danger' : 'nt-btn-accent')}>
            {confirm}
          </button>
        </div>
      </form>
    </Dialog>
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
