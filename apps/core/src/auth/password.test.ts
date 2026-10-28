import { describe, expect, it } from 'vitest';
import { hashPassword, needsRehash, verifyPassword } from './password';

/*
 * Test vectors for WordPress's password formats. They were generated outside
 * this code base, from the algorithm definitions in wp-includes/pluggable.php
 * and wp-includes/class-phpass.php:
 *
 * - $wp$2y$: base64(HMAC-SHA384(password, 'wp-sha384')) hashed with bcrypt
 *   (pyca/bcrypt 5.0, cost 10), then prefixed with "$wp", as wp_hash_password() does;
 * - $2y$ / $2a$ / $2b$: pyca/bcrypt, the same digest under each PHP prefix;
 * - $P$ / $H$: passlib 1.7's independent phpass implementation;
 * - the openwall phpass reference vector ("test12345") from phpass's own test.php.
 */
const WP_BCRYPT = [
  ['password', '$wp$2y$10$tes3bQytvZ69BqQLRphk/ur0gWONRjw62zyQGjq.qxbHWUqF/bjC6'],
  [
    'correct horse battery staple',
    '$wp$2y$10$GtdIMALq7LQ6w3Admnxy..blCUX0NMQ8miSsrae14wD3jtHo42wgi',
  ],
  ['pässwörd ✓', '$wp$2y$10$X2vFuCwcEgV.TOUALgcs1e5DNBo7F/OQn5pBDIaCP0gJXtTnhDt9O'],
  ['x'.repeat(100), '$wp$2y$10$dY6qu1xC61SCVQl/aJW3tu8w0dVBDZNb62QiElsEOkAVN8JIXzosq'],
] as const;

const PLAIN_BCRYPT = [
  ['password', '$2y$10$ZXLgb7R0i2VTj4yJigli3.hW3CCutizYoXeGBQaePP6VpiPk16Nsu'],
  ['password', '$2b$10$ZXLgb7R0i2VTj4yJigli3.hW3CCutizYoXeGBQaePP6VpiPk16Nsu'],
  ['password', '$2a$10$ZXLgb7R0i2VTj4yJigli3.hW3CCutizYoXeGBQaePP6VpiPk16Nsu'],
  ['pässwörd ✓', '$2y$10$yadBR4ewCw2blaYpmlNW/.mK2VE.QpnxUchu65946r.LIH9pJ01oi'],
] as const;

const PHPASS = [
  ['password', '$P$BanTSbIFxngeBnrtMEcuNtNlm1dauL/'],
  ['pässwörd ✓', '$P$BeHN0Ajpjh1E4keiHaGi8geNRW48iN/'],
  ['password', '$H$9pWuawbjHpTPJF2XlKXF3wJNg/wZ5G0'],
  ['pässwörd ✓', '$H$940CDYdXNHzebNC/gjnMMEx3W4.05i1'],
  // openwall phpass test.php
  ['test12345', '$P$9IQRaTwmfeRo7ud9Fh4E2PdI0S3r.L0'],
] as const;

describe('scrypt hashes', () => {
  it('hash, verify and do not need a rehash', async () => {
    const hash = await hashPassword('secret');
    expect(hash).toMatch(/^\$scrypt\$n=65536,r=8,p=1\$/);
    expect(await verifyPassword('secret', hash)).toBe(true);
    expect(await verifyPassword('Secret', hash)).toBe(false);
    expect(needsRehash(hash)).toBe(false);
  });

  it('flag weaker parameters for rehash', () => {
    expect(needsRehash('$scrypt$n=16384,r=8,p=1$c2FsdA==$a2V5')).toBe(true);
  });
});

describe('WordPress 6.8+ bcrypt hashes ($wp$2y$)', () => {
  it.each(WP_BCRYPT)('accept the right password: %s', async (password, hash) => {
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(needsRehash(hash)).toBe(true);
  });

  it('refuse a wrong password', async () => {
    const [, hash] = WP_BCRYPT[0];
    expect(await verifyPassword('Password', hash)).toBe(false);
    expect(await verifyPassword('password ', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('use the whole of a password longer than bcrypt’s 72 bytes', async () => {
    const [, hash] = WP_BCRYPT[3];
    expect(await verifyPassword(`${'x'.repeat(100)}y`, hash)).toBe(false);
    expect(await verifyPassword('x'.repeat(99), hash)).toBe(false);
  });

  it('are not plain bcrypt of the password', async () => {
    // The digest only matches after the HMAC pre-hash, so stripping "$wp" must fail.
    const [password, hash] = WP_BCRYPT[0];
    expect(await verifyPassword(password, hash.slice(3))).toBe(false);
  });
});

describe('plain bcrypt hashes ($2y$, $2a$, $2b$)', () => {
  it.each(PLAIN_BCRYPT)('accept the right password: %s %s', async (password, hash) => {
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(`${password}!`, hash)).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });

  it('refuse costs outside the supported range', async () => {
    const [password, hash] = PLAIN_BCRYPT[0];
    expect(await verifyPassword(password, hash.replace('$10$', '$03$'))).toBe(false);
    expect(await verifyPassword(password, hash.replace('$10$', '$31$'))).toBe(false);
  });

  it('refuse malformed hashes', async () => {
    expect(await verifyPassword('password', '$2y$10$short')).toBe(false);
    expect(
      await verifyPassword(
        'password',
        '$2x$10$ZXLgb7R0i2VTj4yJigli3.hW3CCutizYoXeGBQaePP6VpiPk16Nsu',
      ),
    ).toBe(false);
  });
});

describe('phpass portable hashes ($P$, $H$)', () => {
  it.each(PHPASS)('accept the right password: %s %s', async (password, hash) => {
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(password.toUpperCase(), hash)).toBe(false);
    expect(needsRehash(hash)).toBe(true);
  });

  it('refuse a changed digest or salt', async () => {
    const [password, hash] = PHPASS[0];
    expect(await verifyPassword(password, `${hash.slice(0, -1)}0`)).toBe(false);
    expect(await verifyPassword(password, `${hash.slice(0, 5)}x${hash.slice(6)}`)).toBe(false);
  });

  it('refuse iteration counts outside the supported range', async () => {
    const [password, hash] = PHPASS[0];
    // "5" is 2^7 rounds in phpass's alphabet: valid for phpass, but this digest was made with 2^13.
    expect(await verifyPassword(password, `$P$5${hash.slice(4)}`)).toBe(false);
    // "4" (2^6) is below phpass's minimum, "z" (2^63) above anything sane.
    expect(await verifyPassword(password, `$P$4${hash.slice(4)}`)).toBe(false);
    expect(await verifyPassword(password, `$P$z${hash.slice(4)}`)).toBe(false);
  });

  it('refuse malformed hashes', async () => {
    expect(await verifyPassword('password', '$P$Bsomething')).toBe(false);
  });
});

describe('other hashes', () => {
  it('accept WordPress’s pre-2.5 MD5 hashes', async () => {
    expect(await verifyPassword('password', '5f4dcc3b5aa765d61d8327deb882cf99')).toBe(true);
    expect(await verifyPassword('Password', '5f4dcc3b5aa765d61d8327deb882cf99')).toBe(false);
    expect(needsRehash('5f4dcc3b5aa765d61d8327deb882cf99')).toBe(true);
  });

  it('refuse unknown formats, empty hashes and over-long passwords', async () => {
    expect(await verifyPassword('password', '')).toBe(false);
    expect(await verifyPassword('password', '*')).toBe(false);
    expect(await verifyPassword('password', 'password')).toBe(false);
    expect(await verifyPassword('password', '$argon2id$v=19$m=65536,t=4,p=1$c2FsdA$a2V5')).toBe(
      false,
    );
    const [, hash] = PHPASS[0];
    expect(await verifyPassword('x'.repeat(4097), hash)).toBe(false);
  });
});
