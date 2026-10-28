import { describe, expect, it } from 'vitest';
import { parseArgv, parseSynopsis } from '../src/args';
import { formatItem, formatItems, yaml } from '../src/format';

describe('parseArgv', () => {
  it('reads wp-cli’s grammar', () => {
    expect(
      parseArgv([
        'post',
        'list',
        '--post_type=page',
        '--porcelain',
        '--no-color',
        '--title=a=b',
        '-h',
      ]),
    ).toEqual({
      positionals: ['post', 'list'],
      assoc: { post_type: 'page', porcelain: true, color: false, title: 'a=b', help: true },
    });
  });

  it('treats --key value as a flag and a positional, and stops at --', () => {
    expect(parseArgv(['--format', 'json', '--', '--not-a-flag'])).toEqual({
      positionals: ['json', '--not-a-flag'],
      assoc: { format: true },
    });
  });
});

describe('parseSynopsis', () => {
  it('reads every kind of token', () => {
    expect(
      parseSynopsis(
        '<id>... [<file>] --title=<title> [--status=<status>] [--force] [--<field>=<value>] [--porcelain[=<v>]]',
      ),
    ).toEqual([
      { type: 'positional', name: 'id', optional: false, repeating: true },
      { type: 'positional', name: 'file', optional: true, repeating: false },
      { type: 'assoc', name: 'title', value: 'title', optional: false, valueOptional: false },
      { type: 'assoc', name: 'status', value: 'status', optional: true, valueOptional: false },
      { type: 'flag', name: 'force', optional: true },
      { type: 'generic', optional: true },
      { type: 'assoc', name: 'porcelain', value: 'v', optional: true, valueOptional: true },
    ]);
  });
});

const rows = [
  { ID: 1, post_title: 'Hello, world', tags: ['a', 'b'] },
  { ID: 22, post_title: 'Say "hi"', tags: [] },
];

describe('formatItems', () => {
  const base = { fields: ['ID', 'post_title'], tty: false };

  it('draws an ASCII table in a terminal and tab-separated values when piped', () => {
    expect(formatItems(rows, { ...base, format: 'table', tty: true })).toBe(
      [
        '+----+--------------+',
        '| ID | post_title   |',
        '+----+--------------+',
        '| 1  | Hello, world |',
        '| 22 | Say "hi"     |',
        '+----+--------------+',
      ].join('\n'),
    );
    expect(formatItems(rows, { ...base, format: 'table' })).toBe(
      'ID\tpost_title\n1\tHello, world\n22\tSay "hi"',
    );
  });

  it('writes json, csv, yaml, ids and count', () => {
    expect(JSON.parse(formatItems(rows, { ...base, format: 'json' }))).toEqual([
      { ID: 1, post_title: 'Hello, world' },
      { ID: 22, post_title: 'Say "hi"' },
    ]);
    expect(formatItems(rows, { ...base, format: 'csv' })).toBe(
      'ID,post_title\n1,"Hello, world"\n22,"Say ""hi"""',
    );
    expect(formatItems(rows, { ...base, format: 'yaml' })).toBe(
      '---\n-\n  ID: 1\n  post_title: Hello, world\n-\n  ID: 22\n  post_title: Say "hi"',
    );
    expect(formatItems(rows, { ...base, format: 'ids' })).toBe('1 22');
    expect(formatItems(rows, { ...base, format: 'count' })).toBe('2');
  });

  it('prints one --field per line, and objects as JSON in cells', () => {
    expect(formatItems(rows, { ...base, format: 'table', field: 'post_title' })).toBe(
      'Hello, world\nSay "hi"',
    );
    expect(formatItems(rows, { ...base, fields: ['tags'], format: 'csv' })).toBe(
      'tags\n"[""a"",""b""]"\n[]',
    );
  });
});

describe('formatItem', () => {
  it('shows one object as Field | Value rows, or JSON', () => {
    const item = { ID: 3, post_title: 'Notes' };
    expect(formatItem(item, { format: 'table', fields: ['ID', 'post_title'], tty: false })).toBe(
      'Field\tValue\nID\t3\npost_title\tNotes',
    );
    expect(formatItem(item, { format: 'json', fields: ['ID'], tty: false })).toBe('{"ID":3}');
    expect(formatItem(item, { format: 'table', fields: [], field: 'post_title', tty: false })).toBe(
      'Notes',
    );
  });
});

describe('yaml', () => {
  it('quotes what YAML would misread', () => {
    expect(yaml({ a: 'true', b: '10', c: 'x: y', d: '', e: null, f: { g: [1] } })).toBe(
      '---\na: "true"\nb: "10"\nc: "x: y"\nd: ""\ne: null\nf:\n  g:\n    - 1',
    );
  });
});
