import sanitizeHtml from 'sanitize-html';

/**
 * Keeping secrets and markup out of what the AI client returns and logs.
 */

/** Shapes of provider keys, redacted wherever they appear in a message. */
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-[A-Za-z0-9_-]{20,}/g, // OpenAI and compatible
  /AIza[A-Za-z0-9_-]{30,}/g, // Google
];

/**
 * Replaces the given keys, and anything shaped like a provider key, with
 * `[redacted]`. Used on every provider error before it is thrown or logged.
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 8) out = out.split(secret).join('[redacted]');
  }
  for (const pattern of KEY_PATTERNS) out = out.replace(pattern, '[redacted]');
  return out;
}

/**
 * "Saved, ends in …abcd": the last four characters, as
 * _wp_connectors_mask_api_key() shows them. Short keys show nothing.
 */
export function keyHint(key: string): string | null {
  return key.length > 8 ? key.slice(-4) : null;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
};

/**
 * Model output as plain text: tags (and the content of script and style)
 * removed, entities decoded so React shows the text as written.
 */
export function stripHtml(text: string): string {
  const stripped = sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
    nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe'],
  });
  return stripped.replace(
    /&(amp|lt|gt|quot|nbsp|#39|#x27);/g,
    (entity) => ENTITIES[entity] ?? entity,
  );
}

/** stripHtml() through every string of a JSON value. */
export function stripHtmlDeep<T>(value: T): T {
  if (typeof value === 'string') return stripHtml(value) as T;
  if (Array.isArray(value)) return value.map((v) => stripHtmlDeep(v)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripHtmlDeep(v)])) as T;
  }
  return value;
}
