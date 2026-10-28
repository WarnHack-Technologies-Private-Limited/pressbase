/**
 * Output formats: a port of WP_CLI\Formatter
 * (wp-cli/php/WP_CLI/Formatter.php). `table` is an ASCII table in a
 * terminal and tab-separated values when piped, as wp-cli does
 * (cli\Table with the Ascii or Tabular renderer); json, csv, yaml, ids
 * and count as in wp-cli.
 */

export const FORMATS = ['table', 'json', 'csv', 'yaml', 'ids', 'count'] as const;
export type Format = (typeof FORMATS)[number];

export type Row = Record<string, unknown>;

/** A value as text for table and csv cells: objects as JSON, null as empty. */
export function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

function asciiTable(fields: string[], rows: Row[]): string {
  const cells = rows.map((row) => fields.map((f) => cell(row[f]).replace(/\r?\n/g, ' ')));
  const widths = fields.map((f, i) =>
    Math.max(f.length, ...cells.map((r) => [...(r[i] ?? '')].length)),
  );
  const line = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const render = (values: string[]) =>
    `|${values.map((v, i) => ` ${v}${' '.repeat((widths[i] ?? 0) - [...v].length)} `).join('|')}|`;
  return [line, render(fields), line, ...cells.map(render), line].join('\n');
}

function tabular(fields: string[], rows: Row[]): string {
  const clean = (v: unknown) => cell(v).replace(/[\t\r\n]+/g, ' ');
  return [fields.join('\t'), ...rows.map((row) => fields.map((f) => clean(row[f])).join('\t'))].join(
    '\n',
  );
}

function csvValue(value: unknown): string {
  const text = cell(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(fields: string[], rows: Row[]): string {
  return [fields.map(csvValue).join(','), ...rows.map((r) => fields.map((f) => csvValue(r[f])).join(','))].join(
    '\n',
  );
}

/* ------------------------------------------------------------------ yaml */

function yamlScalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = cell(value);
  if (
    text === '' ||
    /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) ||
    /[:#]\s|\s$|\n/.test(text) ||
    /^(true|false|null|yes|no|on|off|~|[-+]?\d[\d.e+-]*)$/i.test(text)
  ) {
    return JSON.stringify(text);
  }
  return text;
}

function yamlBlock(value: unknown, indent: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return ' []';
    return value
      .map((item) => {
        return `\n${indent}-${yamlBlock(item, `${indent}  `)}`;
      })
      .join('');
  }
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value);
    if (!entries.length) return ' {}';
    return entries.map(([k, v]) => `\n${indent}${yamlScalar(k)}:${yamlBlock(v, `${indent}  `)}`).join('');
  }
  return ` ${yamlScalar(value)}`;
}

/** YAML like wp-cli's (Spyc): a document marker, then the value. */
export function yaml(value: unknown): string {
  return `---${yamlBlock(value, '')}`;
}

/* ------------------------------------------------------------ formatting */

export interface FormatOptions {
  format: Format;
  fields: string[];
  /** --field: print only this field's value, one per line. */
  field?: string;
  /** The field `ids` prints. Default `ID`, else the first field. */
  idField?: string;
  /** ASCII borders (a terminal) or tab-separated (piped). */
  tty: boolean;
}

function pick(row: Row, fields: string[]): Row {
  return Object.fromEntries(fields.map((f) => [f, row[f] ?? null]));
}

/** WP_CLI\Formatter::display_items() */
export function formatItems(rows: Row[], options: FormatOptions): string {
  const { format, fields } = options;
  if (options.field) {
    const values = rows.map((r) => r[options.field as string]);
    if (format === 'json') return JSON.stringify(values);
    if (format === 'yaml') return yaml(values);
    return values.map(cell).join('\n');
  }
  switch (format) {
    case 'count':
      return String(rows.length);
    case 'ids': {
      const key = options.idField ?? (fields.includes('ID') ? 'ID' : (fields[0] ?? 'ID'));
      return rows.map((r) => cell(r[key])).join(' ');
    }
    case 'json':
      return JSON.stringify(rows.map((r) => pick(r, fields)));
    case 'yaml':
      return yaml(rows.map((r) => pick(r, fields)));
    case 'csv':
      return csv(fields, rows);
    default:
      if (!rows.length) return options.tty ? '' : fields.join('\t');
      return options.tty ? asciiTable(fields, rows) : tabular(fields, rows);
  }
}

/** WP_CLI\Formatter::display_item(): one object, as Field | Value rows in a table. */
export function formatItem(item: Row, options: FormatOptions): string {
  const { format, fields } = options;
  if (options.field) {
    const value = item[options.field];
    if (format === 'json') return JSON.stringify(value);
    if (format === 'yaml') return yaml(value);
    return cell(value);
  }
  const picked = pick(item, fields);
  switch (format) {
    case 'json':
      return JSON.stringify(picked);
    case 'yaml':
      return yaml(picked);
    case 'csv':
    case 'table': {
      const rows = fields.map((f) => ({ Field: f, Value: picked[f] }));
      return format === 'csv'
        ? csv(['Field', 'Value'], rows)
        : options.tty
          ? asciiTable(['Field', 'Value'], rows)
          : tabular(['Field', 'Value'], rows);
    }
    default:
      return cell(item[options.idField ?? fields[0] ?? 'ID']);
  }
}
