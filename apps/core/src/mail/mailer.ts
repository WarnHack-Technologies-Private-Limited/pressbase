import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import type { MailConfig } from '../config';
import type { Kernel } from '../kernel';
import { type EmailContent, renderHtml, renderText } from './template';

/**
 * kernel.mail — Pressbase's wp_mail() (wordpress/wp-includes/pluggable.php).
 *
 * With SMTP configured (PRESSBASE_SMTP_URL, or PRESSBASE_SMTP_HOST and
 * friends), mail goes out through nodemailer. Without it, each message is
 * written to <dataDir>/outbox as an .eml file plus a .json summary, so
 * development and trial sites can still finish flows such as password resets.
 *
 * Hooks, as in WordPress:
 * - `pre_wp_mail` filter: return a boolean to short-circuit sending.
 * - `wp_mail` filter: change the message before it is sent.
 * - `wp_mail_from` / `wp_mail_from_name` filters: the sender.
 * - `wp_mail_succeeded` / `wp_mail_failed` actions.
 */

export interface MailMessage {
  to: string | string[];
  subject: string;
  /** Plain-text body. Always sent. */
  text: string;
  /** Optional HTML alternative. */
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

export class MailError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly mail: MailMessage,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

declare module '@pressbase/hooks' {
  interface FilterRegistry {
    pre_wp_mail: [result: boolean | null, message: MailMessage];
    wp_mail: [message: MailMessage];
    wp_mail_from: [address: string];
    wp_mail_from_name: [name: string];
  }
  interface ActionRegistry {
    wp_mail_succeeded: [message: MailMessage];
    wp_mail_failed: [error: MailError];
  }
}

export function smtpConfigured(config: MailConfig | undefined): boolean {
  return Boolean(config?.smtpUrl || config?.host);
}

/** Parses `Name <address>` or a bare address. */
function parseFrom(value: string): { name: string; address: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(value);
  if (match) return { name: (match[1] ?? '').replace(/^"|"$/g, ''), address: match[2] ?? '' };
  return { name: '', address: value.trim() };
}

/** Whatever createTransport() returns; nodemailer doesn't export a name for it. */
type Transporter = ReturnType<typeof nodemailer.createTransport>;

export class Mailer {
  #smtp: Transporter | undefined;
  #outbox: Transporter | undefined;

  constructor(private readonly kernel: Kernel) {}

  /** 'smtp' when configured, otherwise 'outbox'. */
  get transport(): 'smtp' | 'outbox' {
    return smtpConfigured(this.kernel.config.mail) ? 'smtp' : 'outbox';
  }

  get outboxDir(): string {
    return path.join(this.kernel.config.dataDir, 'outbox');
  }

  /** Renders the shared template into text + HTML. */
  compose(content: EmailContent): { text: string; html: string } {
    return { text: renderText(content), html: renderHtml(content) };
  }

  /**
   * wp_mail(): true when the message was handed to the transport (or saved
   * to the outbox). Failures fire `wp_mail_failed` and return false; they
   * never throw, so a broken mail server can't break the request that sent it.
   */
  async send(input: MailMessage): Promise<boolean> {
    const hooks = this.kernel.hooks;
    const short = await hooks.applyFilters('pre_wp_mail', null, input);
    if (typeof short === 'boolean') return short;
    const message = await hooks.applyFilters('wp_mail', { ...input });

    const from = await this.#from();
    try {
      const to = Array.isArray(message.to) ? message.to : [message.to];
      if (!to.length || to.some((t) => !t.trim())) {
        throw new MailError('wp_mail_failed', 'The message has no recipient.', message);
      }
      const envelope = {
        from: from.name ? { name: from.name, address: from.address } : from.address,
        to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo: message.replyTo,
        headers: message.headers,
      };
      if (this.transport === 'smtp') {
        await this.#smtpTransport().sendMail(envelope);
      } else {
        await this.#writeOutbox(envelope, message);
      }
      await hooks.doAction('wp_mail_succeeded', message);
      return true;
    } catch (cause) {
      const error =
        cause instanceof MailError
          ? cause
          : new MailError(
              'wp_mail_failed',
              cause instanceof Error ? cause.message : 'Could not send email.',
              message,
              { cause },
            );
      console.error(`[mail] Could not send “${message.subject}”: ${error.message}`);
      await hooks.doAction('wp_mail_failed', error);
      return false;
    }
  }

  async #from(): Promise<{ name: string; address: string }> {
    const configured = this.kernel.config.mail?.from;
    let name = '';
    let address = '';
    if (configured) ({ name, address } = parseFrom(configured));
    if (!address) {
      // WordPress's default: wordpress@<site host>.
      const home = await this.kernel.options.get<string>('home', '');
      let host = 'localhost';
      try {
        host = new URL(home).hostname.replace(/^www\./, '') || host;
      } catch {}
      address = `pressbase@${host}`;
    }
    if (!name) name = (await this.kernel.options.get<string>('blogname', '')) || 'Pressbase';
    return {
      address: await this.kernel.hooks.applyFilters('wp_mail_from', address),
      name: await this.kernel.hooks.applyFilters('wp_mail_from_name', name),
    };
  }

  #smtpTransport(): Transporter {
    if (!this.#smtp) {
      const config = this.kernel.config.mail ?? {};
      this.#smtp = config.smtpUrl
        ? nodemailer.createTransport(config.smtpUrl)
        : nodemailer.createTransport({
            host: config.host,
            port: config.port ?? (config.secure ? 465 : 587),
            secure: config.secure ?? config.port === 465,
            auth: config.user ? { user: config.user, pass: config.pass ?? '' } : undefined,
          });
    }
    return this.#smtp;
  }

  async #writeOutbox(
    envelope: Parameters<Transporter['sendMail']>[0],
    message: MailMessage,
  ): Promise<void> {
    this.#outbox ??= nodemailer.createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    });
    const info = await this.#outbox.sendMail(envelope);
    await mkdir(this.outboxDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(this.outboxDir, `${stamp}-${randomBytes(3).toString('hex')}`);
    // Outbox files can hold reset links, so only the server's user may read them.
    await writeFile(`${base}.eml`, info.message as Buffer, { mode: 0o600 });
    await writeFile(
      `${base}.json`,
      `${JSON.stringify(
        {
          date: new Date().toISOString(),
          from: envelope.from,
          to: envelope.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    console.info(`[mail] SMTP isn’t set up; saved “${message.subject}” to ${base}.eml`);
  }
}
