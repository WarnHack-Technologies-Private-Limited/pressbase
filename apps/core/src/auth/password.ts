import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing with scrypt from Node's standard library, so installs need
 * no native modules. Hashes are self-describing:
 *
 *   $scrypt$n=65536,r=8,p=1$<salt, base64>$<key, base64>
 *
 * Because parameters travel with the hash, they can be raised later and old
 * hashes upgraded on the next successful login (see needsRehash).
 * Verifying imported WordPress hashes ($wp$2y$…, $P$…) is planned for the
 * migration tool. See docs/adr/0005-password-hashing.md.
 */

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

const PARAMS = { N: 2 ** 16, r: 8, p: 1 };
const KEY_LENGTH = 32;

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

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const parsed = parse(hash);
  if (!parsed) return false;
  const { N, r, p, salt, key } = parsed;
  const candidate = await scryptAsync(password, salt, key.length, {
    N,
    r,
    p,
    maxmem: maxmem(N, r),
  });
  return timingSafeEqual(candidate, key);
}

/** True when a hash was made with weaker parameters than today's, or another algorithm. */
export function needsRehash(hash: string): boolean {
  const parsed = parse(hash);
  return !parsed || parsed.N < PARAMS.N || parsed.r < PARAMS.r || parsed.p < PARAMS.p;
}
