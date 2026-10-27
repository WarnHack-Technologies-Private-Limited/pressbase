# Media

How uploads, image sizes and file serving work. The code lives in `apps/core/src/media/`, with the REST controller in `routes/media.ts` and file serving in `routes/uploads.ts`.

## The model

An upload is a **post** row, as in WordPress:

| Column | Value |
|---|---|
| `type` | `attachment` |
| `status` | `inherit` (attachments have no status of their own) |
| `mime_type` | the checked type, e.g. `image/jpeg` |
| `guid` | the file's public URL when it was uploaded |
| `parent_id` | the post it's attached to, or `NULL` |
| `title`, `excerpt`, `content` | title, caption and description |

Post meta uses WordPress's keys, so imports and plugins line up:

| Key | Value |
|---|---|
| `_wp_attached_file` | Storage key of the "full" file, e.g. `2026/10/photo.jpg` (or `photo-scaled.jpg`). |
| `_wp_attachment_metadata` | `{ width, height, file, filesize, sizes: { name: { file, width, height, "mime-type", filesize } }, image_meta, original_image? }`. Files get `{ filesize }` only. |
| `_wp_attachment_image_alt` | Alternative text. |
| `_thumbnail_id` | On posts and pages: the featured image's attachment ID. |

`sizes` entries use WordPress's stored key `mime-type`; the REST API renames it to `mime_type`, as WordPress does.

## Storage

Files go through a `MediaStorage` adapter (`media/storage.ts`):

```ts
interface MediaStorage {
  put(key, data, { contentType }): Promise<void>;
  delete(key): Promise<void>;
  stat(key): Promise<{ size, modified } | undefined>;
  read(key, range?): Promise<ReadableStream | undefined>;
  list(folder): Promise<string[]>;   // for unique file names
  url(key, siteUrl): string;
}
```

`LocalStorage` writes to `<PRESSBASE_DATA_DIR>/uploads`, through a temporary file and a rename, so readers never see half a file. With `uploads_use_yearmonth_folders` on (the default), keys get a `YYYY/MM/` folder in the site's time zone; files attached to a post (other than a page) use that post's month, as `media_handle_upload()` does.

An S3-compatible adapter can replace it with `setMediaStorage(kernel, adapter)`: keys, metadata and URLs don't change shape. `url()` would return the bucket or CDN URL instead of `/wp-content/uploads/…`.

## Uploading

`POST /wp/v2/media` (see [REST API](rest-api.md#media)) runs `uploadAttachment()`:

1. **Permission.** `upload_files`, checked before the body is read; `edit_post` on the parent when `post` is given.
2. **Size.** `PRESSBASE_MAX_UPLOAD_MB` (default 64). The request body is cut off at the limit; the file is checked again after parsing. → `413 rest_upload_file_too_big`.
3. **Name.** `sanitize_file_name()`: accents removed, special characters dropped, spaces to dashes, extension lowercased, and intermediate extensions neutralised (`shell.php.jpg` → `shell.php_.jpg`).
4. **Type.** The extension must be on the allowed list, and the **first bytes must match it** (`media/mime.ts`). A PNG named `.jpg` is renamed `.png`, as `wp_check_filetype_and_ext()` does; anything else that doesn't match is refused. → `400 rest_upload_invalid_type`.
5. **Unique name.** `wp_unique_filename()`: `photo.jpg`, `photo-1.jpg`, `photo-2.jpg`… A name is also taken when an existing image's sub-sizes would clash (`photo-300x200.jpg`), and names that look like sub-sizes always get a number. Choosing the name and writing the file happen one upload at a time.
6. **Row and meta.** The attachment's slug is unique across all post types. Title defaults to the original file name without its extension.
7. **Image sizes** (below), then `_wp_attachment_metadata`.

### Allowed types

Modelled on `get_allowed_mime_types()` and filterable with `upload_mimes`:

| Kind | Extensions |
|---|---|
| Images | jpg, jpeg, jpe, png, gif, webp, avif |
| Documents | pdf, doc, docx, xls, xlsx, ppt, pptx, odt, ods, odp, rtf, txt, csv |
| Audio | mp3, m4a, ogg, oga, wav |
| Video | mp4, m4v, mov, qt, webm |

**Never allowed:** SVG (it can carry scripts), HTML, JavaScript, executables and archives. Text files must have no binary bytes and must not start like HTML or SVG.

## Image sizes

`createImageSubsizes()` is `wp_create_image_subsizes()` with [sharp](https://sharp.pixelplumbing.com/):

- **Registered sizes** (`registeredImageSizes()`): `thumbnail`, `medium`, `medium_large`, `large` from Settings → Media (`thumbnail_size_w/h`, `thumbnail_crop`, `medium_size_w/h`, `medium_large_size_w/h`, `large_size_w/h`), plus WordPress's `1536x1536` and `2048x2048`. Filter: `intermediate_image_sizes_advanced`.
- **Dimensions** follow `image_resize_dimensions()`: never upscaled; a 0 means "no limit" on that side; cropped sizes are centred; a size within a pixel of the original is skipped. Sizes with the same dimensions share one file.
- **Names:** `photo-300x200.jpg`, next to the original.
- **Big images:** wider or taller than 2560 px (filter `big_image_size_threshold`; `0` turns it off) are scaled to fit 2560 and saved as `photo-scaled.jpg`. That becomes `_wp_attached_file`; the original stays on disk and is named in `original_image`.
- **Orientation:** a photo with an EXIF rotation is turned upright and saved as `photo-rotated.jpg` (when it isn't also scaled). Width and height are always the upright ones; `image_meta.orientation` becomes 1.
- **Formats** stay as uploaded (JPEG stays JPEG, WebP stays WebP). JPEG quality 82, WebP 86, as WordPress.
- **Metadata** (EXIF, GPS, XMP) is stripped from every generated file. The original keeps its metadata.
- Sub-sizes are made from the original, decoded once.

If processing fails after the file is stored, the attachment is kept at full size and `missing_image_sizes` lists what's missing.

## Serving files

`GET /wp-content/uploads/*` is served by core, outside `/wp-json`, at WordPress's URLs. The admin proxies it like `/wp-json` (see `apps/admin/next.config.ts`).

- `Content-Type` comes from the extension's allowed type. Files with other extensions are 404 even if present.
- `X-Content-Type-Options: nosniff`, and `Content-Security-Policy: default-src 'none'; …; sandbox` on everything except PDFs (Chrome's PDF viewer won't run in a sandbox).
- `Cache-Control: public, max-age=31536000`, a weak `ETag` and `Last-Modified`; `If-None-Match` / `If-Modified-Since` give `304`.
- Single byte ranges (`Range: bytes=…`) give `206`, so audio and video can seek. `HEAD` is supported.

## Security

- **Path traversal.** Request paths are split, decoded one segment at a time and rejected if any segment is empty, `.` or `..`, hidden (starts with a dot), or contains `/`, `\`, NUL or control characters after decoding. The resolved path must sit inside the uploads folder, and so must its real path after symlinks. Every rejection is a plain 404.
- **Content sniffing.** Uploads are checked by content, not just name, and served with `nosniff` and a sandboxing CSP, so a file can't become a script or a page.
- **Names.** File names are sanitised, so they're safe in URLs, shells and every file system.
- **Size.** Bodies over the limit are cut off before they're buffered.
- **Permissions.** `upload_files` to upload. Editing and deleting use `edit_post` / `delete_post` on the attachment: authors manage their own files, editors and administrators everyone's.
- **Deletion.** `DELETE ?force=true` removes the row, its meta, every file (original, scaled or rotated, sizes) and any `_thumbnail_id` pointing at it. Files another attachment also references are kept.

## Featured images

Posts and pages accept `featured_media` (an attachment ID, or 0 to remove it), stored as `_thumbnail_id`. The ID must be an image attachment, else `400 rest_invalid_featured_media`. WordPress checks this only on update; Pressbase checks it on create too, before anything is written.

## Hooks

| Hook | Type | Arguments | When |
|---|---|---|---|
| `upload_mimes` | filter | `mimes, user` | building the allowed list |
| `sanitize_file_name` | filter | `name, raw` | after sanitising an upload's name |
| `add_attachment` | action | `id` | after the row is inserted |
| `big_image_size_threshold` | filter | `2560, [w, h], key, id` | before scaling |
| `intermediate_image_sizes_advanced` | filter | `sizes, metadata, id` | before making sub-sizes |
| `wp_generate_attachment_metadata` | filter | `metadata, id, 'create'` | before metadata is saved |
| `edit_attachment` | action | `id` | after an update |
| `delete_attachment` | action | `id, post` | before deletion |
| `deleted_post` | action | `id, post` | after deletion |
| `rest_prepare_attachment` | filter | `item, post, context` | each REST item |

## Not yet

- No Trash for media (WordPress's `MEDIA_TRASH` is off by default too).
- PDF previews, audio and video metadata (length, codec, ID3) and EXIF/IPTC fields other than orientation aren't read yet.
- Search matches title, caption and description, not the file name.
- Image editing (crop, rotate, flip) and `/media/{id}/post-process` aren't implemented.
- Only the local storage adapter exists.
