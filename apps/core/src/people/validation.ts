/**
 * Ports of WordPress's user input checks (wordpress/wp-includes/formatting.php
 * and user.php). They are pure functions so they can be tested on their own.
 */

/**
 * sanitize_user( $username, true ): strips tags and entities, then keeps only
 * the characters WordPress allows in a strict username, collapsing whitespace.
 */
export function sanitizeUser(username: string): string {
  return username
    .replace(/<[^>]*>/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/%[a-fA-F0-9]{2}/g, '')
    .replace(/&.+?;/g, '')
    .replace(/[^a-zA-Z0-9 _.\-@]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}

/** validate_username(): valid when sanitising doesn't change it. Also caps the length at 60, as wp_insert_user() does. */
export function validateUsername(username: string): boolean {
  return username !== '' && username.length <= 60 && sanitizeUser(username) === username;
}

/**
 * is_email(): WordPress's deliberately simple email check. It doesn't follow
 * every RFC rule, and that's the point: the result is the same as WordPress's.
 */
export function isEmail(email: string): boolean {
  if (email.length < 6) return false;
  const at = email.indexOf('@', 1);
  if (at === -1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return false;
  if (domain.includes('..')) return false;
  if (domain.trim() !== domain || /^[.\-\s]|[.\-\s]$/.test(domain)) return false;
  const subs = domain.split('.');
  if (subs.length < 2) return false;
  for (const sub of subs) {
    if (sub.trim() !== sub || /^-|-$/.test(sub)) return false;
    if (!/^[a-z0-9-]+$/i.test(sub)) return false;
  }
  return true;
}

/** WordPress refuses backslashes in passwords (check_user_password in the REST users controller). */
export function passwordProblem(password: string): string | undefined {
  if (!password) return 'Passwords cannot be empty.';
  if (password.includes('\\')) return 'Passwords cannot contain the "\\" character.';
  return undefined;
}

/** esc_url_raw() for profile websites: http(s) only, else empty. */
export function sanitizeUserUrl(url: string): string {
  const value = url.trim();
  if (!value) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `http://${value}`;
  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.toString().slice(0, 100);
  } catch {
    return '';
  }
}
