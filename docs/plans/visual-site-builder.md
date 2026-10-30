# Plan: the visual site builder and building with AI

Status: **accepted** 2026-10-29, with the [decisions](#decisions) below. Written after v0.7. The work is split into GitHub issues in the **v0.8: Studio** milestone, so anyone can pick one up.

## Summary

- **Build a visual site builder that a first-time site owner can use,** and let them start it from a prompt: "a site for my bakery in Pune, warm and friendly, with a menu and opening hours" becomes a draft site with a design, pages, header, footer and menu, ready to edit by hand.
- **The builder is Pressbase Studio: the site editor, done well,** with the direct, drag-and-drop feel of Elementor, but not a page-builder format of our own. Everything it makes is standard block markup, `theme.json` global styles and `wp_template` / `wp_template_part` posts, so pages stay fast (server-rendered, no builder runtime), editable in the block editor, exportable as a block theme and portable to WordPress. This keeps the [vision](../vision.md#non-goals)'s line ("the block editor is the canvas") and the SEO plan's answer to Elementor ("the site editor is the answer").
- **AI works on the same document as the person.** Every AI change is a set of ordinary edits: shown before it's applied, undoable, revisioned, and held in a draft (a changeset) until someone presses Publish. This is the lesson of Wix Harmony, Webflow and Puck AI ([research](#what-the-market-does-october-2026)).
- **AI fills sections; code guarantees quality.** The model chooses patterns and writes their text; code turns that into valid blocks, computes accessible palettes, checks contrast and headings, and refuses invented facts. The model never writes raw CSS or free-form HTML in the default path.
- **Built on what v0.7 shipped:** the core AI client and the Abilities API ([ADR 0019](../adr/0019-ai-client-and-abilities.md)). New site-building abilities also make Pressbase buildable by outside agents over MCP later ([roadmap: Later](../roadmap.md#later)).
- **Proposed as v0.8, before v1.0,** because the site editor adds extension points (template slots, Studio panels, abilities) that should exist before the plugin API is frozen.

## What the market does (October 2026)

| Product | How AI building works | What we take |
| --- | --- | --- |
| **Wix Harmony** (Jan 2026) | Prompts generate a site, a page or a section; an agent, Aria, stays in the editor rather than generating once. Wix rebuilt the editor so prompt edits and drag-and-drop edits work on the same project. Included in every plan, free tier too. | One document for AI and hand edits; AI as an ongoing collaborator, not a one-shot wizard. |
| **Framer** | *Wireframer* turns one prompt into a responsive page with layout and navigation, revised by chat; *Workshop* builds components that follow the site's styles. AI on every plan. | Section-level generation; generated parts follow the site's tokens. |
| **Webflow AI site builder** | Up to five pages per run, plus a generated *style guide* page (colours, type, cards, spacing). Output is layered: tokens, then components, then pages. Its AI Assistant edits pages (public beta). | Design system first, then pages built from it; a visible style guide (our *style book*). |
| **Elementor** | *AI Site Planner* produces a sitemap and wireframes from a prompt; *Angie* is an agent that reads the site through MCP and does multi-step tasks. Paid AI credits. | Plan (sitemap) before building; agents through a protocol (our abilities). |
| **WordPress 7.x** | Core AI client, Connectors and the Abilities API (7.0), an MCP adapter; 7.1 adds responsive block styles (base + tablet + mobile), theme-defined breakpoints and style states (`:hover`, `:focus`). Telex (Automattic) generates single blocks as plugins. | Names and data shapes to port: responsive styles, breakpoints, style states, abilities. |
| **Puck AI** (open source editor) | Generates pages as JSON from the developer's own components, within their guardrails; reviewed in the visual editor; bring your own key. | Generate from a fixed component set; store structured output; review before saving. |
| **10Web, TeleportHQ, UX Pilot** | Preview and edit the structure before generating; generate a design system first and reuse it for every later edit. | Approve the brief and sitemap first; validate output against tokens (no stray hex values). |

**Two weaknesses to beat.** Page builders are criticised for heavy output: deeply nested markup, inline CSS and extra JavaScript, with Core Web Vitals (CLS especially) that independent tests struggle to pass ([WP Rocket](https://wp-rocket.me/blog/divi-vs-elementor-performance-speed), [AccelerateWP](https://accelerawp.com/divi-vs-elementor-performance-comparison/)). And AI-generated sites tend to look generic ([InspoAI](https://www.inspoai.io/blog/why-ai-websites-look-generic)) and to invent content: testimonials, prices, addresses. Pressbase can be the builder whose generated sites are fast, accessible and honest by construction.

## What Pressbase has today

| Have | Missing for a site builder |
| --- | --- |
| Gutenberg for posts and pages (`@wordpress/block-editor` in our own shell), patterns, synced patterns, plugin blocks | Templates and template parts: storage, REST, editing (`wp_template`, `wp_template_part`) |
| `theme.json` engine, the Pressbase theme (29 patterns, 4 looks; Twenty Twenty-Five until v0.7) and theme upload, Appearance → Styles with variations, colours, type, layout, revisions, live preview | Per-block styles, shadows, borders, the style book and Additional CSS in the admin; responsive styles; style states; a font library |
| Menus (Appearance → Menus), site logo and icon | Editing the header and footer in place; a page tree |
| AI client: text and JSON output, ability tool loop (5 rounds), daily caps, usage log, 30 s timeout | Streaming, longer and per-call timeouts, image input (screenshots), image generation |
| Abilities API: one core ability, `core/get-site-info` | Site-building abilities (read the page structure, insert a section, change global styles…) |
| Job queue, revisions, autosave | A changeset: one draft across styles, templates, pages and menus, published together |

## The product

### Who it's for

- **The first-time owner** (a baker, a clinic, a local school): wants a good-looking site tonight, doesn't know what a "block" or a "template" is, and must never see code unless they ask.
- **The designer or agency:** wants precise control (spacing, breakpoints, hover states), a design system to reuse, and starter kits for clients.
- **The developer:** wants the result in files: export the site as a block theme, keep it in Git, deploy it.

### Principles

1. **Visual first, nothing hidden.** Click the page to edit it. Code view is always one click away for those who want it.
2. **Three levels, always clear:** *Site* (styles, header, footer, pages), *Page* (sections), *Block*. The breadcrumb shows where you are.
3. **Simple mode by default.** Beginners see content, colour, font, spacing presets and alignment. *Advanced* reveals units, breakpoints, states, custom CSS. One toggle, remembered per user.
4. **Nothing breaks the live site.** Edits go into a draft changeset with Preview, Publish and Discard. Every publish is a revision.
5. **AI proposes, people decide.** A change from AI is shown as a highlighted diff with *Keep* and *Undo*; it is never published on its own.
6. **Fast and accessible output, by construction.** Generated pages ship no builder JavaScript, meet WCAG 2.2 AA contrast, keep heading order, and have alt text or a reason why not.
7. **Honest content.** AI never invents facts about the business. Anything it doesn't know becomes a visible placeholder on a "Before you publish" checklist.

### The screen

**Studio** is its own item in the admin menu, at `/admin/studio` (capability `edit_theme_options`; it does what WordPress's Appearance → Editor does, and Appearance → Editor redirects to it). It opens full-screen, like Elementor. Pages and the post editor get an **Edit with Studio** action that opens the same screen with that page selected. Authors without `edit_theme_options` can open their own pages in Studio, but the header, footer and site styles are locked for them.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◀ Admin   Home ▾   [🖥 Desktop | Tablet | Mobile]   ↶ ↷   ✦ Ask AI   Preview  [Publish 3] │
├────┬─────────────────────────────────────────────────────┬───────────────────┤
│ ▤  │  ┌─ Header (all pages) ─────────────────────────┐  │ Section · Hero     │
│ ⊞  │  │ Logo     Home  Menu  About  Contact          │  │ ───────────────── │
│ ≣  │  └──────────────────────────────────────────────┘  │ Content  Style  ⋯ │
│ ◐  │  ┌─ Hero ──────────────────────── ⇅ ⧉ ✦ ⋯ ─────┐  │ Layout  ◻ ◫ ◨      │
│ ▣  │  │  Fresh bread, every morning                  │  │ Background ●●●○    │
│ ✦  │  │  [See the menu]                              │  │ Spacing  S M [L]   │
│    │  └──────────────────────────────────────────────┘  │ Swap layout ‹ 2/5 ›│
│    │        ＋ Add section                               │                    │
│    │  ┌─ Opening hours ──────────────────────────────┐  │ Simple ◉ Advanced │
└────┴─────────────────────────────────────────────────────┴───────────────────┘
 Left rail: ▤ Pages · ⊞ Sections · ≣ Layers · ◐ Styles · ▣ Media · ✦ AI
```

- **Canvas:** the real page in the active theme, header and footer included (iframed, as the post editor). Hovering shows section outlines; the floating section toolbar has move (⇅), duplicate (⧉), *Ask AI* (✦) and more.
- **Left rail:** *Pages* (tree, add, reorder, set as home), *Sections* (the pattern library by category, with previews in the site's own styles), *Layers* (list view), *Styles* (design system, style book), *Media*, *AI* (the chat panel).
- **Inspector:** Content / Style / Layout tabs for the selection. In Tablet or Mobile view, a style change applies to that size only and shows a dot ("changed for mobile") with a reset.
- **Swap layout:** cycles the same section through other patterns of its category, keeping its text and images (headings, paragraphs, buttons and images are matched by role; see [slots](#slots)).
- **Publish N:** the number of changed items in the changeset (styles, header, two pages…), listed on click.

### Interactions taken from Elementor

People who've used Elementor should feel at home. Each of these acts on blocks, so the saved result is still block markup:

| Elementor | Studio |
| --- | --- |
| Widgets panel, dragged onto the page | **Elements** tab in the left rail: blocks as large tiles, dragged onto the canvas with a drop line between blocks and a highlighted drop area inside groups and columns |
| Navigator | **Layers**, with drag to reorder and nest, rename, hide on a device |
| Right-click menu | Context menu on any block or section: copy, paste, **paste style**, duplicate, save as section, Ask AI, delete |
| Copy and paste style | Paste style copies a block's style attributes (presets only) onto another block of a compatible type |
| Responsive mode | Desktop, Tablet and Mobile in the top bar; per-device values with a marker and a reset |
| Spacing handles | Drag the padding and margin of a selected section on the canvas, snapping to the spacing presets (Advanced shows exact values) |
| Column resize | Drag the gap between columns; widths snap to sensible fractions |
| Site Settings (global colours and fonts) | **Styles**: the design system, with every use updated live |
| History panel | **History**: this session's actions to step back to, then the published revisions |
| Finder (⌘E) | Command palette (⌘K): jump to a page, add a section, run an AI request, toggle a setting |
| Template kits | Starter sites |

Elementor's weak points that we avoid on purpose: its own data format (lock-in), extra front-end CSS and JavaScript, and nested wrapper markup.

### Features and phases

| Area | v1 (v0.8) | v2 | Later |
| --- | --- | --- | --- |
| **Site editor** | Templates and parts stored as WordPress does, customised copies with "Reset to theme"; header and footer edited in place; page tree; template per page | Template hierarchy browser (archives, single, 404, search) | Query loop builder UI |
| **Sections** | Section library from theme patterns plus ~40 Pressbase patterns (hero, features, services, pricing, team, testimonials, FAQ, gallery, contact, CTA, opening hours, map link); Swap layout; section toolbar | Saved sections per site; section style presets (light, dark, accent) | Community pattern directory |
| **Design system** | Colours, fonts, spacing, radius, buttons in Simple mode; style book; per-block styles, borders, shadows; Additional CSS (Advanced, `edit_css`) | Font library with local hosting of Google Fonts (no requests to Google from visitors) and uploads | Brand kit import from a logo or URL |
| **Responsive** | Port of WordPress 7.1 responsive block styles: base + tablet + mobile overrides, breakpoints from `theme.json`, per-device block visibility | Style states (`:hover`, `:focus-visible`) with UI for buttons and links | Container queries |
| **Changesets** | One draft across styles, templates, parts, menus and pages; Preview link; Publish; Discard | Scheduled publish; share a preview link with a client | Real-time co-editing (roadmap: Yjs) |
| **Starter sites** | 6 kits (business, restaurant, portfolio, blog, event, nonprofit), each a style + pages + parts | Kits from plugins and themes | — |
| **Export** | Export the site as a block theme `.zip` (templates, parts, patterns, `theme.json` with user styles merged), as WordPress's Create Block Theme does | — | — |
| **AI: build** | Prompt to site; prompt to page; prompt to section | Screenshot or sketch to section (image input); seed from an existing site's URL | Image generation |
| **AI: edit** | Ask AI on a selection (rewrite, shorten, translate, tone); site-wide requests in the AI panel ("make the brand colour green and the buttons rounder") with a diff to keep or undo | Multi-step agent tasks across pages ("add a Services page and link it in the menu") | Abilities over MCP for outside agents |
| **AI: quality** | Contrast, heading order, alt text, placeholder and link-text checks after every generation | Performance budget check on Preview | — |
| **Images** | The user's own uploads first; Openverse search for openly licensed photos with attribution saved to the media item | Alt text for new uploads (Pressbase SEO already suggests alt text) | AI image generation through a provider |
| **Motion** | — | Entrance animations, CSS-only, off under `prefers-reduced-motion` | — |

## Building with AI

### The flow for a new site

Offered on a fresh install (after the installer, when AI is set up) and from Studio's AI panel. Each step can be edited before going on, and Back always works.

1. **Describe.** One text box ("What's the site for?") and, optionally, the business name, location, contact details, logo and photos. Language defaults to the site language.
2. **Clarify.** At most three short questions the model can't answer from the description (for example "Do you take orders online?"). Skippable.
3. **Brief.** An editable card: name, type, audience, tone, key facts, pages. Saved as `pressbase_site_brief`, so every later AI request knows the site.
4. **Design direction.** Three directions shown as live mini previews of a hero in the site's theme: palette, font pair, corner style, spacing density. "Show three more", or pick and adjust colours and fonts directly.
5. **Sitemap.** Pages with their ordered sections ("Home: hero, about, menu highlights, testimonials placeholder, opening hours, contact"), drag to reorder, add or remove sections and pages (up to 8 pages in v1).
6. **Generate.** Pages build one by one with live progress (each page appears in the canvas as it's done). Runs as a job, so closing the tab doesn't lose it.
7. **Review.** Studio opens on the draft changeset with the "Before you publish" checklist: placeholders to fill, images to replace, checks that failed. Publish when ready.

### Pipeline

Generation is a fixed pipeline in code, not a free-running agent. Each stage is one structured (`generateJson()`) call with a schema, so it can be validated, retried once and tested.

| Stage | Model output (JSON schema) | Done in code |
| --- | --- | --- |
| Brief | `{ name, kind, audience, tone, facts[], pages[], language }` | Facts from the form override the model's; anything not given stays empty |
| Design | `{ mood, hue, contrast, fontPair (enum), radius (enum), density (enum) }` | Palette generated from the hue in OKLCH with every text/background pair checked against WCAG AA; written as user global styles (`wp_global_styles`) |
| Sitemap | `{ pages: [{ title, slug, sections: [{ category (enum), intent }] }] }` | Slugs made unique; menu built; front page set (`show_on_front = page`) |
| Page | per section: `{ pattern (enum from the library), slots: { … } }` | Pattern + slots rendered into block markup; header and footer parts filled; pages saved as drafts in the changeset |
| Check | — | Block validation, contrast, headings, alt text, placeholders, links; failures listed on the checklist |

One page is one call (its sections together, so the copy flows), run in parallel up to three at a time. A five-page site is about eight calls; the token count is shown from the `ai_requests` log after each run, and the run stops cleanly at the daily cap.

### Slots

The model never writes block markup in the default path. It picks a pattern by name and fills its **slots**:

- A pattern's slots are derived automatically by walking its blocks: headings, paragraphs, list items, buttons (text and link), images (subject and alt) and repeated groups (cards, columns) become numbered, typed slots with length limits taken from the pattern's own text. So every theme pattern, including Twenty Twenty-Five's, is fillable without extra work.
- Patterns may declare richer slots in their metadata (`Slots:` header or JSON beside a block-markup pattern), for example "items: 3–6".
- Code puts the text in place, keeps every attribute and style preset as the pattern had it, and serialises with `@pressbase/blocks`. Output is therefore always valid blocks using only the theme's presets.
- Swap layout reuses this: read the slots of the current section, write them into the next pattern.
- **Custom sections** (v2, Advanced): when nothing in the library fits, the model may write block markup. It's parsed, checked against the allowed blocks, stripped of anything outside presets and sanitised as for a user without `unfiltered_html`; invalid output is retried once, then refused with a message.

### Edits after generation

Edits in the AI panel and *Ask AI* are expressed as a small set of **operations** on the editor's state:

`insertSection`, `replaceSection`, `moveSection`, `removeSection`, `updateSlots`, `updateBlockAttributes` (presets only), `setGlobalStyles`, `updateTemplatePart`, `createPage`, `updateMenu`.

The model returns operations (through the ability tool loop for questions that need to read the site first, such as "what's on the About page?"); the admin applies them through the block editor's data stores, so they join undo history, are highlighted in the canvas, and the panel offers *Keep* or *Undo* for the whole set. Nothing reaches the database until the changeset is saved.

### Honest content

- The prompt forbids inventing facts, and the schema separates `facts` (from the user) from `copy` (written).
- Testimonials, team members, prices, addresses, phone numbers, opening hours and statistics are filled only from the brief's facts. Otherwise the slot gets a placeholder (`[Add a customer quote]`), styled in the editor and listed on the checklist.
- Publishing with placeholders left asks for confirmation and names them.
- Images: the user's uploads, then Openverse results with the licence and attribution stored on the media item; never AI images passed off as photos of the business.

### Abilities

Registered in core, permission-checked as the user (`edit_theme_options` for styles and templates, `edit_pages` / `publish_pages` for pages), WordPress-style names:

| Ability | Reads or writes |
| --- | --- |
| `core/get-site-brief`, `core/get-design-system` | Brief; global styles and presets |
| `core/list-patterns` | Library with categories and slots |
| `core/get-page-structure` | A page's sections and their slots |
| `core/create-page`, `core/update-page-sections` | Pages (always drafts, in a changeset) |
| `core/update-global-styles`, `core/update-template-part` | Styles; header and footer |
| `core/check-page` | The quality checks, as data |

The same abilities serve the AI panel, the CLI (`pressbase ability run`) and, once the MCP server lands, outside agents like Claude Code. No ability publishes; publishing a changeset stays a human action in v1.

### Changes to the AI client

- **Streaming** (`streamText()`), so the panel shows replies as they're written and pages appear progressively.
- **Per-call timeouts** (`usingTimeout()`): generation stages need 60–120 s, not the 30 s default.
- **Image input** (`withImage()`) for screenshot-to-section in v2.
- **Model tiers:** an optional second site setting, "model for quick edits", for rewrites and small edits; callers still never name a model.
- Requests are attributed to the ability (`site-builder/brief`, `…/page`), so the usage log shows where tokens go.

### Security and privacy

- Text from an imported URL, uploaded files or existing content is data, never instructions: it's passed in a separate, labelled part of the prompt, and abilities enforce permissions whatever the model asks.
- Generated content is sanitised as for a user without `unfiltered_html`, even for administrators; Additional CSS is never written by AI in v1.
- The brief and prompts go to the provider only when AI is on (it's off until an administrator turns it on, ADR 0019); the log keeps counts, never content.

## Architecture

- **Studio is our own editor around `@wordpress/block-editor`,** like the post editor, not `@wordpress/edit-site`. Edit-site assumes WordPress's full core-data entities and PHP-registered settings; our post editor already shows that the lower-level packages work well in our admin. To record in an ADR.
- **Templates and parts:** `wp_template` and `wp_template_part` post types with the `wp_theme` taxonomy and WordPress's REST routes (`/wp/v2/templates`, `/wp/v2/template-parts`, their revisions, `source: theme | custom`), resolved before theme files by the renderer, as `get_block_templates()` does. The template-part and post-content blocks leave `UNSUPPORTED_BLOCKS` inside the site editor.
- **Changesets:** the `customize_changeset` post type (WordPress's name and status flow: `auto-draft`, `draft`, `future`, `publish`), its content a JSON map of pending entities (`wp_global_styles`, templates, parts, pages, menus, options). Preview renders with `?changeset_uuid=`, bypassing the page cache. Publishing applies the entries in one database transaction, then purges cache tags once.
- **Responsive styles:** extend `@pressbase/theme-json` and block supports to WordPress 7.1's format: breakpoints in `settings.viewport` (default `mobile` 480px, `tablet` 782px) and `@tablet` / `@mobile` style states, ported from `WP_Theme_JSON::get_viewport_media_queries()`, plus the `blockVisibility` support. 7.1 themes then work unchanged; the renderer emits the media queries in the global stylesheet, not inline.
- **Generation jobs:** the job queue ([ADR 0010](../adr/0010-job-queue.md)) runs the pipeline; the admin follows progress over Server-Sent Events from `/pressbase/v1/site-builder/runs/{id}`.
- **Where it lives:** the site editor, changesets, responsive styles and abilities are core. The AI flow is core too, built only on `kernel.ai` and abilities, and hidden until AI is set up (see [decisions](#decisions)).

### New ADRs

| ADR | Topic |
| --- | --- |
| 0021 | The site editor shell and templates storage |
| 0022 | Changesets |
| 0023 | Responsive styles and breakpoints |
| 0024 | AI site building: pipeline, slots, operations, honest content |

## Phases

Two agents at a time, each in a worktree with its own ports and ADR, as in v0.6 and v0.7.

| Milestone | Scope | Parallel tracks |
| --- | --- | --- |
| **M1: Site editor** | Templates and parts (storage, REST, renderer), changesets, the editor screen with header and footer in place, page tree, Simple/Advanced mode | Core (templates, changesets) · Admin (shell, canvas, pages) |
| **M2: Design** | Section library and Swap layout, ~40 patterns, style book, per-block styles, Additional CSS, responsive styles and visibility, starter kits, export as block theme | Core (responsive styles, export) · Admin (sections, styles UI) |
| **M3: AI foundations** | Streaming, timeouts and image input in the AI client; slot extraction and rendering; palette generator; quality checks; site-building abilities; operations | Core (client, abilities, checks) · Shared (slots, palette in a package) |
| **M4: AI experiences** | Prompt-to-site flow, AI panel with Keep/Undo, Ask AI on selection, prompt to page and section, Openverse images | Admin (flow, panel) · Core (pipeline, jobs, SSE) |
| **M5: Launch** | Evaluation suite, e2e, accessibility audit of the editor, performance budget of generated sites, docs, screenshots and a demo GIF for the README | — |

### How we'll know it works

- **An evaluation suite** in CI (with a recorded-response mode so it runs without a key): 30 fixed briefs (bakery, dentist, portfolio, school, non-English sites…). Each generated site must have zero invalid blocks, AA contrast on every pair, one `h1` per page and no skipped levels, and no invented facts (checked against the brief); scored and tracked per release.
- **Lighthouse on the generated home page:** performance ≥ 95 and accessibility 100 on mobile.
- **Usability:** five people who've never built a site each publish one in under 15 minutes without help.
- **Cost:** a five-page site within the default daily cap (100 requests) with room to edit.

## Out of scope for v1

- A proprietary page format, absolute positioning, or a builder runtime on the public site.
- Shop features (that's a WooCommerce-class plugin, later).
- AI publishing on its own, or changing settings outside appearance and content.
- Multisite "site factory" generation for agencies.

## Decisions

Made on 2026-10-29:

1. **Release:** v0.8, before v1.0, so Studio's extension points are part of the frozen plugin API.
2. **AI in core:** the prompt-to-site flow, the AI panel and the site-building abilities are core, built only on `kernel.ai` and the Abilities API, and hidden until an administrator sets up AI.
3. **Name:** **Studio**, its own item in the admin menu at `/admin/studio`. Appearance → Editor redirects there for people coming from WordPress.
4. **Our own editor**, with Elementor's direct, drag-and-drop interactions ([above](#interactions-taken-from-elementor)), built around `@wordpress/block-editor`, not `@wordpress/edit-site`. Output stays block markup and `theme.json`.
5. **Openverse images in v1**, with licence and attribution saved on the media item.
6. **A second model setting for quick edits** (rewrites, small changes). Generation uses the main model.

## Sources

- Wix Harmony: [Wix press release](https://www.wix.com/press-room/home/post/wix-launches-wix-harmony-the-ai-website-builder-that-merges-human-and-artificial-intelligence-rein), [TechRadar](https://www.techradar.com/pro/website-building/wix-launches-harmony-a-hybrid-approach-to-vibe-coding-and-visual-design), [Tech.co](https://tech.co/?p=365099)
- Framer: [TechRadar](https://www.techradar.com/pro/framer-aims-to-increase-productivity-but-maintain-magic-with-new-website-building-features), [Business Wire](https://www.businesswire.com/news/home/20250521574932/en)
- Webflow: [AI site builder update](https://webflow.com/updates/ai-site-builder-evolved), [help: build a site with the AI site builder](https://help.webflow.com/hc/en-us/articles/38840145286035), [help: AI Assistant](https://help.webflow.com/hc/articles/34205154436243)
- Elementor: [AI website guide](https://elementor.com/blog/ai-website-2026-guide/), [WordPress AI agent builder](https://elementor.com/blog/wordpress-ai-agent-builder/) (vendor sources)
- WordPress: [roadmap](https://wordpress.org/about/roadmap/), [responsive block styles and configurable viewports in 7.1](https://make.wordpress.org/core/2026/08/05/responsive-block-styles-and-configurable-viewports-in-wordpress-7-1/), [WordPress 7.1 source of truth](https://gutenbergtimes.com/wordpress-7-1-source-of-truth/), [WordPress 7.0 and AI (InfoQ)](https://infoq.com/news/2026/07/wordpress-7-ai), [AI Experiments plugin](https://make.wordpress.org/ai/2025/07/17/ai-experiments-plugin/), [Telex (Kinsta)](https://kinsta.com/blog/wordpress-blocks-telex/)
- Puck AI: [Puck blog](https://puckeditor.com/blog/puck-ai)
- Patterns across AI builders: [TeleportHQ best practices](https://help.teleporthq.io/en/article/best-practices-for-using-the-ai-website-builder-1c822dl/), [UXMagic on design tokens](https://uxmagic.ai/blog/ai-follow-design-tokens-honest-answer), [why AI websites look generic](https://www.inspoai.io/blog/why-ai-websites-look-generic)
- Page-builder performance: [WP Rocket](https://wp-rocket.me/blog/divi-vs-elementor-performance-speed), [AccelerateWP](https://accelerawp.com/divi-vs-elementor-performance-comparison/)

Most product descriptions above come from vendors' own pages and trade press, and are claims rather than tested facts.
