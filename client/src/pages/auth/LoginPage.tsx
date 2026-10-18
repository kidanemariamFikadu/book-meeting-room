/**
 * Sign in (S-01).
 *
 * Validated client-side against the SHARED login schema, so the rules here and
 * on the server cannot drift.
 */

import { zodResolver } from '@hookform/resolvers/zod'
import { Building2 } from 'lucide-react'
import { useForm } from 'react-hook-form'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import type { z } from 'zod'

import { loginSchema } from '@roombook/shared'

import { ApiError, api, setCsrfToken } from '../../api/client.js'
import { useAuth } from '../../auth/AuthProvider.js'
import { Button, Card, ErrorNotice, Field, Input } from '../../components/ui/index.js'
import s from './auth.module.css'

type LoginValues = z.infer<typeof loginSchema>

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { refresh } = useAuth()

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  })

  // Where the user was heading before being bounced here, so they land there
  // rather than on the home page.
  const from = (location.state as { from?: string } | null)?.from ?? '/'

  const onSubmit = handleSubmit(async values => {
    try {
      await api.post('/auth/login', values)
      setCsrfToken(null) // the session was regenerated, so mint a fresh token
      await refresh()
      navigate(from, { replace: true })
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('root', {
          type: 'server',
          message: 'Too many failed attempts. Please wait a few minutes and try again.',
        })
        return
      }
      // A failed login never says which part was wrong: that would turn the
      // form into a way of discovering who has an account.
      setError('root', {
        type: 'server',
        message:
          err instanceof ApiError && err.status === 401
            ? 'That email address and password do not match.'
            : 'Could not sign you in. Please try again.',
      })
    }
  })

  return (
    <Card>
      <div className={s.brand}>
        <Building2 size={20} aria-hidden />
        <span>RoomBook</span>
      </div>
      <h1 className={s.title}>Sign in</h1>
      <p className={s.lede}>Book a meeting room at your organization.</p>

      {errors.root && (
        <div className={s.notice}>
          <ErrorNotice title="Could not sign in" error={new Error(errors.root.message)} />
        </div>
      )}

      <form className={s.form} onSubmit={onSubmit} noValidate>
        <Field label="Work email" error={errors.email?.message} required>
          <Input
            type="email"
            autoComplete="username"
            autoFocus
            placeholder="you@example.com"
            {...register('email')}
          />
        </Field>

        <Field label="Password" error={errors.password?.message} required>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>

        <Button type="submit" variant="primary" loading={isSubmitting}>
          Sign in
        </Button>
      </form>

      <p className={s.footLink}>
        <Link to="/forgot-password">Forgotten your password?</Link>
      </p>
    </Card>
  )
}
