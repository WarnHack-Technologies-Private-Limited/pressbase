import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limit';
import { type AppEnv, clientIp, invalidParams, readJson, restError } from '../http';
import {
  checkResetKey,
  createResetKey,
  findUserByLoginOrEmail,
  resetPassword,
  sendResetEmail,
} from '../people/password-reset';
import { passwordProblem } from '../people/validation';

/**
 * /pressbase/v1/auth/lost-password and /reset-password — the lostpassword and
 * resetpass actions of wordpress/wp-login.php, as JSON endpoints for the
 * admin's /lost-password and /reset-password screens.
 */

const FIFTEEN_MINUTES = 15 * 60 * 1000;

/** The same answer whether or not the account exists, so the form can't be used to find accounts. */
export const LOST_PASSWORD_MESSAGE =
  'If that account exists, we’ve sent an email with a link to reset the password. Check your inbox, and your spam folder too.';

const lostBody = z.object({
  login: z
    .string({ message: 'Enter your username or email address.' })
    .trim()
    .min(1, 'Enter your username or email address.')
    .max(100),
});
const keyBody = z.object({
  login: z.string().trim().min(1, 'This link is missing the username.').max(60),
  key: z.string().trim().min(1, 'This link is missing its key.').max(100),
});
const resetBody = keyBody.extend({ password: z.string().max(4096) });

export function passwordResetRoutes() {
  const app = new Hono<AppEnv>({ strict: false });
  const perClient = new RateLimiter(10, FIFTEEN_MINUTES);
  // Per account: stops the form being used to flood someone's inbox. Silent,
  // so it doesn't reveal that the account exists.
  const perAccount = new RateLimiter(3, FIFTEEN_MINUTES);
  const keyFailures = new RateLimiter(20, FIFTEEN_MINUTES);

  const tooMany = (c: Context, wait: number) => {
    c.header('Retry-After', String(wait));
    return restError(
      c,
      429,
      'pressbase_too_many_attempts',
      `Too many attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
      { retryAfter: wait },
    );
  };

  app.post('/lost-password', async (c) => {
    const kernel = c.get('kernel');
    const parsed = lostBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const ip = clientIp(c);
    const wait = perClient.retryAfter(ip);
    if (wait > 0) return tooMany(c, wait);
    perClient.hit(ip);

    const user = await findUserByLoginOrEmail(kernel, parsed.data.login);
    await kernel.hooks.doAction(
      'lostpassword_post',
      user
        ? { id: user.id, login: user.login, email: user.email, displayName: user.displayName }
        : null,
    );
    if (user && perAccount.retryAfter(String(user.id)) === 0) {
      perAccount.hit(String(user.id));
      const key = await createResetKey(kernel, user);
      // Not awaited: a slow mail server would otherwise reveal that the account exists.
      void sendResetEmail(kernel, user, key);
    }
    return c.json({ ok: true, message: LOST_PASSWORD_MESSAGE });
  });

  app.post('/check-reset-key', async (c) => {
    const parsed = keyBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const ip = clientIp(c);
    const wait = keyFailures.retryAfter(ip);
    if (wait > 0) return tooMany(c, wait);
    const check = await checkResetKey(c.get('kernel'), parsed.data.login, parsed.data.key);
    if (!check.ok) {
      keyFailures.hit(ip);
      return restError(c, 400, check.code, check.message);
    }
    return c.json({ ok: true, login: check.user.login });
  });

  app.post('/reset-password', async (c) => {
    const kernel = c.get('kernel');
    const parsed = resetBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const ip = clientIp(c);
    const wait = keyFailures.retryAfter(ip);
    if (wait > 0) return tooMany(c, wait);
    const check = await checkResetKey(kernel, parsed.data.login, parsed.data.key);
    if (!check.ok) {
      keyFailures.hit(ip);
      return restError(c, 400, check.code, check.message);
    }
    const problem = passwordProblem(parsed.data.password);
    if (problem) {
      return restError(c, 400, 'rest_invalid_param', 'Invalid parameter(s): password', {
        params: { password: problem },
      });
    }
    await resetPassword(kernel, check.user, parsed.data.password);
    return c.json({ ok: true, message: 'Your password has been reset. You can log in now.' });
  });

  return app;
}
