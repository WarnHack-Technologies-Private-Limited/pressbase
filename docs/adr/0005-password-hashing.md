# 0005: scrypt from the Node standard library

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

Pressbase needs strong password hashing that installs everywhere. Native modules (argon2, bcrypt) can fail to install on unusual platforms, which would break the five-minute install.

## Decision

- Use **`crypto.scrypt`** with N=2¹⁶, r=8, p=1, a 16-byte salt and a 32-byte key.
- Store self-describing hashes: `$scrypt$n=…,r=…,p=…$salt$key`.
- `needsRehash()` upgrades hashes on login when the parameters rise, or when a hash came from another algorithm.
- WordPress hashes (`$wp$2y$…` bcrypt, `$P$…` phpass) will be verified on first login after migration, then re-hashed (v0.6).

## Consequences

- No native dependencies.
- Each hash uses about 64 MiB of memory for around 100ms, which bounds concurrent logins per process. Login throttling helps.

## Alternatives considered

- **argon2id** (`@node-rs/argon2`): the best algorithm, but a native binary. We may switch, since the hash format allows a gradual migration.
- **bcrypt:** a 72-byte input limit and a native module.
