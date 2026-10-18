/**
 * Accept an invitation (S-04), forgotten password (S-02) and reset (S-03).
 *
 * Grouped in one file because they are three variations on "prove you control
 * this mailbox, then choose a password", and keeping them together makes the
 * shared handling of a bad or expired token obvious.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { CheckCircle2, MailCheck } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { z } from 'zod'

import { acceptInviteSchema, forgotPasswordSchema, resetPasswordSchema } from '@roombook/shared'

import { ApiError, api, applyFieldErrors, setCsrfToken } from '../../api/client.js'
import { useAuth } from '../../auth/AuthProvider.js'
import { Button, Card, ErrorNotice, Field, Input } from '../../components/ui/index.js'
import s from './auth.module.css'

const PASSWORD_HINT = 'At least 12 characters. A memorable phrase is stronger than a short, complex password.'

// ---------------------------------------------------------------------------

type AcceptValues = z.infer<typeof acceptInviteSchema>

export function AcceptInvitePage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const { refresh } = useAuth()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<AcceptValues>({
    resolver: zodResolver(acceptInviteSchema),
    defaultValues: { token, fullName: '', password: '' },
  })

  if (!token) return <MissingToken what="invitation" />

  const onSubmit = handleSubmit(async values => {
    try {
      await api.post('/auth/accept-invite', values)
      setCsrfToken(null)
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      if (applyFieldErrors(err, setError as never)) return
      setError('root', {
        type: 'server',
        message:
          err instanceof ApiError && err.status === 422
            ? 'That invitation link is no longer valid. Ask your administrator to send a new one.'
            : 'Could not complete your setup. Please try again.',
      })
    }
  })

  return (
    <Card>
      <h1 className={s.title}>Set up your account</h1>
      <p className={s.lede}>Choose a password and you are ready to book rooms.</p>

      {errors.root && (
        <div className={s.notice}>
          <ErrorNotice title="Could not continue" error={new Error(errors.root.message)} />
        </div>
      )}

      <form className={s.form} onSubmit={onSubmit} noValidate>
        <input type="hidden" {...register('token')} />

        <Field label="Your name" error={errors.fullName?.message} required>
          <Input autoFocus autoComplete="name" {...register('fullName')} />
        </Field>

        <Field label="Choose a password" error={errors.password?.message} hint={PASSWORD_HINT} required>
          <Input type="password" autoComplete="new-password" {...register('password')} />
        </Field>

        <Button type="submit" variant="primary" loading={isSubmitting}>
          Create my account
        </Button>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------

type ForgotValues = z.infer<typeof forgotPasswordSchema>

export function ForgotPasswordPage() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isSubmitSuccessful },
  } = useForm<ForgotValues>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  const onSubmit = handleSubmit(async values => {
    // Always succeeds from the client's point of view. The server answers 202
    // whether or not the address exists, so this screen must not imply either.
    await api.post('/auth/forgot-password', values).catch(() => undefined)
  })

  if (isSubmitSuccessful) {
    return (
      <Card>
        <div className={s.successIcon}>
          <MailCheck size={26} aria-hidden />
        </div>
        <h1 className={s.title}>Check your email</h1>
        <p className={s.lede}>
          If that address belongs to an account, a reset link is on its way. The link expires in one
          hour and can only be used once.
        </p>
        <p className={s.footLink}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </Card>
    )
  }

  return (
    <Card>
      <h1 className={s.title}>Reset your password</h1>
      <p className={s.lede}>We will email you a link to choose a new one.</p>

      <form className={s.form} onSubmit={onSubmit} noValidate>
        <Field label="Work email" error={errors.email?.message} required>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} />
        </Field>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          Send reset link
        </Button>
      </form>

      <p className={s.footLink}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </Card>
  )
}

// ---------------------------------------------------------------------------

type ResetValues = z.infer<typeof resetPasswordSchema>

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  const token = params.get('token') ?? ''
  const navigate = useNavigate()
  const { refresh } = useAuth()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<ResetValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '' },
  })

  if (!token) return <MissingToken what="reset link" />

  const onSubmit = handleSubmit(async values => {
    try {
      await api.post('/auth/reset-password', values)
      setCsrfToken(null)
      await refresh()
      navigate('/', { replace: true })
    } catch (err) {
      if (applyFieldErrors(err, setError as never)) return
      setError('root', {
        type: 'server',
        message:
          err instanceof ApiError && err.status === 422
            ? 'That reset link is no longer valid. Please request a new one.'
            : 'Could not reset your password. Please try again.',
      })
    }
  })

  return (
    <Card>
      <h1 className={s.title}>Choose a new password</h1>
      <p className={s.lede}>
        Signing in elsewhere will be ended, so anyone else using your account is signed out.
      </p>

      {errors.root && (
        <div className={s.notice}>
          <ErrorNotice title="Could not reset" error={new Error(errors.root.message)} />
        </div>
      )}

      <form className={s.form} onSubmit={onSubmit} noValidate>
        <input type="hidden" {...register('token')} />
        <Field label="New password" error={errors.password?.message} hint={PASSWORD_HINT} required>
          <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
        </Field>
        <Button type="submit" variant="primary" loading={isSubmitting}>
          Set new password
        </Button>
      </form>
    </Card>
  )
}

// ---------------------------------------------------------------------------

function MissingToken({ what }: { what: string }) {
  return (
    <Card>
      <h1 className={s.title}>That link is incomplete</h1>
      <p className={s.lede}>
        The {what} in the address bar is missing its token. Open the link from your email again, or
        ask for a new one.
      </p>
      <p className={s.footLink}>
        <Link to="/forgot-password">Request a new link</Link>
      </p>
    </Card>
  )
}

/** Shown after a password change elsewhere in the app. */
export function PasswordChangedNotice() {
  return (
    <div className={s.successIcon}>
      <CheckCircle2 size={26} aria-hidden />
    </div>
  )
}
