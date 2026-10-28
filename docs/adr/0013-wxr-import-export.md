# 0013: WXR import as a streaming, source-agnostic pipeline run as a job

- **Status:** Accepted
- **Date:** 2026-10-28

## Context

v0.6 brings WordPress sites over. WXR (what Tools → Export writes) is the format every WordPress site can produce, and the WordPress Importer plugin is what people know. A later step migrates straight from a WordPress MySQL database, which carries more (password hashes, user meta). Export files of real sites run to hundreds of megabytes, and downloading their media can take a long time.

The WordPress Importer loads the whole file into memory (SimpleXML or xml_parser into arrays), imports in one PHP request and often times out on big sites.

## Decision

- **Stream the XML.** The reader uses [htmlparser2](https://github.com/fb55/htmlparser2) in XML mode and yields one record at a time; memory holds one item plus the old→new ID maps. htmlparser2 is small, fast, actively maintained, has no native code, and was already in the dependency tree (through sanitize-html), so it adds nothing to install. It's forgiving, like WordPress's fallback parsers, so one malformed post doesn't fail a whole import. We considered `sax` (also maintained, strict by default, a new dependency) and `saxes` (strict, rarely released); being strict buys nothing for a file we only read.
- **Separate the source from the writer.** Sources yield WordPress-shaped records (the importer's own field names and WordPress's stored values, PHP-serialized meta included). One writer imports any source: the MySQL migration will be another source, not another importer. Forward references (parents, featured images, menu targets) are resolved when the source ends, as `WP_Import`'s backfills do.
- **Run as a job.** The admin uploads the file (streamed to the data directory), maps authors, then a `pressbase/import` job imports it, writing progress to its own `jobs` row ([ADR 0010](0010-job-queue.md)). No new table: the job row holds progress and the report, a small JSON file next to the upload keeps the report after the row is pruned.
- **Idempotent by matching**, as `post_exists()` does (type, date, title; plus the guid), so a re-run or a retried job skips what's done instead of tracking a cursor.
- **Download media defensively.** Attachment URLs come from the file, so downloads refuse private and link-local addresses at connect time, with caps on size, redirects and time.
- **Convert classic menus** into `wp_navigation` posts on the way in, since block themes have no classic menus.

## Consequences

- Big files import with flat memory and survive the request ending, a closed tab and (with retries) a restart.
- Whole-file filters (`wp_import_posts`…) can't exist; per-item hooks do.
- The upload is a local file: the process that runs the job must share the data directory with the one that received it.
- Matching by date and title can't tell apart two posts of one type with the same title published in the same second; the guid narrows that further. WordPress has the same limit.
- The exporter writes PHP-serialized meta, so WordPress reads Pressbase's exports; Pressbase reads its own back (a round-trip test keeps it so).
