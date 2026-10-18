/**
 * UI primitives.
 *
 * Anything involving focus management or ARIA is built on Radix rather than
 * hand-rolled — a focus trap written from scratch is how accessibility bugs
 * ship. Everything else is a thin, typed wrapper over a real HTML element, so
 * keyboard behaviour and form semantics come for free.
 *
 * Specification: docs/07-ui-screens.md section 7.
 */

import * as Dialog from '@radix-ui/react-dialog'
import { AlertCircle, Check, Info, Loader2, X } from 'lucide-react'
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useId,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react'

import s from './ui.module.css'

const cx = (...parts: Array<string | false | undefined | null>) => parts.filter(Boolean).join(' ')

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  loading?: boolean
  size?: 'sm' | 'md'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', loading = false, size = 'md', children, className, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      className={cx(s.button, s[variant], size === 'sm' && s.sm, className)}
      // A loading button must not be clickable twice; this is what stops a
      // double-click creating two of something.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Loader2 className={s.spin} size={15} aria-hidden />}
      {children}
    </button>
  )
})

// ---------------------------------------------------------------------------
// Form field
// ---------------------------------------------------------------------------

interface FieldContextValue {
  id: string
  errorId: string
  hintId: string
  hasError: boolean
  hasHint: boolean
}

const FieldContext = createContext<FieldContextValue | null>(null)

export interface FieldProps {
  label: string
  error?: string
  hint?: ReactNode
  required?: boolean
  children: ReactNode
  className?: string
}

/**
 * Wires a real `<label>` to its control and announces errors.
 *
 * The error is tied with `aria-describedby` and marked `role="alert"`, so a
 * screen reader hears it when it appears rather than only on focus.
 */
export function Field({ label, error, hint, required, children, className }: FieldProps) {
  const base = useId()
  const ctx = useMemo<FieldContextValue>(
    () => ({
      id: base,
      errorId: `${base}-error`,
      hintId: `${base}-hint`,
      hasError: Boolean(error),
      hasHint: Boolean(hint),
    }),
    [base, error, hint],
  )

  return (
    <div className={cx(s.field, className)}>
      <label className={s.label} htmlFor={base}>
        {label}
        {required && (
          <span className={s.required} aria-hidden>
            {' '}
            *
          </span>
        )}
      </label>
      <FieldContext.Provider value={ctx}>{children}</FieldContext.Provider>
      {hint && !error && (
        <p className={s.hint} id={ctx.hintId}>
          {hint}
        </p>
      )}
      {error && (
        <p className={s.error} id={ctx.errorId} role="alert">
          <AlertCircle size={13} aria-hidden /> {error}
        </p>
      )}
    </div>
  )
}

function useFieldAria() {
  const ctx = useContext(FieldContext)
  if (!ctx) return {}
  const describedBy = [ctx.hasError ? ctx.errorId : null, ctx.hasHint ? ctx.hintId : null]
    .filter(Boolean)
    .join(' ')
  return {
    id: ctx.id,
    'aria-invalid': ctx.hasError || undefined,
    ...(describedBy ? { 'aria-describedby': describedBy } : {}),
  }
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} className={cx(s.input, className)} {...useFieldAria()} {...rest} />
  },
)

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return (
      <textarea ref={ref} className={cx(s.input, s.textarea, className)} {...useFieldAria()} {...rest} />
    )
  },
)

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, children, ...rest }, ref) {
    return (
      <select ref={ref} className={cx(s.input, s.select, className)} {...useFieldAria()} {...rest}>
        {children}
      </select>
    )
  },
)

export function Checkbox({
  label,
  description,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: string }) {
  const id = useId()
  return (
    <div className={s.checkRow}>
      <input id={id} type="checkbox" className={s.checkbox} {...rest} />
      <div>
        <label htmlFor={id} className={s.checkLabel}>
          {label}
        </label>
        {description && <p className={s.hint}>{description}</p>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Status and feedback
// ---------------------------------------------------------------------------

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'pending'
}) {
  return <span className={cx(s.badge, s[`badge_${tone}`])}>{children}</span>
}

/**
 * An error surfaced inline, with the request id available for support.
 *
 * Users are not asked to read a stack trace, but a reference they can quote
 * turns "it broke" into a specific line in the log.
 */
export function ErrorNotice({
  title = 'Something went wrong',
  error,
  onRetry,
}: {
  title?: string
  error: unknown
  onRetry?: () => void
}) {
  const message = error instanceof Error ? error.message : String(error)
  const requestId = (error as { requestId?: string } | null)?.requestId

  return (
    <div className={s.notice} role="alert">
      <AlertCircle size={16} aria-hidden className={s.noticeIcon} />
      <div className={s.noticeBody}>
        <strong>{title}</strong>
        <p>{message}</p>
        {requestId && <p className={s.noticeRef}>Reference: {requestId}</p>}
      </div>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

export function InfoNotice({ children }: { children: ReactNode }) {
  return (
    <div className={cx(s.notice, s.noticeInfo)}>
      <Info size={16} aria-hidden className={s.noticeIcon} />
      <div className={s.noticeBody}>{children}</div>
    </div>
  )
}

/** Explains what would appear here, and offers the action that creates it. */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{title}</p>
      <p className={s.emptyBody}>{description}</p>
      {action && <div className={s.emptyAction}>{action}</div>}
    </div>
  )
}

/** Fixed-height skeleton rows, so content arriving causes no layout shift. */
export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className={s.skeletonWrap} aria-busy="true" aria-live="polite">
      <span className="visually-hidden">Loading</span>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={s.skeletonRow} />
      ))}
    </div>
  )
}

export function FullPageSpinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className={s.fullPage} role="status">
      <Loader2 className={s.spin} size={22} aria-hidden />
      <p>{label}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialog (Radix: focus trap, escape handling and ARIA come from the primitive)
// ---------------------------------------------------------------------------

export interface ModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: string
  children?: ReactNode
  footer?: ReactNode
  wide?: boolean
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  wide,
}: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={s.overlay} />
        <Dialog.Content className={cx(s.modal, wide && s.modalWide)}>
          <div className={s.modalHead}>
            <Dialog.Title className={s.modalTitle}>{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className={s.iconButton} aria-label="Close">
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </div>
          {description && (
            <Dialog.Description className={s.modalDescription}>{description}</Dialog.Description>
          )}
          <div className={s.modalBody}>{children}</div>
          {footer && <div className={s.modalFoot}>{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * A confirmation that states the consequence before it happens.
 *
 * `consequence` is deliberately a required prop: "Are you sure?" tells the user
 * nothing, while "The room will be free immediately and 3 people emailed" does.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmLabel = 'Confirm',
  destructive = false,
  loading = false,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  consequence: ReactNode
  confirmLabel?: string
  destructive?: boolean
  loading?: boolean
  onConfirm: () => void
  children?: ReactNode
}) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={destructive ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className={s.consequence}>{consequence}</div>
      {children}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

interface Toast {
  id: number
  message: string
  tone: 'success' | 'error'
}

const ToastContext = createContext<{
  show: (message: string, tone?: Toast['tone']) => void
} | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const show = useCallback((message: string, tone: Toast['tone'] = 'success') => {
    const id = Date.now() + Math.random()
    setToasts(current => [...current, { id, message, tone }])
    window.setTimeout(() => setToasts(current => current.filter(t => t.id !== id)), 5000)
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* Polite, so it does not interrupt whatever the user is reading. */}
      <div className={s.toastWrap} role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={cx(s.toast, t.tone === 'error' && s.toastError)}>
            {t.tone === 'success' ? <Check size={15} aria-hidden /> : <AlertCircle size={15} aria-hidden />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: ReactNode
}) {
  return (
    <header className={s.pageHeader}>
      <div>
        <h1 className={s.pageTitle}>{title}</h1>
        {description && <p className={s.pageDescription}>{description}</p>}
      </div>
      {actions && <div className={s.pageActions}>{actions}</div>}
    </header>
  )
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx(s.card, className)}>{children}</section>
}

export { s as uiStyles }
