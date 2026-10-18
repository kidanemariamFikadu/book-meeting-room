/**
 * The mail interface and its implementations.
 *
 * One interface, selected by configuration, so switching to Resend or SendGrid
 * later is a new class rather than a change to any calling code.
 *
 * M1 scope: enqueue to the outbox and deliver plain messages, which is what
 * invitations and password resets need. The MJML templates, `.ics` attachments
 * and the retrying worker arrive in M4 (docs/06-email-notifications.md).
 */

import nodemailer, { type Transporter } from 'nodemailer'

import { config } from '../config.js'
import { logger } from '../middleware/requestContext.js'

export interface Attachment {
  filename: string
  content: string
  contentType: string
}

export interface Message {
  to: string
  toName?: string | null
  subject: string
  text: string
  html?: string
  replyTo?: string | null
  attachments?: Attachment[]
  /**
   * Threads every message about one booking together in the recipient's
   * client, which noticeably reduces inbox noise.
   */
  references?: string | undefined
  /** `bulk` on reminders, so out-of-office replies do not storm back. */
  precedence?: 'bulk' | undefined
}

export interface Mailer {
  readonly name: string
  send(message: Message): Promise<void>
}

/**
 * Development and test. Logs a summary and keeps the message in memory so it
 * can be read at /dev/emails and asserted on in tests.
 *
 * This is what makes it possible to develop and demo the entire notification
 * system with no SMTP credentials at all (D2).
 */
export class ConsoleMailer implements Mailer {
  readonly name = 'console'
  private readonly captured: Array<Message & { sentAt: Date }> = []

  async send(message: Message): Promise<void> {
    this.captured.unshift({ ...message, sentAt: new Date() })
    if (this.captured.length > 200) this.captured.pop()

    // The link is logged explicitly because during M1 it is the only way to
    // accept an invitation or reset a password locally.
    const link = /https?:\/\/\S+/.exec(message.text)?.[0]
    logger.info(
      { to: message.to, subject: message.subject, ...(link ? { link } : {}) },
      'Email captured (console mailer)',
    )
  }

  list(): ReadonlyArray<Message & { sentAt: Date }> {
    return this.captured
  }
}

/** Production, and local development against Mailpit. */
export class SmtpMailer implements Mailer {
  readonly name = 'smtp'
  private readonly transport: Transporter

  constructor() {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      ...(config.SMTP_USER
        ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASS ?? '' } }
        : {}),
      // Pooled: the outbox worker sends in batches, and a fresh TLS handshake
      // per message is the slowest part of delivery.
      pool: true,
      maxConnections: 3,
    })
  }

  async send(message: Message): Promise<void> {
    await this.transport.sendMail({
      from: { name: config.MAIL_FROM_NAME, address: config.MAIL_FROM_ADDRESS },
      to: message.toName ? { name: message.toName, address: message.to } : message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      ...(message.attachments?.length
        ? {
            attachments: message.attachments.map(a => ({
              filename: a.filename,
              content: a.content,
              contentType: a.contentType,
            })),
          }
        : {}),
      headers: {
        // Stops out-of-office replies storming back at the sending address.
        'Auto-Submitted': 'auto-generated',
        ...(message.references
          ? { References: message.references, 'In-Reply-To': message.references }
          : {}),
        ...(message.precedence ? { Precedence: message.precedence } : {}),
      },
    })
  }
}

/** Tests. Collects messages for assertions without touching the network. */
export class CapturingMailer implements Mailer {
  readonly name = 'capturing'
  readonly sent: Message[] = []

  async send(message: Message): Promise<void> {
    this.sent.push(message)
  }

  find(predicate: (m: Message) => boolean): Message | undefined {
    return this.sent.find(predicate)
  }

  clear(): void {
    this.sent.length = 0
  }
}

let instance: Mailer | null = null

export function getMailer(): Mailer {
  instance ??= config.MAIL_TRANSPORT === 'smtp' ? new SmtpMailer() : new ConsoleMailer()
  return instance
}

/** Test and dev-tooling seam. */
export function setMailer(mailer: Mailer): void {
  instance = mailer
}
