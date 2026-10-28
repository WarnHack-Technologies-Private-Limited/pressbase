/**
 * PHP's serialize() format, both ways, for meta values. WordPress stores
 * arrays in meta as PHP-serialized strings (maybe_serialize(),
 * wp-includes/functions.php), and WXR files carry them as they are stored.
 * Pressbase stores meta as JSONB, so imports turn serialized values into JSON
 * and exports turn JSON objects and arrays back into serialized strings.
 *
 * Only data is read: null, booleans, integers, floats, strings and arrays,
 * plus `stdClass` objects (as plain objects). Other objects, references and
 * enums can't mean anything outside PHP, so a value containing one is kept as
 * the original string. String lengths count UTF-8 bytes, as PHP does.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

class Unserializable extends Error {}

/** is_serialized() (wp-includes/functions.php), strict. */
export function isSerialized(value: string): boolean {
  const data = value.trim();
  if (data === 'N;') return true;
  if (data.length < 4 || data[1] !== ':') return false;
  const last = data[data.length - 1];
  if (last !== ';' && last !== '}') return false;
  switch (data[0]) {
    case 's':
      return /^s:\d+:".*";$/s.test(data);
    case 'a':
    case 'O':
    case 'E':
      return /^[aOE]:\d+:/.test(data);
    case 'b':
    case 'i':
    case 'd':
      return /^[bid]:[0-9.E+-]+;$/i.test(data);
    default:
      return false;
  }
}

/**
 * maybe_unserialize(): the JSON value of a serialized string, or the string
 * itself when it isn't serialized (or holds something only PHP understands).
 */
export function maybeUnserialize(value: string): unknown {
  if (!isSerialized(value)) return value;
  try {
    const bytes = Buffer.from(value.trim(), 'utf8');
    const reader = new Reader(bytes);
    const result = reader.value();
    if (reader.pos !== bytes.length) return value;
    return result;
  } catch (error) {
    if (error instanceof Unserializable || error instanceof RangeError) return value;
    throw error;
  }
}

class Reader {
  pos = 0;
  constructor(private readonly bytes: Buffer) {}

  #char(): string {
    if (this.pos >= this.bytes.length) throw new Unserializable();
    return String.fromCharCode(this.bytes[this.pos++] as number);
  }

  #expect(text: string): void {
    for (const ch of text) if (this.#char() !== ch) throw new Unserializable();
  }

  #until(stop: string): string {
    const end = this.bytes.indexOf(stop, this.pos, 'latin1');
    if (end < 0) throw new Unserializable();
    const text = this.bytes.toString('latin1', this.pos, end);
    this.pos = end + 1;
    return text;
  }

  #int(stop: string): number {
    const text = this.#until(stop);
    if (!/^[+-]?\d+$/.test(text)) throw new Unserializable();
    return Number(text);
  }

  value(): Json {
    const type = this.#char();
    if (type === 'N') {
      this.#expect(';');
      return null;
    }
    this.#expect(':');
    switch (type) {
      case 'b':
        return this.#int(';') !== 0;
      case 'i':
        return this.#int(';');
      case 'd': {
        const text = this.#until(';');
        if (text === 'INF' || text === '-INF' || text === 'NAN') return null;
        const n = Number(text);
        if (Number.isNaN(n)) throw new Unserializable();
        return n;
      }
      case 's': {
        const length = this.#int(':');
        this.#expect('"');
        if (this.pos + length > this.bytes.length) throw new Unserializable();
        const text = this.bytes.toString('utf8', this.pos, this.pos + length);
        this.pos += length;
        this.#expect('";');
        return text;
      }
      case 'a':
        return this.#array(this.#int(':'));
      case 'O': {
        const nameLength = this.#int(':');
        this.#expect('"');
        const name = this.bytes.toString('latin1', this.pos, this.pos + nameLength);
        this.pos += nameLength;
        this.#expect('":');
        if (name !== 'stdClass') throw new Unserializable();
        const entries = this.#array(this.#int(':'));
        return Array.isArray(entries) ? { ...entries } : entries;
      }
      default:
        // References (r, R), enums (E), custom serialization (C): PHP only.
        throw new Unserializable();
    }
  }

  #array(count: number): Json {
    this.#expect('{');
    const keys: string[] = [];
    const values: Json[] = [];
    let sequential = true;
    for (let i = 0; i < count; i++) {
      const key = this.value();
      if (typeof key !== 'number' && typeof key !== 'string') throw new Unserializable();
      if (key !== i) sequential = false;
      keys.push(String(key));
      values.push(this.value());
    }
    this.#expect('}');
    if (sequential) return values;
    return Object.fromEntries(keys.map((k, i) => [k, values[i] as Json]));
  }
}

/**
 * The string WordPress would store for a meta value (maybe_serialize()):
 * scalars as text (true → "1", false and null → ""), arrays and objects
 * serialized. A string that already looks serialized is serialized again, as
 * WordPress does, so it survives the round trip as a string.
 */
export function metaToWordPress(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value === true) return '1';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return isSerialized(value) ? phpSerialize(value) : value;
  return phpSerialize(value);
}

/** PHP's serialize() for JSON values. Objects become associative arrays. */
export function phpSerialize(value: unknown): string {
  if (value === null || value === undefined) return 'N;';
  if (typeof value === 'boolean') return `b:${value ? 1 : 0};`;
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return `i:${value};`;
    return Number.isFinite(value) ? `d:${value};` : 'N;';
  }
  if (typeof value === 'string') return `s:${Buffer.byteLength(value, 'utf8')}:"${value}";`;
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const body = entries
    .map(([key, v]) => {
      // PHP turns integer-like string keys into integers.
      const k =
        typeof key === 'number' || /^(0|-?[1-9]\d*)$/.test(key)
          ? `i:${key};`
          : phpSerialize(String(key));
      return `${k}${phpSerialize(v)}`;
    })
    .join('');
  return `a:${entries.length}:{${body}}`;
}
