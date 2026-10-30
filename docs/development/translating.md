# Translating Pressbase

Pressbase speaks your language in two layers:

1. **WordPress's translations.** The block editor, block titles, dates, WordPress.org themes and every string Pressbase shares with WordPress come from WordPress's language packs, translated by the WordPress community on [translate.wordpress.org](https://translate.wordpress.org). An administrator installs a pack in **Settings → General → Add a language…**. To improve those strings, contribute to WordPress's translation team for your language; Pressbase picks up the change with the next pack.
2. **Pressbase's own strings**, in two text domains, translated here, in this repository:
   - `pressbase-admin`: the admin (`languages/pressbase-admin.pot`);
   - `pressbase`: messages from the server, such as REST errors, and the text of the Pressbase theme's patterns (`languages/pressbase.pot`).

How it works is in [Internationalisation](../architecture/i18n.md).

## Contributing a translation

You need a text editor or a PO editor ([Poedit](https://poedit.net) is free), and a WordPress locale code for your language: `de_DE`, `fr_FR`, `pt_BR`, `ja`, `ar`… (the same as WordPress's; see the [locale list](https://translate.wordpress.org)).

1. Copy the template to a file named for the domain and locale:

   ```sh
   cp languages/pressbase-admin.pot languages/pressbase-admin-de_DE.po
   ```

2. Fill in the header: `Language: de_DE`, and your language's `Plural-Forms`, the same as WordPress uses (`nplurals=2; plural=n != 1;` for German; Poedit fills it in).
3. Translate each `msgstr`. You don't have to translate everything: an untranslated string uses WordPress's translation when WordPress has the same English string, and English otherwise.
4. Check it in the admin:
   - run Pressbase (`pnpm dev`);
   - install WordPress's pack for your language in Settings → General, or skip that to see only your strings;
   - choose your language as the site language, or as your own in Profile → Language.

   Pressbase reads `.po` files directly; there's nothing to compile. A file in the repository's `languages/` folder is picked up when it's first used; restart core to see later edits.
5. Open a pull request with the `.po` file. Translations are GPL-2.0-or-later, like the rest of Pressbase.

### Guidelines

- **Placeholders.** Keep `%s`, `%d` and numbered ones (`%1$s`, `%2$s`) exactly; you may reorder numbered ones. The `#.` comment above a string (`translators: %s: the site's title.`) says what each is.
- **Contexts.** `msgctxt` tells two uses of the same English apart (`Post` the noun, `Post` the verb). Translate for that use.
- **Plurals.** Fill every `msgstr[n]` your language's `Plural-Forms` has.
- **Voice.** Pressbase's English follows [Voice and tone](../design/voice-and-tone.md): plain, warm, sentence case. Write as your language's WordPress team writes, so the admin reads as one product with the parts WordPress translates.
- **Fuzzy entries** (marked `#, fuzzy` by PO editors when the English changed) are ignored until you review them and remove the mark.
- **Right-to-left languages** translate `ltr` (context `text direction`) as `rtl`; WordPress's pack does that already.

### Keeping a translation up to date

When the English strings change, the templates change with them. Update your file from the template with your PO editor (Poedit: *Translation → Update from POT file*) or `msgmerge`:

```sh
msgmerge --update languages/pressbase-admin-de_DE.po languages/pressbase-admin.pot
```

## For developers: making strings translatable

### In the admin

```tsx
'use client';
import { useI18n } from '@/lib/i18n/context';

export function Greeting({ name, count }: { name: string; count: number }) {
  const { __, _n, sprintf } = useI18n();
  return (
    <p>
      {
        // translators: %s: the user's first name.
        sprintf(__('Welcome, %s', 'pressbase-admin'), name)
      }{' '}
      {sprintf(_n('%s draft', '%s drafts', count, 'pressbase-admin'), count)}
    </p>
  );
}
```

- Server components: `const { __ } = await getI18n()` from `@/lib/i18n/server`.
- **Always pass the domain** (`'pressbase-admin'`) and a **string literal**: the extractor reads the source and can't see variables.
- Static data (menus, lists): mark it with `msgid('Posts')` from `@/lib/i18n/locale` and translate it where it's shown, `__(item.label, 'pressbase-admin')`.
- Put whole sentences in one string with placeholders; never join translated pieces. Add a `translators:` comment for every placeholder.
- Use `_x()` when the same English means different things (`_x('Draft', 'post status', …)`).
- Reuse WordPress's exact wording when it fits: the string is then translated by WordPress's packs before anyone translates Pressbase.

### In core

```ts
c.get('kernel').i18n.__('Sorry, you are not allowed to do that.', 'pressbase');
kernel.i18n._n('%s comment', '%s comments', count, 'pressbase');
```

Strings rendered on the public site that are WordPress's own (block output) can use the `default` domain without a domain argument: `kernel.i18n.__('Skip to content')`.

### Updating the templates

After adding or changing strings:

```sh
pnpm i18n:extract
```

It rewrites `languages/pressbase.pot` and `languages/pressbase-admin.pot`. Commit them with your change; `apps/core/src/i18n/extract.test.ts` fails when they're out of date (moving code around doesn't count, only the strings).

### Plugins

A plugin translates with `api.i18n` in its own text domain (its slug) and ships `languages/{slug}-{locale}.po` or `.mo`. See [Internationalisation](../architecture/i18n.md#plugins).
