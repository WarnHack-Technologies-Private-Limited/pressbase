/**
 * Settings → SEO: the plugin's settings page (an admin page `entry`). It
 * edits Yoast's options (wpseo_titles, wpseo_social, wpseo) and the
 * plugin's own, registered with the Settings API, and saves them through
 * core's plugin-page endpoint, which validates and sanitises them.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  POST_TYPE_TITLE,
  SEPARATORS,
  type SettingsPayload,
  separatorText,
  TAXONOMY_TITLE,
} from '../shared';
import { replaceVars } from '../vars';
import { host } from './host';
import { __, useL10n } from './l10n';
import { muted, stack, VariableChips } from './ui';

const { components } = host;
const SAVE = '/pressbase/v1/plugin-pages/pressbase-seo/pressbase-seo';

type Draft = Pick<SettingsPayload, 'titles' | 'social' | 'wpseo'> & { own: SettingsPayload['own'] };

function Preview({ title, description }: { title: string; description: string }) {
  return (
    <div
      style={{
        padding: 'var(--space-3)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        fontFamily: 'arial, sans-serif',
      }}
    >
      <div style={{ fontSize: 18, color: '#1a0dab' }}>{title}</div>
      {description && <div style={{ fontSize: 14, color: '#4d5156' }}>{description}</div>}
    </div>
  );
}

function TemplateFields({
  draft,
  setTitles,
  prefix,
  label,
  fallbackTitle,
  sample,
  noindexKey,
}: {
  draft: Draft;
  setTitles: (patch: Record<string, unknown>) => void;
  prefix: string;
  label: string;
  fallbackTitle: string;
  sample: Record<string, string>;
  noindexKey?: string;
}) {
  const { TextField, Checkbox } = components;
  const titleKey = `title-${prefix}`;
  const descKey = `metadesc-${prefix}`;
  const title = String(draft.titles[titleKey] ?? fallbackTitle);
  const desc = String(draft.titles[descKey] ?? '');
  const vars = {
    ...sample,
    sitename: draft.titles.website_name || sample.sitename || '',
    sep: separatorText(draft.titles.separator),
    page: '',
  };
  return (
    <fieldset
      style={{ ...stack('var(--space-3)'), border: 0, padding: 0, margin: 0 }}
      data-seo-template={prefix}
    >
      <legend style={{ fontWeight: 600, marginBottom: 'var(--space-2)' }}>{label}</legend>
      <TextField
        label={__('Title template')}
        value={title}
        onChange={(e: { target: { value: string } }) => setTitles({ [titleKey]: e.target.value })}
      />
      <VariableChips
        vars={['title', 'sitename', 'sep', 'page', 'primary_category', 'term_title', 'sitedesc']}
        onInsert={(t) => setTitles({ [titleKey]: `${title} ${t}`.trim() })}
      />
      <TextField
        label={__('Description template')}
        value={desc}
        optional
        onChange={(e: { target: { value: string } }) => setTitles({ [descKey]: e.target.value })}
      />
      <Preview title={replaceVars(title, vars)} description={replaceVars(desc, vars)} />
      {noindexKey && (
        <Checkbox
          label={__('Keep these out of search results (noindex)')}
          checked={Boolean(draft.titles[noindexKey])}
          onChange={(e: { target: { checked: boolean } }) =>
            setTitles({ [noindexKey]: e.target.checked })
          }
        />
      )}
    </fieldset>
  );
}

function LogoPicker({
  url,
  onChange,
}: {
  url: string;
  onChange: (url: string, id: number) => void;
}) {
  const { Button } = components;
  const Picker = components.MediaPicker;
  const [open, setOpen] = useState(false);
  return (
    <div style={stack('var(--space-2)')}>
      <span style={{ fontWeight: 500 }}>{__('Logo')}</span>
      {url ? (
        <img src={url} alt="" style={{ maxWidth: 160, maxHeight: 80, objectFit: 'contain' }} />
      ) : (
        <p style={muted}>{__('No logo yet.')}</p>
      )}
      <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
        {Picker && (
          <Button size="sm" type="button" onClick={() => setOpen(true)}>
            {url ? __('Replace logo') : __('Choose logo')}
          </Button>
        )}
        {url && (
          <Button size="sm" variant="ghost" type="button" onClick={() => onChange('', 0)}>
            {__('Remove logo')}
          </Button>
        )}
      </div>
      {Picker && (
        <Picker
          open={open}
          allowedTypes={['image']}
          title={__('Choose a logo')}
          selectLabel={__('Use as logo')}
          onClose={() => setOpen(false)}
          onSelect={(m: { id: number; source_url: string }) => {
            onChange(m.source_url, m.id);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/** The first run: three questions, shown here once (never on the Dashboard). */
function FirstRun({
  draft,
  update,
  onDone,
}: {
  draft: Draft;
  update: (d: Partial<Draft>) => void;
  onDone: (indexable: boolean) => void;
}) {
  const { Card, TextField, Button } = components;
  const [indexable, setIndexable] = useState(true);
  const t = draft.titles;
  return (
    <Card
      title={__('Set up SEO')}
      description={__('Three questions, then you’re done. You can change any of it below.')}
    >
      <div style={stack('var(--space-4)')} data-seo-first-run="">
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600 }}>
            {__('1. Is this site for an organisation or a person?')}
          </legend>
          {(['company', 'person'] as const).map((value) => (
            <label
              key={value}
              style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}
            >
              <input
                type="radio"
                name="seo-first-run-rep"
                checked={t.company_or_person === value}
                onChange={() => update({ titles: { ...t, company_or_person: value } })}
              />
              {value === 'company' ? __('An organisation') : __('A person')}
            </label>
          ))}
        </fieldset>
        {t.company_or_person === 'company' ? (
          <>
            <TextField
              label={__('2. The organisation’s name')}
              value={t.company_name}
              onChange={(e: { target: { value: string } }) =>
                update({ titles: { ...t, company_name: e.target.value } })
              }
            />
            <LogoPicker
              url={t.company_logo}
              onChange={(url, id) =>
                update({ titles: { ...t, company_logo: url, company_logo_id: id } })
              }
            />
          </>
        ) : (
          <PersonFields draft={draft} update={update} />
        )}
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600 }}>
            {__('3. Is the site ready to be indexed by search engines?')}
          </legend>
          <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              type="radio"
              name="seo-first-run-index"
              checked={indexable}
              onChange={() => setIndexable(true)}
            />
            {__('Yes, show it in search results')}
          </label>
          <label style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            <input
              type="radio"
              name="seo-first-run-index"
              checked={!indexable}
              onChange={() => setIndexable(false)}
            />
            {__('Not yet: I’m still building it')}
          </label>
        </fieldset>
        <div>
          <Button variant="primary" type="button" onClick={() => onDone(indexable)}>
            {__('Finish setup')}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PersonFields({ draft, update }: { draft: Draft; update: (d: Partial<Draft>) => void }) {
  const { SelectField } = components;
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    host
      .api<{ id: number; name: string }[]>('/wp/v2/users?per_page=100&context=edit')
      .then(setUsers, () => setUsers([]));
  }, []);
  const t = draft.titles;
  return (
    <>
      <SelectField
        label={__('The person')}
        value={String(t.company_or_person_user_id || '')}
        onChange={(e: { target: { value: string } }) =>
          update({ titles: { ...t, company_or_person_user_id: Number(e.target.value) } })
        }
      >
        <option value="">{__('Choose a user')}</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name}
          </option>
        ))}
      </SelectField>
      <LogoPicker
        url={t.person_logo}
        onChange={(url, id) => update({ titles: { ...t, person_logo: url, person_logo_id: id } })}
      />
    </>
  );
}

export default function SeoSettings() {
  useL10n();
  const toast = host.useToast();
  const { Card, Spinner, Button, TextField, TextAreaField, Checkbox, Notice, SelectField } =
    components;
  const [loaded, setLoaded] = useState<SettingsPayload | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    host.api<SettingsPayload>('/pressbase-seo/v1/settings').then((s) => {
      setLoaded(s);
      setDraft({ titles: s.titles, social: s.social, wpseo: s.wpseo, own: s.own });
    });
  }, []);
  const dirty = useMemo(
    () =>
      loaded &&
      draft &&
      JSON.stringify({ ...loaded, site: undefined }) !==
        JSON.stringify({ ...loaded, ...draft, site: undefined }),
    [loaded, draft],
  );
  if (!loaded || !draft) {
    return (
      <p aria-busy="true">
        <Spinner /> {__('Loading…')}
      </p>
    );
  }
  const update = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setTitles = (patch: Record<string, unknown>) =>
    update({ titles: { ...draft.titles, ...patch } });
  const setSocial = (patch: Record<string, unknown>) =>
    update({ social: { ...draft.social, ...patch } });
  const setWpseo = (patch: Record<string, unknown>) =>
    update({ wpseo: { ...draft.wpseo, ...patch } });
  const setOwn = (patch: Record<string, unknown>) => update({ own: { ...draft.own, ...patch } });

  const save = async (next: Draft = draft) => {
    setSaving(true);
    setErrors({});
    const { indexnow_effective: _e, indexnow_key: _k, ...own } = next.own;
    try {
      await host.api(SAVE, {
        method: 'POST',
        body: {
          wpseo_titles: next.titles,
          wpseo_social: next.social,
          wpseo: next.wpseo,
          pressbase_seo_settings: own,
        },
      });
      const fresh = await host.api<SettingsPayload>('/pressbase-seo/v1/settings');
      setLoaded(fresh);
      setDraft({ titles: fresh.titles, social: fresh.social, wpseo: fresh.wpseo, own: fresh.own });
      toast(__('Settings saved.'));
    } catch (error) {
      const data = (error as { data?: { params?: Record<string, string> } }).data;
      setErrors(data?.params ?? {});
      toast(__('The settings couldn’t be saved. Check the fields marked below.'), {
        tone: 'danger',
      });
    } finally {
      setSaving(false);
    }
  };

  const finishSetup = async (indexable: boolean) => {
    if (!indexable && loaded.site.public)
      await host.api('/wp/v2/settings', { method: 'POST', body: { blog_public: false } });
    if (indexable && !loaded.site.public)
      await host.api('/wp/v2/settings', { method: 'POST', body: { blog_public: true } });
    await save({ ...draft, own: { ...draft.own, setup_done: true } });
  };

  const site = loaded.site;
  const sample = {
    title: __('Your post title'),
    sitename: site.name,
    sitedesc: site.description,
    primary_category: __('Category'),
    term_title: __('Category'),
    searchphrase: 'tea',
    name: __('Author name'),
    date: 'October 2026',
  };
  const t = draft.titles;
  const errorFor = (option: string) => errors[option];

  return (
    <div style={stack('var(--space-6)')} data-seo-settings="">
      {!draft.own.setup_done && <FirstRun draft={draft} update={update} onDone={finishSetup} />}
      {!site.public && (
        <Notice tone="warning" title={__('Search engines are asked not to index this site.')}>
          {__(
            'Pages carry noindex and sitemaps are off. Change it in Settings → Reading when the site is ready.',
          )}
        </Notice>
      )}
      {Object.values(errors).length > 0 && (
        <Notice tone="danger" title={__('Some settings weren’t saved.')}>
          {Object.values(errors).join(' ')}
        </Notice>
      )}

      <Card
        title={__('Site representation')}
        description={__(
          'Who is behind the site. Search engines use it in the schema graph and knowledge panels.',
        )}
      >
        <div style={stack('var(--space-4)')}>
          <SelectField
            label={__('The site represents')}
            value={t.company_or_person}
            onChange={(e: { target: { value: string } }) =>
              setTitles({ company_or_person: e.target.value })
            }
          >
            <option value="company">{__('An organisation')}</option>
            <option value="person">{__('A person')}</option>
          </SelectField>
          {t.company_or_person === 'company' ? (
            <>
              <TextField
                label={__('Organisation name')}
                value={t.company_name}
                error={errorFor('wpseo_titles')}
                onChange={(e: { target: { value: string } }) =>
                  setTitles({ company_name: e.target.value })
                }
              />
              <LogoPicker
                url={t.company_logo}
                onChange={(url, id) => setTitles({ company_logo: url, company_logo_id: id })}
              />
            </>
          ) : (
            <PersonFields draft={draft} update={update} />
          )}
          <TextField
            label={__('Website name')}
            value={t.website_name}
            optional
            placeholder={site.name}
            onChange={(e: { target: { value: string } }) =>
              setTitles({ website_name: e.target.value })
            }
          />
        </div>
      </Card>

      <Card
        title={__('Search appearance')}
        description={__(
          'Templates for titles and descriptions. A post’s own SEO title or description wins over these.',
        )}
      >
        <div style={stack('var(--space-5)')}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 'var(--space-2)' }}>
              {__('Title separator')}
            </legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {Object.entries(SEPARATORS).map(([key, symbol]) => (
                <label
                  key={key}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    padding: '4px 10px',
                    border: '1px solid var(--color-border)',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    background: t.separator === key ? 'var(--color-accent-soft)' : undefined,
                  }}
                >
                  <input
                    type="radio"
                    name="seo-separator"
                    value={key}
                    checked={t.separator === key}
                    onChange={() => setTitles({ separator: key })}
                  />
                  <span aria-hidden="true">{symbol}</span>
                  <span
                    style={{
                      position: 'absolute',
                      width: 1,
                      height: 1,
                      overflow: 'hidden',
                      clip: 'rect(0,0,0,0)',
                    }}
                  >
                    {key.replace('sc-', '')}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <TemplateFields
            draft={draft}
            setTitles={setTitles}
            prefix="home-wpseo"
            label={__('Home page')}
            fallbackTitle="%%sitename%% %%page%% %%sep%% %%sitedesc%%"
            sample={sample}
          />
          {site.postTypes
            .filter((pt) => pt.name !== 'attachment')
            .map((pt) => (
              <TemplateFields
                key={pt.name}
                draft={draft}
                setTitles={setTitles}
                prefix={pt.name}
                label={pt.label}
                fallbackTitle={POST_TYPE_TITLE}
                sample={sample}
                noindexKey={`noindex-${pt.name}`}
              />
            ))}
          {site.taxonomies.map((tax) => (
            <TemplateFields
              key={tax.name}
              draft={draft}
              setTitles={setTitles}
              prefix={`tax-${tax.name}`}
              label={tax.label}
              fallbackTitle={TAXONOMY_TITLE}
              sample={sample}
              noindexKey={`noindex-tax-${tax.name}`}
            />
          ))}
          <TemplateFields
            draft={draft}
            setTitles={setTitles}
            prefix="author-wpseo"
            label={__('Author archives')}
            fallbackTitle="%%name%%, Author at %%sitename%% %%page%%"
            sample={sample}
            noindexKey="noindex-author-wpseo"
          />
          <TemplateFields
            draft={draft}
            setTitles={setTitles}
            prefix="archive-wpseo"
            label={__('Date archives')}
            fallbackTitle="%%date%% %%page%% %%sep%% %%sitename%%"
            sample={sample}
            noindexKey="noindex-archive-wpseo"
          />
          <Checkbox
            label={__('Keep media attachment pages out of search results (noindex)')}
            checked={Boolean(t['noindex-attachment'])}
            onChange={(e: { target: { checked: boolean } }) =>
              setTitles({ 'noindex-attachment': e.target.checked })
            }
          />
        </div>
      </Card>

      <Card
        title={__('Social')}
        description={__('What shows when the site is shared and a post has no image of its own.')}
      >
        <div style={stack('var(--space-4)')}>
          <TextField
            label={__('Default share image URL')}
            type="url"
            optional
            value={draft.social.og_default_image}
            error={errorFor('wpseo_social')}
            onChange={(e: { target: { value: string } }) =>
              setSocial({ og_default_image: e.target.value, og_default_image_id: 0 })
            }
          />
          <TextField
            label={__('Facebook page')}
            type="url"
            optional
            value={draft.social.facebook_site}
            onChange={(e: { target: { value: string } }) =>
              setSocial({ facebook_site: e.target.value })
            }
          />
          <TextField
            label={__('X username')}
            optional
            value={draft.social.twitter_site}
            placeholder="@example"
            onChange={(e: { target: { value: string } }) =>
              setSocial({ twitter_site: e.target.value.replace(/^@/, '') })
            }
          />
          <TextAreaField
            label={__('Other profiles')}
            optional
            hint={__('One address per line: LinkedIn, Instagram, YouTube…')}
            rows={3}
            value={(draft.social.other_social_urls ?? []).join('\n')}
            onChange={(e: { target: { value: string } }) =>
              setSocial({ other_social_urls: e.target.value.split('\n') })
            }
          />
          <Checkbox
            label={__('Add Open Graph tags (Facebook, LinkedIn and others)')}
            checked={draft.social.opengraph !== false}
            onChange={(e: { target: { checked: boolean } }) =>
              setSocial({ opengraph: e.target.checked })
            }
          />
          <Checkbox
            label={__('Add X card tags')}
            checked={draft.social.twitter !== false}
            onChange={(e: { target: { checked: boolean } }) =>
              setSocial({ twitter: e.target.checked })
            }
          />
        </div>
      </Card>

      <Card
        title={__('Crawling')}
        description={__('What search engines and other crawlers are told about the site.')}
      >
        <div style={stack('var(--space-4)')}>
          <Checkbox
            label={__('XML sitemaps')}
            description={`${site.home}/wp-sitemap.xml`}
            checked={draft.wpseo.enable_xml_sitemap !== false}
            onChange={(e: { target: { checked: boolean } }) =>
              setWpseo({ enable_xml_sitemap: e.target.checked })
            }
          />
          <TextAreaField
            label={__('Additions to robots.txt')}
            optional
            rows={4}
            hint={__('Added after Pressbase’s own rules, for example rules for one crawler.')}
            value={draft.own.robots_txt}
            error={errorFor('pressbase_seo_settings')}
            onChange={(e: { target: { value: string } }) => setOwn({ robots_txt: e.target.value })}
            style={{ fontFamily: 'var(--font-mono)' }}
          />
          <Checkbox
            label={__('llms.txt')}
            description={__(
              'A Markdown summary of the site and its main pages for AI tools, at /llms.txt.',
            )}
            checked={draft.wpseo.enable_llms_txt === true}
            onChange={(e: { target: { checked: boolean } }) =>
              setWpseo({ enable_llms_txt: e.target.checked })
            }
          />
          <Checkbox
            label={__('IndexNow')}
            description={__(
              'Tells Bing, Yandex and other IndexNow engines when posts are published, changed or removed. On by default while search engines may index the site.',
            )}
            checked={draft.own.indexnow ?? draft.own.indexnow_effective}
            onChange={(e: { target: { checked: boolean } }) =>
              setOwn({ indexnow: e.target.checked })
            }
          />
          <Checkbox
            label={__('Redirect old addresses when a published post’s slug changes')}
            checked={draft.own.auto_redirects !== false}
            onChange={(e: { target: { checked: boolean } }) =>
              setOwn({ auto_redirects: e.target.checked })
            }
          />
        </div>
      </Card>

      <div
        style={{
          position: 'sticky',
          bottom: 0,
          display: 'flex',
          gap: 'var(--space-2)',
          justifyContent: 'flex-end',
          padding: 'var(--space-3) 0',
          background: 'var(--color-canvas)',
        }}
      >
        {dirty && <span style={{ ...muted, alignSelf: 'center' }}>{__('Unsaved changes')}</span>}
        {dirty && (
          <Button
            variant="ghost"
            type="button"
            onClick={() =>
              setDraft({
                titles: loaded.titles,
                social: loaded.social,
                wpseo: loaded.wpseo,
                own: loaded.own,
              })
            }
          >
            {__('Discard')}
          </Button>
        )}
        <Button
          variant="primary"
          type="button"
          loading={saving}
          disabled={!dirty || saving}
          onClick={() => save()}
        >
          {saving ? __('Saving…') : __('Save changes')}
        </Button>
      </div>
    </div>
  );
}
