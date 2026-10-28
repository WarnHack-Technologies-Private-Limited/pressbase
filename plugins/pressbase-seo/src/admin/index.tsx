/**
 * Pressbase SEO in the admin (plugin.json "admin.module", loaded on every
 * screen): the editor's SEO sidebar and pre-publish item, the posts-list
 * column and filter, and the SEO fields on category and tag screens.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  analyze,
  type CheckResult,
  images,
  SERP,
  summarize,
  textWidth,
  truncateToWidth,
} from '../analysis';
import { META, POST_TYPE_TITLE, separatorText } from '../shared';
import { COMMON_VARS, replaceVars } from '../vars';
import { type EditorPost, host } from './host';
import { __, useL10n } from './l10n';
import { muted, Section, Segmented, SuggestButton, stack, VariableChips, WidthMeter } from './ui';

const { editor, components } = host;

interface EditorConfig {
  home: string;
  siteName: string;
  siteDescription: string;
  separator: string;
  titles: Record<string, unknown>;
  social: { default_image: string; twitter_card_type: string };
}

/* ------------------------------------------------------------ shared data */

let configLoad: Promise<EditorConfig> | null = null;
function useConfig(): EditorConfig | null {
  const [config, setConfig] = useState<EditorConfig | null>(null);
  useEffect(() => {
    configLoad ??= host.api<EditorConfig>('/pressbase-seo/v1/editor');
    configLoad.then(setConfig, () => {
      configLoad = null;
    });
  }, []);
  return config;
}

let aiLoad: Promise<boolean> | null = null;
function useAiAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    aiLoad ??= host
      .api<{ available: boolean }>('/pressbase-seo/v1/ai')
      .then((r) => r.available)
      .catch(() => false);
    aiLoad.then(setAvailable);
  }, []);
  return available;
}

const metaValue = (post: EditorPost | null | undefined, key: string): string => {
  const v = post?.meta?.[key];
  return v === undefined || v === null ? '' : String(v);
};

function useMeta(key: string): [string, (value: string) => void] {
  const value = editor.usePost((post) => metaValue(post, key)) ?? '';
  return [value, (next) => editor.editPost({ meta: { [key]: next } })];
}

/** The post as the preview and the checks see it. */
function usePreview(config: EditorConfig | null) {
  const title = editor.usePost((p) => p.title) ?? '';
  const excerpt = editor.usePost((p) => p.excerpt) ?? '';
  const type = editor.usePost((p) => p.type) ?? 'post';
  const permalink = editor.usePost((p) => p.permalink || p.link) ?? '';
  const categories = editor.usePost((p) => p.terms?.categories) ?? [];
  const [seoTitle] = useMeta(META.title);
  const [metadesc] = useMeta(META.metadesc);
  const [focuskw] = useMeta(META.focuskw);
  const [primary] = useMeta(META.primaryCategory);
  const sep = separatorText(config?.separator);
  const primaryName =
    categories.find((c) => String(c.id) === primary)?.name ?? categories[0]?.name ?? '';
  const values = {
    title,
    sitename: config?.siteName ?? '',
    sitedesc: config?.siteDescription ?? '',
    sep,
    excerpt,
    excerpt_only: excerpt,
    primary_category: primaryName,
    category: primaryName,
    focuskw,
    page: '',
  };
  const titleTemplate = seoTitle || String(config?.titles[`title-${type}`] ?? POST_TYPE_TITLE);
  const descTemplate = metadesc || String(config?.titles[`metadesc-${type}`] ?? '');
  return {
    values,
    type,
    permalink,
    titleTemplate,
    renderedTitle: replaceVars(titleTemplate, values) || config?.siteName || '',
    renderedDescription: replaceVars(descTemplate, values),
  };
}

/* ---------------------------------------------------------- search preview */

function SearchPreview({ config }: { config: EditorConfig | null }) {
  const { TextField, TextAreaField } = components;
  const [mode, setMode] = useState<'desktop' | 'mobile'>('desktop');
  const [seoTitle, setSeoTitle] = useMeta(META.title);
  const [metadesc, setMetadesc] = useMeta(META.metadesc);
  const preview = usePreview(config);
  const ai = useAiAvailable();
  const titleMax = mode === 'desktop' ? SERP.titleMaxPx : SERP.titleMaxMobilePx;
  const descMax = mode === 'desktop' ? SERP.descMaxDesktopPx : SERP.descMaxMobilePx;
  const shownTitle = truncateToWidth(preview.renderedTitle, SERP.titleFontPx, titleMax).text;
  const shownDesc = preview.renderedDescription
    ? truncateToWidth(preview.renderedDescription, SERP.descFontPx, descMax).text
    : '';
  let crumbs = preview.permalink;
  try {
    const url = new URL(preview.permalink);
    crumbs = [url.host, ...url.pathname.split('/').filter(Boolean)].join(' › ');
  } catch {
    // An unsaved post has no address yet.
  }
  const postInput = () => {
    const post = editor.getPost();
    return {
      postId: post?.id ?? undefined,
      title: post?.title ?? '',
      excerpt: post?.excerpt ?? '',
      content: (post?.content ?? '').slice(0, 20000),
      keyphrase: metaValue(post, META.focuskw),
    };
  };

  return (
    <Section title={__('Search preview')}>
      <Segmented
        label={__('Preview as')}
        value={mode}
        onChange={setMode}
        options={[
          { value: 'desktop', label: __('Desktop') },
          { value: 'mobile', label: __('Mobile') },
        ]}
      />
      <div
        data-seo-preview={mode}
        style={{
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--color-border)',
          background: '#fff',
          color: '#202124',
          fontFamily: 'arial, sans-serif',
          maxWidth: mode === 'mobile' ? 360 : '100%',
        }}
      >
        <div style={{ fontSize: 12, color: '#4d5156', overflowWrap: 'anywhere' }}>{crumbs}</div>
        <div
          data-seo-preview-title=""
          style={{
            fontSize: mode === 'mobile' ? 18 : 20,
            lineHeight: 1.3,
            color: '#1a0dab',
            margin: '4px 0',
          }}
        >
          {shownTitle}
        </div>
        <div
          data-seo-preview-description=""
          style={{ fontSize: 14, lineHeight: 1.58, color: '#4d5156' }}
        >
          {shownDesc || (
            <em>{__('No description: search engines will choose text from the page.')}</em>
          )}
        </div>
      </div>
      <TextField
        label={__('SEO title')}
        name="pressbase-seo-title"
        value={seoTitle}
        placeholder={preview.titleTemplate}
        optional
        hint={__('Leave empty to use the title template from Settings → SEO.')}
        onChange={(e: { target: { value: string } }) => setSeoTitle(e.target.value)}
      />
      <VariableChips
        vars={COMMON_VARS}
        onInsert={(t) => setSeoTitle(`${seoTitle || preview.titleTemplate} ${t}`.trim())}
      />
      <WidthMeter
        width={textWidth(preview.renderedTitle, SERP.titleFontPx)}
        max={titleMax}
        label={__('wide')}
      />
      {ai && (
        <SuggestButton
          ability="suggest-meta"
          label={__('a title')}
          input={() => ({ field: 'title', ...postInput() })}
          onPick={setSeoTitle}
        />
      )}
      <TextAreaField
        label={__('Meta description')}
        name="pressbase-seo-description"
        value={metadesc}
        rows={3}
        optional
        onChange={(e: { target: { value: string } }) => setMetadesc(e.target.value)}
      />
      <VariableChips vars={COMMON_VARS} onInsert={(t) => setMetadesc(`${metadesc} ${t}`.trim())} />
      <WidthMeter
        width={textWidth(preview.renderedDescription, SERP.descFontPx)}
        max={descMax}
        label={__('wide')}
      />
      {ai && (
        <SuggestButton
          ability="suggest-meta"
          label={__('a description')}
          input={() => ({ field: 'description', ...postInput() })}
          onPick={setMetadesc}
        />
      )}
    </Section>
  );
}

/* ---------------------------------------------------------- social preview */

function useImage(id: number) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!id) {
      setUrl('');
      return;
    }
    host
      .api<{ source_url: string }>(`/wp/v2/media/${id}`)
      .then((m) => setUrl(m.source_url))
      .catch(() => setUrl(''));
  }, [id]);
  return url;
}

function firstContentImage(content: string): string {
  return /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(content)?.[1] ?? '';
}

function SocialPreview({ config }: { config: EditorConfig | null }) {
  const { TextField, TextAreaField, Button } = components;
  const Picker = components.MediaPicker;
  const preview = usePreview(config);
  const ai = useAiAvailable();
  const [ogTitle, setOgTitle] = useMeta(META.ogTitle);
  const [ogDesc, setOgDesc] = useMeta(META.ogDescription);
  const [ogImage, setOgImage] = useMeta(META.ogImage);
  const [ogImageId, setOgImageId] = useMeta(META.ogImageId);
  const featured = editor.usePost((p) => p.featured_media) ?? 0;
  const content = editor.usePost((p) => p.content) ?? '';
  const excerpt = editor.usePost((p) => p.excerpt) ?? '';
  const [picking, setPicking] = useState(false);
  const [network, setNetwork] = useState<'facebook' | 'x'>('facebook');
  const featuredUrl = useImage(featured);
  const inContent = firstContentImage(content);
  const image = ogImage
    ? { url: ogImage, note: __('Using the image you chose.') }
    : featuredUrl
      ? { url: featuredUrl, note: __('Using the featured image.') }
      : inContent
        ? { url: inContent, note: __('Using the first image in the post.') }
        : config?.social.default_image
          ? { url: config.social.default_image, note: __('Using the site’s default share image.') }
          : { url: '', note: __('No image: add a featured image or choose one here.') };
  const title = replaceVars(ogTitle, preview.values) || preview.renderedTitle;
  const description = replaceVars(ogDesc, preview.values) || preview.renderedDescription || excerpt;
  let host_ = '';
  try {
    host_ = new URL(preview.permalink || config?.home || '').host;
  } catch {
    host_ = '';
  }
  const postInput = () => {
    const post = editor.getPost();
    return {
      postId: post?.id ?? undefined,
      title: post?.title ?? '',
      excerpt: post?.excerpt ?? '',
      content: (post?.content ?? '').slice(0, 20000),
    };
  };

  return (
    <Section title={__('Social preview')}>
      <Segmented
        label={__('Preview for')}
        value={network}
        onChange={setNetwork}
        options={[
          { value: 'facebook', label: 'Facebook' },
          { value: 'x', label: 'X' },
        ]}
      />
      <div
        data-seo-social={network}
        style={{
          border: '1px solid var(--color-border)',
          borderRadius: network === 'x' ? 16 : 'var(--radius-sm)',
          overflow: 'hidden',
          background: '#fff',
          color: '#1c1e21',
          fontFamily: 'Helvetica, Arial, sans-serif',
        }}
      >
        <div
          style={{
            aspectRatio: '1.91 / 1',
            background: image.url
              ? `center / cover no-repeat url("${image.url.replace(/"/g, '%22')}")`
              : '#e4e6eb',
          }}
          role="img"
          aria-label={image.url ? __('Share image') : __('No share image')}
        />
        <div
          style={{ padding: '8px 12px', background: network === 'facebook' ? '#f0f2f5' : '#fff' }}
        >
          <div
            style={{
              fontSize: 12,
              color: '#606770',
              textTransform: network === 'facebook' ? 'uppercase' : 'none',
            }}
          >
            {host_}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.25 }}>{title}</div>
          {network === 'facebook' && (
            <div style={{ fontSize: 14, color: '#606770', lineHeight: 1.3 }}>
              {description.slice(0, 120)}
            </div>
          )}
        </div>
      </div>
      <p style={muted} data-seo-image-note="">
        {image.note}
      </p>
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {Picker && (
          <Button size="sm" type="button" onClick={() => setPicking(true)}>
            {ogImage ? __('Replace image') : __('Choose image')}
          </Button>
        )}
        {ogImage && (
          <Button
            size="sm"
            variant="ghost"
            type="button"
            onClick={() => {
              setOgImage('');
              setOgImageId('');
            }}
          >
            {__('Remove image')}
          </Button>
        )}
      </div>
      {Picker && (
        <Picker
          open={picking}
          allowedTypes={['image']}
          title={__('Choose a share image')}
          selectLabel={__('Use for sharing')}
          selectedId={Number(ogImageId) || undefined}
          onClose={() => setPicking(false)}
          onSelect={(media: { id: number; source_url: string }) => {
            editor.editPost({
              meta: { [META.ogImage]: media.source_url, [META.ogImageId]: String(media.id) },
            });
            setPicking(false);
          }}
        />
      )}
      <TextField
        label={__('Social title')}
        value={ogTitle}
        placeholder={preview.renderedTitle}
        optional
        onChange={(e: { target: { value: string } }) => setOgTitle(e.target.value)}
      />
      {ai && (
        <SuggestButton
          ability="suggest-meta"
          label={__('a social title')}
          input={() => ({ field: 'social-title', ...postInput() })}
          onPick={setOgTitle}
        />
      )}
      <TextAreaField
        label={__('Social description')}
        value={ogDesc}
        rows={2}
        optional
        placeholder={preview.renderedDescription || excerpt}
        onChange={(e: { target: { value: string } }) => setOgDesc(e.target.value)}
      />
      {ai && (
        <SuggestButton
          ability="suggest-meta"
          label={__('a social description')}
          input={() => ({ field: 'social-description', ...postInput() })}
          onPick={setOgDesc}
        />
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ checks */

let dupTimer: ReturnType<typeof setTimeout> | undefined;
function useDuplicates(title: string, id: number | null) {
  const [dups, setDups] = useState<{ id: number; title: string }[] | undefined>(undefined);
  useEffect(() => {
    clearTimeout(dupTimer);
    if (!title.trim()) {
      setDups([]);
      return;
    }
    dupTimer = setTimeout(() => {
      host
        .api<{ items: { id: number; title: string }[] }>(
          `/pressbase-seo/v1/duplicates?title=${encodeURIComponent(title)}&exclude=${id ?? 0}`,
        )
        .then(
          (r) => setDups(r.items),
          () => setDups(undefined),
        );
    }, 600);
  }, [title, id]);
  return dups;
}

const FIELD_FOR: Record<CheckResult['target'], string> = {
  title: 'pressbase-seo-title',
  description: 'pressbase-seo-description',
  keyphrase: 'pressbase-seo-keyphrase',
  slug: '',
  content: '',
};

function useChecks(config: EditorConfig | null) {
  const preview = usePreview(config);
  const content = editor.usePost((p) => p.content) ?? '';
  const slug = editor.usePost((p) => p.slug) ?? '';
  const id = editor.usePost((p) => p.id) ?? null;
  const [keyphrase] = useMeta(META.focuskw);
  const duplicates = useDuplicates(preview.values.title, id);
  return useMemo(
    () =>
      analyze(
        {
          title: preview.values.title,
          seoTitle: preview.renderedTitle,
          content,
          slug,
          description: preview.renderedDescription,
          keyphrase,
          homeUrl: config?.home ?? '',
          duplicateTitles: duplicates,
        },
        __,
      ),
    [
      preview.values.title,
      preview.renderedTitle,
      preview.renderedDescription,
      content,
      slug,
      keyphrase,
      config?.home,
      duplicates,
    ],
  );
}

function CheckItem({ check }: { check: CheckResult }) {
  const field = FIELD_FOR[check.target];
  const status =
    check.status === 'good'
      ? __('Good')
      : check.status === 'improve'
        ? __('Could be better')
        : __('Not applicable');
  return (
    <li data-seo-check={check.id} data-status={check.status} style={{ ...stack('var(--space-1)') }}>
      <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'baseline' }}>
        <span
          aria-hidden="true"
          style={{
            width: 8,
            height: 8,
            flex: 'none',
            borderRadius: '50%',
            background:
              check.status === 'good'
                ? 'var(--color-success)'
                : check.status === 'improve'
                  ? 'var(--color-warning)'
                  : 'var(--color-border-strong)',
          }}
        />
        <strong style={{ fontSize: 'var(--text-sm)' }}>{check.label}</strong>
        <span style={{ ...muted, fontSize: 'var(--text-xs)' }}>{status}</span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--text-sm)' }}>{check.message}</p>
      <details>
        <summary style={{ ...muted, cursor: 'pointer' }}>{__('Why it matters')}</summary>
        <p style={muted}>{check.why}</p>
      </details>
      {check.status === 'improve' && field && (
        <button
          type="button"
          onClick={() => document.querySelector<HTMLElement>(`[name="${field}"]`)?.focus()}
          style={{
            alignSelf: 'start',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
            background: 'none',
            border: 0,
            padding: 0,
            color: 'var(--color-accent-text)',
            textDecoration: 'underline',
            cursor: 'pointer',
          }}
        >
          {__('Go to the field')}
        </button>
      )}
    </li>
  );
}

function Checks({ config }: { config: EditorConfig | null }) {
  const { TextField } = components;
  const [keyphrase, setKeyphrase] = useMeta(META.focuskw);
  const checks = useChecks(config);
  const ai = useAiAvailable();
  const relevant = checks.filter((c) => c.status !== 'na');
  const notApplicable = checks.filter((c) => c.status === 'na');
  return (
    <Section title={__('Focus keyphrase and checks')}>
      <TextField
        label={__('Focus keyphrase')}
        name="pressbase-seo-keyphrase"
        value={keyphrase}
        optional
        hint={__('The words you’d like this post to be found for.')}
        onChange={(e: { target: { value: string } }) => setKeyphrase(e.target.value)}
      />
      <p style={{ margin: 0, fontWeight: 600 }} aria-live="polite" data-seo-summary="">
        {summarize(checks, __)}
      </p>
      <ul style={{ ...stack('var(--space-3)'), listStyle: 'none', margin: 0, padding: 0 }}>
        {relevant.map((check) => (
          <CheckItem key={check.id} check={check} />
        ))}
      </ul>
      {ai && checks.some((c) => c.id === 'image-alt' && c.status === 'improve') && (
        <AltTextHelper />
      )}
      {notApplicable.length > 0 && (
        <p style={muted}>
          {`${__('Not checked yet:')} ${notApplicable.map((c) => c.label).join(', ')}.`}
        </p>
      )}
      <p style={muted}>
        {__(
          'These checks are in English and can’t judge what matters most: whether the post answers what people are searching for.',
        )}
      </p>
    </Section>
  );
}

/** AI alt text for images without any: suggestions to copy into the image block. */
function AltTextHelper() {
  const toast = host.useToast();
  const content = editor.usePost((p) => p.content) ?? '';
  const missing = images(content)
    .filter((img) => !img.alt?.trim())
    .slice(0, 5);
  if (!missing.length) return null;
  return (
    <div style={stack('var(--space-3)')} data-seo-alt-helper="">
      <p style={muted}>
        {__(
          'Alt text lives on each image block. The model sees the file name and the post, not the image, so check a suggestion against the picture.',
        )}
      </p>
      {missing.map((img) => (
        <div key={img.src} style={stack('var(--space-1)')}>
          <code style={{ ...muted, overflowWrap: 'anywhere' }}>{img.src.split('/').pop()}</code>
          <SuggestButton
            ability="suggest-alt-text"
            label={__('alt text')}
            input={() => {
              const post = editor.getPost();
              return {
                filename: img.src,
                postTitle: post?.title ?? '',
                postId: post?.id ?? undefined,
              };
            }}
            onPick={(text) => {
              navigator.clipboard?.writeText(text).then(
                () =>
                  toast(__('Alt text copied. Paste it into the image block’s Alternative text.')),
                () => toast(text),
              );
            }}
          />
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- advanced */

function Advanced() {
  const { TextField, SelectField, Checkbox } = components;
  const [canonical, setCanonical] = useMeta(META.canonical);
  const [noindex, setNoindex] = useMeta(META.noindex);
  const [nofollow, setNofollow] = useMeta(META.nofollow);
  const [bctitle, setBctitle] = useMeta(META.bctitle);
  const [primary, setPrimary] = useMeta(META.primaryCategory);
  const [cornerstone, setCornerstone] = useMeta(META.cornerstone);
  const categories = editor.usePost((p) => p.terms?.categories) ?? [];
  const type = editor.usePost((p) => p.type) ?? 'post';
  return (
    <Section title={__('Advanced')}>
      <SelectField
        label={__('Show in search results')}
        value={noindex || '0'}
        onChange={(e: { target: { value: string } }) => setNoindex(e.target.value)}
      >
        <option value="0">{__('Use the default for this content type')}</option>
        <option value="2">{__('Yes')}</option>
        <option value="1">{__('No (noindex)')}</option>
      </SelectField>
      <Checkbox
        label={__('Ask search engines not to follow links on this page (nofollow)')}
        checked={nofollow === '1'}
        onChange={(e: { target: { checked: boolean } }) =>
          setNofollow(e.target.checked ? '1' : '0')
        }
      />
      <TextField
        label={__('Canonical URL')}
        type="url"
        value={canonical}
        optional
        hint={__('Only when this content’s main copy lives at another address.')}
        onChange={(e: { target: { value: string } }) => setCanonical(e.target.value)}
      />
      <TextField
        label={__('Breadcrumb title')}
        value={bctitle}
        optional
        onChange={(e: { target: { value: string } }) => setBctitle(e.target.value)}
      />
      {type === 'post' && categories.length > 1 && (
        <SelectField
          label={__('Primary category')}
          value={primary || String(categories[0]?.id ?? '')}
          hint={__('Used in breadcrumbs and the %%primary_category%% variable.')}
          onChange={(e: { target: { value: string } }) => setPrimary(e.target.value)}
        >
          {categories.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </SelectField>
      )}
      <Checkbox
        label={__('Cornerstone content')}
        description={__(
          'One of the site’s most important pages, worth linking to from related posts.',
        )}
        checked={cornerstone === '1'}
        onChange={(e: { target: { checked: boolean } }) =>
          setCornerstone(e.target.checked ? '1' : '0')
        }
      />
    </Section>
  );
}

/* ---------------------------------------------------------------- the tab */

function SeoPanel() {
  useL10n();
  const config = useConfig();
  return (
    <div style={stack('var(--space-5)')} data-seo-panel="">
      <SearchPreview config={config} />
      <Checks config={config} />
      <SocialPreview config={config} />
      <Advanced />
    </div>
  );
}

function PrePublish() {
  useL10n();
  const config = useConfig();
  const checks = useChecks(config);
  const improve = checks.filter((c) => c.status === 'improve');
  return (
    <div style={stack('var(--space-2)')} data-seo-prepublish="">
      <p style={{ margin: 0 }}>{summarize(checks, __)}</p>
      {improve.length > 0 && (
        <ul style={{ margin: 0, paddingInlineStart: 'var(--space-5)' }}>
          {improve.slice(0, 4).map((c) => (
            <li key={c.id} style={{ fontSize: 'var(--text-sm)' }}>
              {c.label}
            </li>
          ))}
        </ul>
      )}
      <p style={muted}>{__('You can publish now and improve these later in the SEO tab.')}</p>
    </div>
  );
}

function SeoIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
    </svg>
  );
}

/* ------------------------------------------------------------- posts list */

function SeoColumn({ post }: { post: { meta?: Record<string, unknown> } }) {
  useL10n();
  const { Badge } = components;
  const noindex = String(post.meta?.[META.noindex] ?? '') === '1';
  const description = String(post.meta?.[META.metadesc] ?? '').trim();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-1)' }} data-seo-column="">
      {noindex && <Badge tone="warning">{__('noindex')}</Badge>}
      <span style={muted}>{description ? __('Description set') : __('No description')}</span>
    </div>
  );
}

/* ------------------------------------------------------------- term fields */

function TermFields({
  meta,
  editMeta,
}: {
  meta: Record<string, unknown>;
  editMeta: (edits: Record<string, unknown>) => void;
}) {
  useL10n();
  const { TextField, TextAreaField, SelectField } = components;
  const value = (key: string) =>
    meta?.[key] === undefined || meta?.[key] === null ? '' : String(meta[key]);
  return (
    <div style={stack('var(--space-4)')} data-seo-term-fields="">
      <h3 style={{ margin: 0, fontSize: 'var(--text-md)' }}>{__('SEO')}</h3>
      <TextField
        label={__('SEO title')}
        value={value('wpseo_title')}
        optional
        placeholder="%%term_title%% Archives %%page%% %%sep%% %%sitename%%"
        onChange={(e: { target: { value: string } }) => editMeta({ wpseo_title: e.target.value })}
      />
      <TextAreaField
        label={__('Meta description')}
        value={value('wpseo_desc')}
        rows={2}
        optional
        onChange={(e: { target: { value: string } }) => editMeta({ wpseo_desc: e.target.value })}
      />
      <SelectField
        label={__('Show in search results')}
        value={value('wpseo_noindex') || 'default'}
        onChange={(e: { target: { value: string } }) => editMeta({ wpseo_noindex: e.target.value })}
      >
        <option value="default">{__('Use the default for this taxonomy')}</option>
        <option value="index">{__('Yes')}</option>
        <option value="noindex">{__('No (noindex)')}</option>
      </SelectField>
      <TextField
        label={__('Canonical URL')}
        type="url"
        value={value('wpseo_canonical')}
        optional
        onChange={(e: { target: { value: string } }) =>
          editMeta({ wpseo_canonical: e.target.value })
        }
      />
      <TextField
        label={__('Breadcrumb title')}
        value={value('wpseo_bctitle')}
        optional
        onChange={(e: { target: { value: string } }) => editMeta({ wpseo_bctitle: e.target.value })}
      />
    </div>
  );
}

/* -------------------------------------------------------------- register */

const {
  PluginSidebar,
  PluginSidebarMoreMenuItem,
  PluginPrePublishPanel,
  PostsListColumn,
  PostsListFilter,
  TermEditFields,
} = host;

host.registerPlugin('pressbase-seo', {
  render: () => (
    <>
      <PluginSidebar name="seo" title={__('SEO')} icon={SeoIcon}>
        <SeoPanel />
      </PluginSidebar>
      <PluginSidebarMoreMenuItem target="seo" icon={SeoIcon}>
        {__('SEO')}
      </PluginSidebarMoreMenuItem>
      <PluginPrePublishPanel title={__('SEO')} initialOpen={false}>
        <PrePublish />
      </PluginPrePublishPanel>
      <PostsListColumn title={__('SEO')} postTypes={['post', 'page']}>
        {({ post }: { post: { meta?: Record<string, unknown> } }) => <SeoColumn post={post} />}
      </PostsListColumn>
      <PostsListFilter
        id="pressbase-seo-description"
        label={__('All descriptions')}
        options={[{ value: 'missing', label: __('Missing description') }]}
        query={(value: string) => ({ 'pressbase-seo-description': value })}
        postTypes={['post', 'page']}
      />
      <TermEditFields taxonomies={['category', 'post_tag']}>
        {(props: {
          meta: Record<string, unknown>;
          editMeta: (edits: Record<string, unknown>) => void;
        }) => <TermFields {...props} />}
      </TermEditFields>
    </>
  ),
});
