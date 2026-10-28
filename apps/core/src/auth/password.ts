import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import bcrypt from 'bcryptjs';

/**
 * Password hashing with scrypt from Node's standard library, so installs need
 * no native modules. Hashes are self-describing:
 *
 *   $scrypt$n=65536,r=8,p=1$<salt, base64>$<key, base64>
 *
 * Because parameters travel with the hash, they can be raised later and old
 * hashes upgraded on the next successful login (see needsRehash).
 *
 * verifyPassword() also accepts the hashes a WordPress site stores, so people
 * imported from WordPress can log in with their old password, after which the
 * login route re-hashes it with scrypt. It ports wp_check_password()
 * (wp-includes/pluggable.php, WordPress 6.8+):
 *
 *   $wp$2y$…      bcrypt of base64(HMAC-SHA384(password, 'wp-sha384')), WordPress 6.8+
 *   $2y$ $2a$ $2b$ plain bcrypt (password_hash(), or plugins that used it)
 *   $P$… / $H$…   phpass portable hashes, WordPress 2.5–6.7 (phpBB uses $H$)
 *   32 hex digits plain MD5, WordPress before 2.5
 *
 * See docs/adr/0005-password-hashing.md.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 16, r: 8, p: 1 };
const KEY_LENGTH = 32;

/** WordPress refuses to hash or check passwords longer than this (wp_check_password()). */
const MAX_LEGACY_PASSWORD_LENGTH = 4096;
/**
 * Upper bounds on the work a stored legacy hash may ask for. WordPress uses bcrypt cost 10
 * and phpass 2^13 rounds; the caps stop a crafted hash from tying up the process.
 */
const MAX_BCRYPT_COST = 16;
const MAX_PHPASS_LOG2 = 16;

function maxmem(N: number, r: number): number {
  return 128 * N * r * 2;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmem(N, r) });
  return `$scrypt$n=${N},r=${r},p=${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(hash: string): ParsedHash | undefined {
  const match = /^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(
    hash,
  );
  if (!match) return undefined;
  const [, n, r, p, salt, key] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  return {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt, 'base64'),
    key: Buffer.from(key, 'base64'),
  };
}

async function verifyScrypt(password: string, parsed: ParsedHash): Promise<boolean> {
  const { N, r, p, salt, key } = parsed;
  const candidate = await scryptAsync(password, salt, key.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return timingSafeEqual(candidate, key);
}

/** Compares two strings in constant time (for equal lengths; lengths aren't secret here). */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

const BCRYPT = /^\$2[aby]\$(\d{2})\$[./A-Za-z0-9]{53}$/;

/** password_verify() for bcrypt: re-hash with the stored salt and compare. */
async function verifyBcrypt(password: string, hash: string): Promise<boolean> {
  const match = BCRYPT.exec(hash);
  if (!match) return false;
  const cost = Number(match[1]);
  if (cost < 4 || cost > MAX_BCRYPT_COST) return false;
  // The first 29 characters are "$2y$10$" and the 22-character salt.
  const candidate = await bcrypt.hash(password, hash.slice(0, 29));
  return safeEqual(candidate, hash);
}

/** WordPress 6.8's pre-hash: lets bcrypt use all of a password longer than 72 bytes. */
function wordpressPrehash(password: string): string {
  return createHmac('sha384', 'wp-sha384').update(password, 'utf8').digest('base64');
}

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** phpass's encode64(): its own little-endian base64 with the crypt() alphabet. */
function encode64(input: Buffer, count: number): string {
  let output = '';
  let i = 0;
  const char = (value: number) => ITOA64.charAt(value & 0x3f);
  do {
    let value = input[i++] ?? 0;
    output += char(value);
    if (i < count) value |= (input[i] ?? 0) << 8;
    output += char(value >> 6);
    if (i++ >= count) break;
    if (i < count) value |= (input[i] ?? 0) << 16;
    output += char(value >> 12);
    if (i++ >= count) break;
    output += char(value >> 18);
  } while (i < count);
  return output;
}

/** PasswordHash::CheckPassword() for portable hashes (crypt_private() in class-phpass.php). */
function verifyPhpass(password: string, hash: string): boolean {
  if (!/^\$[PH]\$[./0-9A-Za-z]{31}$/.test(hash)) return false;
  const countLog2 = ITOA64.indexOf(hash.charAt(3));
  if (countLog2 < 7 || countLog2 > MAX_PHPASS_LOG2) return false;
  const salt = hash.slice(4, 12);
  const secret = Buffer.from(password, 'utf8');
  let digest = createHash('md5').update(salt).update(secret).digest();
  for (let count = 1 << countLog2; count > 0; count--) {
    digest = createHash('md5').update(digest).update(secret).digest();
  }
  return safeEqual(hash.slice(0, 12) + encode64(digest, 16), hash);
}

/**
 * Checks a password against a stored hash: Pressbase's own scrypt hashes, or a
 * WordPress hash brought over by an import. Every comparison is constant-time.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parse(hash);
  if (parsed) return verifyScrypt(password, parsed);

  // The rest ports wp_check_password().
  if (password.length > MAX_LEGACY_PASSWORD_LENGTH) return false;
  if (/^[0-9a-f]{32}$/.test(hash)) {
    return safeEqual(createHash('md5').update(password, 'utf8').digest('hex'), hash);
  }
  if (hash.startsWith('$wp$')) return verifyBcrypt(wordpressPrehash(password), hash.slice(3));
  if (hash.startsWith('$P$') || hash.startsWith('$H$')) return verifyPhpass(password, hash);
  if (hash.startsWith('$2')) return verifyBcrypt(password, hash);
  return false;
}

/** True when a hash was made with weaker parameters than today's, or another algorithm. */
export function needsRehash(hash: string): boolean {
  const parsed = parse(hash);
  return !parsed || parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}
