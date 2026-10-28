# 0005: scrypt from the Node standard library

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Pressbase needs strong password hashing that installs everywhere. Native modules (argon2, bcrypt) can fail to install on unusual platforms, which would break the five-minute install.

## Decision

- Use **`crypto.scrypt`** with N=2¹⁶, r=8, p=1, a 16-byte salt and a 32-byte key.
- Store self-describing hashes: `$scrypt$n=…,r=…,p=…$salt$key`.
- `needsRehash()` upgrades hashes on login when the parameters rise, or when a hash came from another algorithm.
- WordPress hashes (`$wp$2y$…` bcrypt, `$P$…` phpass) will be verified on first login after migration, then re-hashed (v0.6). Done early; see the update below.

## Consequences

- No native dependencies.
- Each hash uses about 64 MiB of memory for around 100ms, which bounds concurrent logins per process. Login throttling helps.

## Alternatives considered

- **argon2id** (`@node-rs/argon2`): the best algorithm, but a native binary. We may switch, since the hash format allows a gradual migration.
- **bcrypt:** a 72-byte input limit and a native module.

## Update (2026-10-27): verifying WordPress hashes

People imported from WordPress arrive with WordPress's password hashes. `verifyPassword()` now accepts them, porting `wp_check_password()` (`wp-includes/pluggable.php`) and phpass's `CheckPassword()` (`wp-includes/class-phpass.php`):

| Stored hash | Where it comes from | How it's checked |
| --- | --- | --- |
| `$wp$2y$10$…` | WordPress 6.8+ (`wp_hash_password()`) | bcrypt of `base64(HMAC-SHA384(password, key "wp-sha384"))`, after dropping the `$wp` prefix |
| `$2y$…`, `$2a$…`, `$2b$…` | `password_hash()`, or plugins that used it | Plain bcrypt |
| `$P$…`, `$H$…` | WordPress 2.5–6.7 (phpass portable hashes; phpBB writes `$H$`) | Salted MD5, iterated 2^n times, `n` read from the hash |
| 32 hexadecimal characters | WordPress before 2.5 | Plain MD5 |

- **bcrypt** comes from [`bcryptjs`](https://github.com/dcodeIO/bcrypt.js) (BSD-3-Clause, pure JavaScript, no dependencies), pinned to an exact version. That keeps the "no native modules" decision above. It's slower than native bcrypt (cost 10 takes roughly 100ms), which only matters once per imported account. phpass and MD5 use `node:crypto`.
- Every result is compared with `crypto.timingSafeEqual`.
- As in WordPress, passwords longer than 4096 characters never match a legacy hash, and the check uses the password exactly as typed (no trimming).
- Stored hashes can't make a login arbitrarily expensive: bcrypt costs above 16 and phpass iteration counts above 2^16 are refused (WordPress uses 10 and 2^13).
- `needsRehash()` already returns true for anything that isn't scrypt, so the first successful login replaces the WordPress hash with scrypt. Pressbase never writes a WordPress-format hash.
- Application passwords are unaffected: they're SHA-256 digests (`$generic$…`) checked by `verifyFastHash()`.

**Consequence:** until someone with an imported hash logs in, a wrong password for their account takes bcrypt or phpass time rather than scrypt time, so a careful attacker could tell those accounts apart from unknown usernames by timing. Throttling limits how fast that can be probed, and it ends at each person's first login.
