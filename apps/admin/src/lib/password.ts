/**
 * A small password strength estimate for live feedback. It is a nudge, not a
 * policy: the server only enforces a minimum length. Scores run 0–4.
 */

const COMMON = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'monkey',
  'dragon',
  'pressbase',
  'wordpress',
  'abc123',
  '123456',
];

export type Strength = 0 | 1 | 2 | 3 | 4;

export const STRENGTH_LABELS = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'] as const;

function hasSequence(value: string): boolean {
  const lower = value.toLowerCase();
  for (let i = 0; i < lower.length - 3; i++) {
    const codes = [0, 1, 2, 3].map((k) => lower.charCodeAt(i + k));
    const up = codes.every((c, k) => k === 0 || c === (codes[k - 1] ?? 0) + 1);
    const down = codes.every((c, k) => k === 0 || c === (codes[k - 1] ?? 0) - 1);
    const same = codes.every((c) => c === codes[0]);
    if (up || down || same) return true;
  }
  return false;
}

export function passwordStrength(value: string, context: string[] = []): Strength {
  if (value.length < 8) return 0;
  const lower = value.toLowerCase();
  const personal = context.filter((w) => w.length >= 3).map((w) => w.toLowerCase());
  if ([...COMMON, ...personal].some((word) => lower.includes(word))) return 1;

  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(value)).length;
  let score = 0;
  if (value.length >= 10) score++;
  if (value.length >= 14) score++;
  if (value.length >= 20) score++;
  if (classes >= 3) score++;
  if (classes === 4) score++;
  if (hasSequence(value)) score--;
  return Math.min(4, Math.max(1, score)) as Strength;
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';

/** A random password without look-alike characters (0/O, 1/l/I). */
export function generatePassword(length = 20): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => ALPHABET[n % ALPHABET.length]).join('');
}
