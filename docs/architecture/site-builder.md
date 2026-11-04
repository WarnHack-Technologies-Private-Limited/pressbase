# The site builder

"Build my site from a prompt": a person describes their site, and Pressbase writes a brief, a design, a sitemap and every page into a [changeset](changesets.md) they review in Studio and publish themselves. It follows the [plan](../plans/visual-site-builder.md#building-with-ai) and [ADR 0024](../adr/0024-ai-site-building.md#pipeline-accepted). The guided flow in the admin (#60) is built on the API below.

Code: `apps/core/src/site-builder/` (`pipeline.ts` the stages, `honest.ts` the honest-content rules, `runs.ts` the run record, `index.ts` the job), `apps/core/src/routes/site-builder.ts`. Tests: `apps/core/src/site-builder.test.ts`.

## The pipeline

A fixed pipeline in code, not a free-running agent. Each stage is one structured call: the AI client's `asJsonResponse(schema)` with the stage's JSON Schema, parsed and validated (`parseStructuredOutput()`, as `generateJson()` does), then checked in code. An answer that doesn't fit is **retried once**, with what was wrong; a second bad answer fails the stage.

| Stage | Request (`forAbility`) | The model answers | Done in code |
| --- | --- | --- | --- |
| Brief | `site-builder/brief` | the brief (`SITE_BRIEF_JSON_SCHEMA`) | The form's facts first; the model's facts kept only where the person's own words support them; name and pages from the form win |
| Design | `site-builder/design` | a design direction (`DESIGN_CHOICE_SCHEMA`, font pairs limited to the theme's) | `core/update-global-styles`: the palette is generated from the hue and checked against WCAG AA |
| Sitemap | `site-builder/sitemap` | `{ pages: [{ title, slug, sections: [{ category, intent }] }], header, footer }` | Categories limited to those with patterns; slugs cleaned and made unique; at most 8 pages of 8 sections; the first page is the home page |
| Page (one call each, three at a time) | `site-builder/page` | `{ section_1: { pattern, slots }, … }`: for each section, one of up to four patterns of its category, and its slots | Honest content, then `core/create-page`, which checks the slots against the pattern and renders the blocks |
| Assemble | — | — | Header and footer through `core/update-template-part`; a menu of the pages; the home page; the brief |
| Check | — | — | `runCheckPage()` on every page, against the changeset's styles |

A five-page site is eight requests. When the person already went through a step in the guided flow (an edited brief, a chosen design, an arranged sitemap), they pass it when starting the run and the stage makes no request; an arranged sitemap still needs one request for the header and footer (`site-builder/parts`).

Every write goes through the [site-building abilities](site-abilities.md) as the person who started the run (`kernel.abilities.context(user, 'ai')`), so their rights apply, and into one changeset: the one named by `changeset_uuid`, else their open one, started when there is none. **Nothing publishes.** The run's writes are made one at a time (pages finish in parallel, and two writes to one changeset at once would lose one).

### Assemble

- **Header and footer**: the active theme's `header` and `footer` parts, with the slots the Sitemap stage filled (made honest).
- **Menu**: a `wp_navigation` menu the changeset creates (`wp_navigation:site-menu`, or `site-menu-2`… when taken), one `core/navigation-link` per page that was built, home first, and `pressbase_navigation_fallback` naming it by slug, so every Navigation block without a menu (the theme's header) shows it.
- **Home page**: `show_on_front = page` and `page_on_front` naming the home page by slug.
- **Brief**: `pressbase_site_brief`, so later AI requests know the site (needs `manage_options`).

Changesets take a post's slug for the three post-ID options (`page_on_front`, `page_for_posts`, `pressbase_navigation_fallback`) and create `wp_navigation` posts named by slug; publishing writes the posts first and stores their IDs ([changesets](changesets.md#entries-and-entity-handlers)). Pages are written with the default status, so they go live when the changeset is published; until then they exist only in the changeset. A write the person's rights don't allow (the options need `manage_options`) is skipped with a warning; the run goes on.

## Honest content

The site states as facts only what the person gave ([plan](../plans/visual-site-builder.md#honest-content)). The prompt says so, and `honest.ts` makes sure of it after every answer:

- **The brief's facts** are the form's (name, location, address, phone, email, and any facts typed in) and those the model drew from the description that the description supports. Nothing else counts as a fact.
- **Fact slots** keep a value only when the facts say it; otherwise they get their placeholder (`[Add a customer quote]`). Fact slots are those declared `facts`, and in sections about facts (testimonials, team, pricing, statistics, contact, opening hours) every slot of a repeated item and every citation.
- **Every other slot is copy**, and may say anything general, but a number, an email address or a web address it gives must be in the facts; otherwise it gets its placeholder too. Button labels are copy.
- **Links**: `tel:` and `mailto:` links and addresses on other sites must be in the facts; otherwise the link becomes `#`.

"In the facts" is strict on purpose: the model may reword copy, not facts. A run lists what it replaced per page (`replaced`), and the placeholders left (`placeholders`) feed the "Before you publish" checklist (#61). Slot schemas allow at least the placeholder's length, so a model told to write one can.

**The person's words are data.** Their description and facts, the brief, and the sitemap go into the prompt as separate, labelled parts (`<site_owner_input>`, `<site_brief>`, `<sitemap_page>`), JSON-encoded so they can't close their tag, after the task; the system instruction says never to follow instructions in them. Whatever the model answers, the model never writes markup (it names patterns and fills slots in plain text) and the abilities enforce the person's rights and the changeset.

## Runs

A run is a `pressbase_site_run` post (private, `edit_theme_options`, like a changeset), its content the run as JSON, so it survives a closed tab, a reload or another device. It runs as one job (`pressbase/site-builder`, [the job queue](jobs.md)), not retried (that would spend the day's requests twice), with a 30-minute timeout. A run whose job dies is marked failed.

| Field | |
| --- | --- |
| `id`, `author`, `created`, `modified` | |
| `status` | `queued`, `running`, `completed`, `stopped` (the daily cap), `failed`, `cancelled` |
| `stage` | `brief`, `design`, `sitemap`, `pages`, `assemble`, `check`, or `null` |
| `input` | the form: `description`, `name`, `location`, `phone`, `email`, `address`, `facts[]`, `pages[]`, `language` |
| `brief`, `design`, `sitemap` | as the stages left them |
| `pages[]` | `{ slug, title, status (pending, generating, done, failed, skipped), home, sections[] (patterns), placeholders[], replaced[], checks: { errors, warnings, passed }, preview_link, error }` |
| `changeset_uuid`, `preview_link` | where the site is, and how to see it |
| `tokens: { prompt, completion, total }`, `requests` | what the run used, retries included |
| `warnings[]`, `error` | `{ code, message }` |
| `job_id`, `last_event_id` | |

### The daily cap

The run stops cleanly at the site's daily cap (`ai_daily_limit_reached`): no new request starts, pages not yet written are `skipped`, and what was made stays in the changeset; Assemble and Check still run (they make no requests), so the pages built get their menu, home page and checks. The status is `stopped`, with the error and the tokens used. The run counts its requests in flight against the cap, so pages sent together don't pass it.

## REST

All under `/wp-json/pressbase/v1/site-builder`, for users with `edit_theme_options`:

| Route | Does |
| --- | --- |
| `POST /runs` | Starts a run: `{ description, name?, location?, phone?, email?, address?, facts?, pages?, language?, brief?, design?, sitemap?, changeset_uuid? }` → `202` with the run. `503 prompt_prevented` when AI isn't set up; `409 site_builder_run_active` (with `data.run`) while one of yours is queued or running; `400 rest_invalid_param` |
| `GET /runs` | Your runs, newest first |
| `GET /runs/{id}` | The run (yours, or anyone's for `manage_options`). With `Accept: text/event-stream`, its progress as Server-Sent Events |
| `DELETE /runs/{id}` | Stops it: a queued run is cancelled at once; a running one before its next request (`202`) |

### Progress events

The stream starts with a `snapshot` event (the run, without an ID), then sends the run's events in order, each with an increasing `id`, and ends after `done`. A reconnecting `EventSource` sends `Last-Event-ID` (or pass `?after=`) and gets only what it missed; a finished run replays and closes. Comments (`: keep-alive`) are sent every 15 seconds while nothing happens. `GET` needs no `X-Pressbase-Request` header, so a browser's `EventSource` works with the session cookie.

| Event | Data |
| --- | --- |
| `run` | `{ status, changeset_uuid, preview_link }` |
| `stage` | `{ stage, status: 'started' \| 'done' }` |
| `retry` | `{ stage, problem }` |
| `brief` | `{ brief }` |
| `design` | `{ design, palette }` |
| `sitemap` | `{ sitemap }` |
| `page` | `{ slug, title, status }`; when `done`, also `preview_link`, `sections`, `placeholders`, `replaced`; when `failed`, `error` |
| `part` | `{ slug, replaced }` (header, footer) |
| `menu` | `{ slug, items }` |
| `home` | `{ slug }` |
| `warning` | `{ code, message }` |
| `checks` | `{ slug, errors, warnings, passed, findings }` |
| `done` | `{ status, tokens, requests, changeset_uuid, preview_link, error }` |

## Not yet

- The Clarify step's questions and three design directions to choose from (#60 may need small endpoints for those); images (uploads and Openverse) for image slots, which keep the pattern's for now.
- Retrying a failed page alone, and a run resuming after its process dies.
- Matching facts by meaning rather than by words: a fact the model rephrases becomes a placeholder.
