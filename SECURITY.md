# Security policy

## Reporting a vulnerability

**Don't open a public issue.** Report it privately through GitHub: **[Report a vulnerability](https://github.com/WarnHack-Technologies-Private-Limited/pressbase/security/advisories/new)** (on the repository's Security tab).

Please include:
- what is affected;
- how to reproduce it;
- what an attacker could achieve.

We aim to:
1. acknowledge your report within 3 working days;
2. agree a disclosure date with you;
3. credit you in the release notes, unless you prefer otherwise.

## Supported versions

Pressbase is a pre-1.0 developer preview. Only the latest release gets security fixes, and you shouldn't run a preview on a public site that holds data you care about.

## Security model (summary)

The details are in [docs/architecture/security.md](docs/architecture/security.md).

| Area                | How Pressbase handles it                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Passwords           | scrypt (N=2¹⁶, r=8, p=1) with a per-password salt. Hashes are re-hashed on login when parameters are raised.                 |
| Sessions            | A random 256-bit token sits in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` on HTTPS). The server stores only its SHA-256. |
| CSRF                | Every unsafe request must carry the `X-Pressbase-Request` header, which a cross-site request can't add.                          |
| Login throttling    | 5 failures per address and login, and 20 per login, in 15 minutes.                                                           |
| Installer           | Only works before installation. Can be locked with `PRESSBASE_SETUP_TOKEN`.                                                      |
| Credentials on disk | `config.json` is written with mode `0600`.                                                                                   |
