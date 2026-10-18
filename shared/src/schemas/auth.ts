/**
 * Authentication schemas (docs/05-api-spec.md section 2).
 */

import { z } from 'zod'

export const email = z.string().trim().toLowerCase().email('Enter a valid email address')

/**
 * Minimum 12 characters, no composition rules and no forced rotation.
 * That is current NIST/OWASP guidance: complexity rules produce predictable
 * substitutions, and forced rotation produces sticky notes. Length plus a
 * common-password check on the server does more real work than either.
 */
export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200, 'That password is unreasonably long')

export const loginSchema = z
  .object({
    email,
    // Deliberately not length-validated: an existing weaker password must still
    // be able to sign in, and the error must not hint at the policy.
    password: z.string().min(1, 'Enter your password'),
  })
  .strict()

export type LoginInput = z.infer<typeof loginSchema>

export const forgotPasswordSchema = z.object({ email }).strict()

export const resetPasswordSchema = z.object({ token: z.string().min(16), password }).strict()

export const acceptInviteSchema = z
  .object({
    token: z.string().min(16),
    fullName: z.string().trim().min(1, 'Enter your name').max(120),
    password,
  })
  .strict()

export const changePasswordSchema = z
  .object({ currentPassword: z.string().min(1), newPassword: password })
  .strict()
  .refine(p => p.currentPassword !== p.newPassword, {
    message: 'The new password must differ from the current one',
    path: ['newPassword'],
  })

export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>
