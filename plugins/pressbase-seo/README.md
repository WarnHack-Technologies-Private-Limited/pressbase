# Pressbase SEO

How your site looks in search results and when it's shared, with technical SEO that's right without configuring anything. Bundled with Pressbase; activate it in **Plugins**.

It reads and writes the same data as Yoast SEO, so a WordPress site moved to Pressbase keeps its titles, descriptions, canonicals and robots settings on day one, with nothing to convert.

## What it does

**On every page**, in one block in the `<head>`:

- the title and meta description, from your templates or a post's own;
- the canonical address, and robots directives (index or noindex, follow or nofollow);
- Open Graph and X (Twitter) card tags, with an image that falls back sensibly: the one you chose, the featured image, the first image in the post, then the site's default;
- one schema.org graph: your organisation or person, the website with its search box, the page, articles with their author, the main image and the breadcrumb trail.

**Sitemaps.** Pressbase's own `/wp-sitemap.xml`, without anything you've asked search engines not to index, and with last-modified dates on categories and tags.

**Redirects and the 404 log** (Tools → SEO). Add 301, 302, 307 or 410 rules, with regular expressions when you need them; import and export them as CSV. When a published post's address changes, a 301 from the old address is added for you. The 404 log lists addresses people asked for that don't exist, with the last referrer and a count (never IP addresses), and turns any of them into a redirect in one click.

**In the editor**, an **SEO** tab beside Post and Block:

- **Search preview** for desktop and mobile, measured in pixels as search engines cut titles, with editable title and description and variables like `%%title%%` and `%%sitename%%`;
- **Social preview** for Facebook and X, with an image from the media library;
- **Focus keyphrase and checks**: ten short, honest suggestions (keyphrase in the title, introduction and slug; the description; one H1 and tidy headings; alt text; an internal link; a title no other post uses). Each says why it matters. There's no score to chase, and the checks say what they can't judge;
- **Advanced**: canonical address, noindex and nofollow, breadcrumb title, primary category, cornerstone content.

Before a first publish, "Ready to publish?" shows a short SEO summary. It never stops you publishing.

**Posts and pages lists** get an SEO column (noindex, description set or missing) and a "Missing description" filter. **Categories and tags** get the same SEO fields.

**Breadcrumbs block** (Theme category): the same trail as the schema graph. Themes and plugins can also get it as HTML with the `pressbase_seo_breadcrumbs` filter.

**Crawling** (Settings → SEO): turn sitemaps on or off, add lines to `robots.txt`, publish an `llms.txt` (off until you turn it on), and tell IndexNow engines (Bing, Yandex and others) about new and changed posts (on by default unless the site asks search engines to stay away).

**AI suggestions (optional).** When an administrator turns AI on in **Settings → AI**, Suggest buttons appear next to the title, description, social texts and missing alt text. They offer two or three options; nothing changes until you pick one. Only the post's title, excerpt and opening paragraphs are sent, never a password-protected post's content, and the panel names the provider.

**Imports.** Tools → SEO → Import brings in Rank Math's and All in One SEO's titles, descriptions, keyphrases, canonicals, robots and social texts, converting their variables. Existing values are kept.

**Site Health** gets three checks: search engines discouraged, no site representation, and whether the sitemap answers.

**From the command line:**

```sh
pressbase pressbase-seo audit          # every published post and page
pressbase pressbase-seo audit 12 15    # some posts; --format=json, --all
```

## Settings → SEO

The first time you open it, three questions: is the site for an organisation or a person, its name and logo, and is the site ready to be indexed. Then:

- **Site representation:** organisation or person, name, logo, website name.
- **Search appearance:** the title separator; title and description templates for the home page, posts, pages, categories, tags, author and date archives, each with a live preview; and noindex for any of them, and for media attachment pages.
- **Social:** the default share image, your Facebook page, X username and other profiles.
- **Crawling:** sitemaps, `robots.txt` additions, `llms.txt`, IndexNow, automatic redirects for changed slugs.

## Title variables

`%%title%%`, `%%sitename%%`, `%%sitedesc%%`, `%%sep%%`, `%%page%%`, `%%pagenumber%%`, `%%pagetotal%%`, `%%excerpt%%`, `%%excerpt_only%%`, `%%category%%`, `%%primary_category%%`, `%%tag%%`, `%%term_title%%`, `%%term_description%%`, `%%category_description%%`, `%%tag_description%%`, `%%date%%`, `%%modified%%`, `%%name%%` (the author), `%%user_description%%`, `%%searchphrase%%`, `%%pt_single%%`, `%%pt_plural%%`, `%%focuskw%%`, `%%id%%`, `%%parent_title%%`, `%%archive_title%%`, `%%currentyear%%`, `%%currentmonth%%`, `%%currentday%%`, `%%currentdate%%`. Unknown variables are removed, and separators left at either end are dropped.

## For developers

- Filters: `pressbase_seo_schema_graph (graph, context)`, `pressbase_seo_head (head, context)`, `pressbase_seo_breadcrumbs (html, { main, separator })`.
- REST: posts, pages, categories and tags have `pressbase_seo_head` (`view` context) with the structured head and its rendered HTML, for headless sites. The SEO fields are under `meta`.
- Abilities: `pressbase-seo/suggest-meta`, `pressbase-seo/suggest-alt-text`, `pressbase-seo/audit-post` (`/wp-abilities/v1`, `pressbase ability run`).
- How it's built and which plugin APIs it uses: [docs/architecture/seo-plugin.md](../../docs/architecture/seo-plugin.md).

```sh
pnpm --filter pressbase-seo build        # src → dist (pnpm dev watches)
pnpm --filter pressbase-seo test         # builds, then runs the tests
node plugins/pressbase-seo/build.mjs --pot   # languages/pressbase-seo.pot
```

## Limits

- The content checks are for English only, and can't judge what matters most: whether a post answers what people search for.
- Pixel widths are approximations of Google's layout.
- Deleting the plugin removes its redirects and 404 log. Titles, descriptions and the other SEO fields stay with your content (they're Yoast's fields, usable by other SEO tools).

GPL-2.0-or-later.
