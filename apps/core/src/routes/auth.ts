import { schema } from '@pressbase/db';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { hashPassword, needsRehash, verifyPassword } from '../auth/password';
import { RateLimiter } from '../auth/rate-limit';
import { createSession, destroySession, SESSION_COOKIE } from '../auth/sessions';
import { findUserForLogin, loadUser } from '../auth/users';
import {
  type AppEnv,
  clientIp,
  invalidParams,
  isSecureRequest,
  readJson,
  restError,
} from '../http';

const loginBody = z.object({
  login: z.string().trim().min(1, 'Enter your username or email address.'),
  password: z.string().min(1, 'Enter your password.'),
  remember: z.boolean().default(false),
});

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Checked against when the login is unknown, so both paths take the same time.
const DUMMY_HASH = hashPassword('pressbase-timing-equaliser');

export function authRoutes() {
  const app = new Hono<AppEnv>();
  // Two windows: one per address + login, and a looser one per login alone so
  // rotating addresses does not give unlimited guesses.
  const perClient = new RateLimiter(5, FIFTEEN_MINUTES);
  const perLogin = new RateLimiter(20, FIFTEEN_MINUTES);

  app.post('/login', async (c) => {
    const kernel = c.get('kernel');
    const parsed = loginBody.safeParse(await readJson(c));
    if (!parsed.success) return invalidParams(c, parsed.error);
    const { login, password, remember } = parsed.data;

    const loginKey = login.toLowerCase();
    const clientKey = `${clientIp(c)}|${loginKey}`;
    const wait = Math.max(perClient.retryAfter(clientKey), perLogin.retryAfter(loginKey));
    if (wait > 0) {
      c.header('Retry-After', String(wait));
      return restError(
        c,
        429,
        'pressbase_too_many_attempts',
        `Too many failed attempts. Try again in ${Math.ceil(wait / 60)} minute(s).`,
        { retryAfter: wait },
      );
    }

    const user = await findUserForLogin(kernel, login);
    const valid = await verifyPassword(password, user?.pass ?? (await DUMMY_HASH));
    if (!user || !valid) {
      perClient.hit(clientKey);
      perLogin.hit(loginKey);
      return restError(
        c,
        401,
        'pressbase_invalid_credentials',
        'The username or password is incorrect.',
      );
    }
    perClient.reset(clientKey);

    if (needsRehash(user.pass)) {
      await kernel.db
        .update(schema.users)
        .set({ pass: await hashPassword(password) })
        .where(eq(schema.users.id, user.id));
    }

    const session = await createSession(kernel, user.id, {
      remember,
      ip: clientIp(c),
      userAgent: c.req.header('user-agent') ?? '',
    });
    setCookie(c, SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'Lax',
      secure: isSecureRequest(c),
      path: '/',
      maxAge: session.maxAge,
    });
    await kernel.hooks.doAction('wp_login', user.id);
    const current = await loadUser(kernel, user.id);
    return c.json({ id: current?.id, name: current?.displayName });
  });

  app.post('/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await destroySession(c.get('kernel'), token);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  return app;
}
