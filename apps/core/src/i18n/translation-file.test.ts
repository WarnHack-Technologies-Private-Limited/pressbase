import { describe, expect, it } from 'vitest';
import { PluralForms, PluralFormsError, pluralFunction } from './plural-forms';
import {
  CONTEXT_GLUE,
  compileMo,
  exportPo,
  parseJed,
  parseMo,
  parsePo,
  parsePoEntries,
  poify,
  TranslationFileError,
} from './translation-file';

describe('plural forms (Plural_Forms)', () => {
  it('follows English when there is no header', () => {
    const plural = pluralFunction(undefined);
    expect([0, 1, 2].map(plural)).toEqual([1, 0, 1]);
  });

  it('evaluates French, Russian and Arabic rules', () => {
    const french = pluralFunction('nplurals=2; plural=(n > 1);');
    expect([0, 1, 2].map(french)).toEqual([0, 0, 1]);

    const russian = pluralFunction(
      'nplurals=3; plural=(n%10==1 && n%100!=11 ? 0 : n%10>=2 && n%10<=4 && (n%100<10 || n%100>=20) ? 1 : 2);',
    );
    expect([1, 2, 5, 11, 21, 22, 25, 111].map(russian)).toEqual([0, 1, 2, 2, 0, 1, 2, 2]);

    const arabic = pluralFunction(
      'nplurals=6; plural=(n==0 ? 0 : n==1 ? 1 : n==2 ? 2 : n%100>=3 && n%100<=10 ? 3 : n%100>=11 ? 4 : 5);',
    );
    expect([0, 1, 2, 3, 11, 100].map(arabic)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('refuses anything outside the grammar instead of running it', () => {
    expect(() => new PluralForms('n; process.exit()')).toThrow(PluralFormsError);
    expect(() => new PluralForms('(n > 1')).toThrow(PluralFormsError);
    expect(() => new PluralForms('n ? 1')).toThrow(PluralFormsError);
    // A broken header falls back to English.
    expect(pluralFunction('nplurals=2; plural=n +* 1;')(1)).toBe(0);
  });
});

describe('.mo files (WP_Translation_File_MO)', () => {
  const headers = {
    'Plural-Forms': 'nplurals=2; plural=(n > 1);',
    Language: 'fr_FR',
  };
  const entries = [
    { singular: 'Posts', translations: ['Articles'] },
    { singular: 'Read', context: 'verb', translations: ['Lire'] },
    {
      singular: '%s comment',
      plural: '%s comments',
      translations: ['%s commentaire', '%s commentaires'],
    },
  ];

  it('reads what it writes: headers, contexts, plural forms', () => {
    const file = parseMo(compileMo(headers, entries));
    expect(file.headers.language).toBe('fr_FR');
    expect(file.entries.get('Posts')).toEqual(['Articles']);
    expect(file.entries.get(`verb${CONTEXT_GLUE}Read`)).toEqual(['Lire']);
    expect(file.entries.get('%s comment')).toEqual(['%s commentaire', '%s commentaires']);
    expect(file.pluralForm(0)).toBe(0);
    expect(file.pluralForm(2)).toBe(1);
  });

  it('reads big-endian files', () => {
    const little = Buffer.from(compileMo(headers, entries));
    const big = Buffer.alloc(little.length);
    little.copy(big);
    for (let offset = 0; offset < 28; offset += 4) {
      big.writeUInt32BE(little.readUInt32LE(offset), offset);
    }
    const count = little.readUInt32LE(8);
    for (const table of [little.readUInt32LE(12), little.readUInt32LE(16)]) {
      for (let i = 0; i < count * 2; i++) {
        big.writeUInt32BE(little.readUInt32LE(table + i * 4), table + i * 4);
      }
    }
    expect(parseMo(big).entries.get('Posts')).toEqual(['Articles']);
  });

  it('refuses files that are not .mo', () => {
    expect(() => parseMo(Buffer.from('not a translation file at all'))).toThrow(
      TranslationFileError,
    );
    expect(() => parseMo(Buffer.alloc(8))).toThrow(/Invalid data/);
  });
});

describe('.po files (PO::import_from_file)', () => {
  const po = `# Translators' notes
msgid ""
msgstr ""
"Language: de_DE\\n"
"Plural-Forms: nplurals=2; plural=n != 1;\\n"

#. translators: the site's name.
#: apps/admin/src/app/page.tsx:12
msgid "Welcome to %s"
msgstr "Willkommen bei %s"

msgctxt "verb"
msgid "Post"
msgstr "Veröffentlichen"

msgid ""
"A long string "
"over two lines"
msgstr ""
"Eine lange Zeichenkette "
"über zwei Zeilen"

msgid "%d item"
msgid_plural "%d items"
msgstr[0] "%d Eintrag"
msgstr[1] "%d Einträge"

msgid "Tab\\there and \\"quotes\\""
msgstr "Tab\\thier und \\"Zitate\\""

#, fuzzy
msgid "Unsure"
msgstr "Unsicher"

msgid "Untranslated"
msgstr ""
`;

  it('reads headers, comments, contexts, continued lines, plurals and escapes', () => {
    const file = parsePo(po);
    expect(file.headers['plural-forms']).toBe('nplurals=2; plural=n != 1;');
    expect(file.entries.get('Welcome to %s')).toEqual(['Willkommen bei %s']);
    expect(file.entries.get(`verb${CONTEXT_GLUE}Post`)).toEqual(['Veröffentlichen']);
    expect(file.entries.get('A long string over two lines')).toEqual([
      'Eine lange Zeichenkette über zwei Zeilen',
    ]);
    expect(file.entries.get('%d item')).toEqual(['%d Eintrag', '%d Einträge']);
    expect(file.entries.get('Tab\there and "quotes"')).toEqual(['Tab\thier und "Zitate"']);
  });

  it('leaves out fuzzy and untranslated entries, as msgfmt does', () => {
    const file = parsePo(po);
    expect(file.entries.has('Unsure')).toBe(false);
    expect(file.entries.has('Untranslated')).toBe(false);
    const { entries } = parsePoEntries(po);
    expect(entries.find((e) => e.singular === 'Welcome to %s')).toMatchObject({
      extractedComments: "translators: the site's name.",
      references: ['apps/admin/src/app/page.tsx:12'],
    });
  });

  it('reports the line of a syntax error', () => {
    expect(() => parsePo('msgid "a"\nmsgstr "b"\nnonsense\n')).toThrow(/line 3/);
    expect(() => parsePo('msgstr "no msgid"\n')).toThrow(TranslationFileError);
  });

  it('writes .pot files it can read back (PO::export)', () => {
    const text = exportPo({ 'Content-Type': 'text/plain; charset=UTF-8' }, [
      { context: '', singular: 'Line one\nLine two', translations: [] },
      {
        context: 'noun',
        singular: '%d post',
        plural: '%d posts',
        translations: [],
        extractedComments: 'translators: a number of posts.',
        references: ['src/a.ts:1'],
      },
    ]);
    expect(text).toContain('msgid ""\n"Line one\\n"\n"Line two"');
    expect(text).toContain('#. translators: a number of posts.\n#: src/a.ts:1\nmsgctxt "noun"');
    const back = parsePoEntries(text);
    expect(back.headers['content-type']).toBe('text/plain; charset=UTF-8');
    expect(back.entries.map((e) => e.singular)).toEqual(['Line one\nLine two', '%d post']);
    expect(poify('say "hi"\\')).toBe('"say \\"hi\\"\\\\"');
  });
});

describe('JSON translations (load_script_translations)', () => {
  it('reads a language pack’s Jed file and its source script', () => {
    const file = parseJed(
      JSON.stringify({
        'translation-revision-date': '2026-10-01 00:00:00+0000',
        domain: 'messages',
        locale_data: {
          messages: {
            '': { domain: 'messages', 'plural-forms': 'nplurals=2; plural=n != 1;', lang: 'de' },
            'Add block': ['Block hinzufügen'],
            [`block title${CONTEXT_GLUE}Paragraph`]: ['Absatz'],
            Old: [null, 'Alt'],
          },
        },
        comment: { reference: 'wp-includes/js/dist/block-editor.js' },
      }),
    );
    expect(file.source).toBe('wp-includes/js/dist/block-editor.js');
    expect(file.headers.lang).toBe('de');
    expect(file.entries.get('Add block')).toEqual(['Block hinzufügen']);
    expect(file.entries.get('Old')).toEqual(['Alt']);
    expect(() => parseJed('{')).toThrow(TranslationFileError);
  });
});
