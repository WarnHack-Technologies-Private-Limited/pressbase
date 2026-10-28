'use client';

import { AlertTriangle, Check, CheckCircle2, History, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from 'react';
import { ApiError, api } from '@/lib/api';
import {
  applyVariation,
  COLOR_ROLES,
  type ColorRole,
  CSS_LENGTH,
  configsEqual,
  contrastRatio,
  type FontFamily,
  fontFaceCss,
  fontFamilies,
  fontSizes,
  type GlobalStylesConfig,
  type GlobalStylesRevision,
  hasNoKind,
  isVariationApplied,
  lengthToPx,
  type PaletteColor,
  palette,
  presetRef,
  presetSlug,
  type RestGlobalStyles,
  ROLE_PATHS,
  removeKind,
  resolveColor,
  resolveFontFamily,
  type StyleVariation,
  setFont,
  setPaletteColor,
  setPath,
  setRoleColor,
  settingValue,
  styleValue,
  variationKind,
} from '@/lib/global-styles';
import { useCurrentUser } from '../shell/current-user';
import { Button } from '../ui/button';
import { Notice } from '../ui/surface';
import { useToast } from '../ui/toast';
import { StylePreview } from './style-preview';
import styles from './styles-editor.module.css';

type Tab = 'styles' | 'colors' | 'typography' | 'layout' | 'history';
const TABS: { id: Tab; label: string }[] = [
  { id: 'styles', label: 'Styles' },
  { id: 'colors', label: 'Colours' },
  { id: 'typography', label: 'Type' },
  { id: 'layout', label: 'Layout' },
  { id: 'history', label: 'History' },
];

const pick = (config: GlobalStylesConfig): GlobalStylesConfig => ({
  settings: config.settings ?? {},
  styles: config.styles ?? {},
});

export interface StylesEditorProps {
  themeName: string;
  stylesheet: string;
  home: string;
  user: RestGlobalStyles;
  base: GlobalStylesConfig;
  variations: StyleVariation[];
}

/**
 * Appearance → Styles: the essentials of WordPress's site editor Styles
 * panel — style variations, colours, typography and layout — with a live
 * preview of the public site, Save, Reset and revisions.
 */
export function StylesEditor({
  themeName,
  stylesheet,
  home,
  user,
  base,
  variations,
}: StylesEditorProps) {
  const toast = useToast();
  const [saved, setSaved] = useState<GlobalStylesConfig>(() => pick(user));
  const [draft, setDraft] = useState<GlobalStylesConfig>(() => pick(user));
  const [tab, setTab] = useState<Tab>('styles');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [revisionsVersion, setRevisionsVersion] = useState(0);
  const dirty = !configsEqual(draft, saved);
  const tabsId = useId();

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const groups = useMemo(() => {
    const full: StyleVariation[] = [];
    const color: StyleVariation[] = [];
    const typography: StyleVariation[] = [];
    for (const v of variations) {
      const kind = variationKind(v);
      (kind === 'full' ? full : kind === 'color' ? color : typography).push(v);
    }
    return { full, color, typography };
  }, [variations]);

  // Fonts used by the cards: the theme's and every variation's, from the theme folder.
  const themeUrl = `/wp-content/themes/${encodeURIComponent(stylesheet)}`;
  const faces = useMemo(() => {
    const families = [base, ...variations].flatMap((config) => fontFamilies(config, {}));
    return fontFaceCss(families, themeUrl);
  }, [base, variations, themeUrl]);

  async function save() {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await api<RestGlobalStyles>(`/wp/v2/global-styles/${user.id}`, {
        method: 'POST',
        body: pick(draft),
      });
      const next = pick(result);
      setSaved(next);
      setDraft(next);
      setRevisionsVersion((n) => n + 1);
      toast('Styles saved. Your site has its new look.', {
        action: {
          label: 'View site',
          onClick: () => window.open(home || '/', '_blank', 'noopener'),
        },
      });
    } catch (error) {
      setProblem(
        error instanceof ApiError ? error.message : 'Your styles couldn’t be saved. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = TABS.findIndex((t) => t.id === tab);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    setTab(target.id);
    document.getElementById(`${tabsId}-${target.id}`)?.focus();
  };

  return (
    <div className={styles.screen}>
      <style>{faces}</style>
      <div className={styles.panel}>
        <div className={styles.saveRow}>
          <p className={styles.saveState} aria-live="polite">
            {dirty ? (
              <>
                <span className={styles.dot} aria-hidden="true" />
                Unsaved changes
              </>
            ) : (
              <>
                <CheckCircle2 size={15} aria-hidden="true" />
                Saved
              </>
            )}
          </p>
          <div className={styles.saveActions}>
            {dirty && (
              <Button variant="ghost" size="sm" onClick={() => setDraft(saved)} disabled={busy}>
                Discard
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={save} loading={busy} disabled={!dirty}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
        {problem && <Notice tone="danger" title={problem} />}

        <div className={styles.tabs} role="tablist" aria-label="Style settings">
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`${tabsId}-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`${tabsId}-${t.id}-panel`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={onTabKey}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div
          // A new panel starts at the top, not where the last one was scrolled to.
          key={tab}
          className={styles.tabPanel}
          role="tabpanel"
          id={`${tabsId}-${tab}-panel`}
          aria-labelledby={`${tabsId}-${tab}`}
        >
          {tab === 'styles' && (
            <StylesTab
              themeName={themeName}
              base={base}
              draft={draft}
              setDraft={setDraft}
              variations={groups.full}
            />
          )}
          {tab === 'colors' && (
            <ColorsTab base={base} draft={draft} setDraft={setDraft} palettes={groups.color} />
          )}
          {tab === 'typography' && (
            <TypographyTab
              base={base}
              draft={draft}
              setDraft={setDraft}
              pairings={groups.typography}
            />
          )}
          {tab === 'layout' && <LayoutTab base={base} draft={draft} setDraft={setDraft} />}
          {tab === 'history' && (
            <HistoryTab
              id={user.id}
              version={revisionsVersion}
              draft={draft}
              saved={saved}
              onRestore={(config) => {
                setDraft(pick(config));
                toast('Those styles are in the preview. Save to restore them.');
              }}
            />
          )}
        </div>

        <div className={styles.footer}>
          <Button
            variant="ghost"
            size="sm"
            icon={<RotateCcw size={15} aria-hidden="true" />}
            disabled={configsEqual(draft, {})}
            onClick={() => setDraft({ settings: {}, styles: {} })}
          >
            Reset to theme defaults
          </Button>
          <p className={styles.footerNote}>
            Logo and site icon live in{' '}
            <Link href="/admin/settings/general">Settings → General</Link>.
          </p>
        </div>
      </div>

      <StylePreview config={draft} home={home} />
    </div>
  );
}

type TabProps = {
  base: GlobalStylesConfig;
  draft: GlobalStylesConfig;
  setDraft: (next: GlobalStylesConfig) => void;
};

/* ---------------------------------------------------------------- Styles */

/** What a variation looks like: its colours and type, for the cards. */
function look(base: GlobalStylesConfig, config: GlobalStylesConfig) {
  const colors = palette(base, config);
  const families = fontFamilies(base, config);
  const color = (path: string[]) => resolveColor(styleValue(base, config, path), colors);
  const background = color(['color', 'background']) ?? '#ffffff';
  const text = color(['color', 'text']) ?? '#000000';
  const accent = color(ROLE_PATHS.accent) ?? text;
  const heading =
    resolveFontFamily(
      styleValue(base, config, ['elements', 'heading', 'typography', 'fontFamily']),
      families,
    ) ?? resolveFontFamily(styleValue(base, config, ['typography', 'fontFamily']), families);
  const body = resolveFontFamily(styleValue(base, config, ['typography', 'fontFamily']), families);
  const swatches = [accent, ...colors.map((c) => c.color)]
    .filter((c) => /^#/.test(c) && c.toLowerCase() !== background.toLowerCase())
    .filter((c, i, all) => all.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i)
    .slice(0, 3);
  return { background, text, accent, heading, body, swatches };
}

function VariationCard({
  title,
  base,
  config,
  selected,
  onSelect,
}: {
  title: string;
  base: GlobalStylesConfig;
  config: GlobalStylesConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  const l = look(base, config);
  return (
    <button type="button" className={styles.variation} aria-pressed={selected} onClick={onSelect}>
      <span
        className={styles.thumb}
        style={{ background: l.background, color: l.text }}
        aria-hidden="true"
      >
        <span className={styles.thumbType} style={{ fontFamily: l.heading }}>
          Aa
        </span>
        <span className={styles.thumbSwatches}>
          {l.swatches.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </span>
        {selected && (
          <span className={styles.check}>
            <Check size={12} strokeWidth={3} />
          </span>
        )}
      </span>
      <span className={styles.variationTitle}>{title}</span>
    </button>
  );
}

function StylesTab({
  themeName,
  base,
  draft,
  setDraft,
  variations,
}: TabProps & { themeName: string; variations: StyleVariation[] }) {
  const isDefault = configsEqual(draft, {});
  const anySelected = isDefault || variations.some((v) => isVariationApplied(draft, v));
  return (
    <Section
      title="Style variations"
      description={`Complete looks designed for ${themeName}: colours and type together. Your own changes go on top.`}
    >
      <div className={styles.variationGrid}>
        <VariationCard
          title="Default"
          base={base}
          config={{}}
          selected={isDefault}
          onSelect={() => setDraft({ settings: {}, styles: {} })}
        />
        {variations.map((v) => (
          <VariationCard
            key={v.title}
            title={v.title ?? 'Untitled'}
            base={base}
            config={v}
            selected={!isDefault && isVariationApplied(draft, v)}
            onSelect={() => setDraft(applyVariation(draft, v))}
          />
        ))}
      </div>
      {!anySelected && (
        <p className={styles.hint}>
          Your styles are customised. Choosing a variation replaces them; History keeps every saved
          version.
        </p>
      )}
    </Section>
  );
}

/* ---------------------------------------------------------------- Colours */

function ColorsTab({ base, draft, setDraft, palettes }: TabProps & { palettes: StyleVariation[] }) {
  const colors = palette(base, draft);
  const value = (role: ColorRole) => styleValue(base, draft, ROLE_PATHS[role]);
  const bg = resolveColor(value('background'), colors);
  const fg = resolveColor(value('text'), colors);
  const accent = resolveColor(value('accent'), colors);
  return (
    <>
      {palettes.length > 0 && (
        <Section
          title="Palettes"
          description="Colour schemes from the theme. Your type stays as it is."
        >
          <div className={styles.paletteGrid}>
            <PaletteCard
              title="Default"
              colors={palette(base, {})}
              selected={hasNoKind(draft, 'color')}
              onSelect={() => setDraft(removeKind(draft, 'color'))}
            />
            {palettes.map((p) => (
              <PaletteCard
                key={p.title}
                title={p.title ?? 'Untitled'}
                colors={palette(base, p)}
                selected={isVariationApplied(draft, p) && !hasNoKind(draft, 'color')}
                onSelect={() => setDraft(applyVariation(draft, p))}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Essentials" description="Pick from your palette, or choose any colour.">
        {COLOR_ROLES.map(({ role, label, hint }) => (
          <RolePicker
            key={role}
            role={role}
            label={label}
            hint={hint}
            colors={colors}
            value={value(role)}
            onChange={(next) => setDraft(setRoleColor(base, draft, role, next))}
          />
        ))}
        <ContrastCheck label="Text on background" a={fg} b={bg} />
        <ContrastCheck
          label="Accent on background"
          a={accent}
          b={bg}
          minimum={3}
          good="buttons stand out"
          bad="buttons and links are hard to see"
        />
      </Section>

      <Section title="Palette" description="Changing a colour updates it everywhere it’s used.">
        <ul className={styles.paletteList}>
          {colors.map((c) => (
            <PaletteRow
              key={c.slug}
              color={c}
              onChange={(next) => setDraft(setPaletteColor(draft, colors, c.slug, next))}
            />
          ))}
        </ul>
      </Section>
    </>
  );
}

function PaletteCard({
  title,
  colors,
  selected,
  onSelect,
}: {
  title: string;
  colors: PaletteColor[];
  selected: boolean;
  onSelect: () => void;
}) {
  const shown = colors.filter((c) => /^#/.test(c.color)).slice(0, 5);
  return (
    <button type="button" className={styles.paletteCard} aria-pressed={selected} onClick={onSelect}>
      <span className={styles.strip} aria-hidden="true">
        {shown.map((c) => (
          <span key={c.slug} style={{ background: c.color }} />
        ))}
      </span>
      <span className={styles.variationTitle}>
        {title}
        {selected && <Check size={14} aria-hidden="true" />}
      </span>
    </button>
  );
}

const isHex6 = (value: string | undefined) => /^#[0-9a-f]{6}$/i.test(value ?? '');

function RolePicker({
  role,
  label,
  hint,
  colors,
  value,
  onChange,
}: {
  role: ColorRole;
  label: string;
  hint: string;
  colors: PaletteColor[];
  value: string | undefined;
  onChange: (value: string) => void;
}) {
  const slug = presetSlug(value, 'color');
  const resolved = resolveColor(value, colors);
  const custom = !slug && value ? value : undefined;
  const name = slug
    ? (colors.find((c) => c.slug === slug)?.name ?? slug)
    : custom
      ? 'Custom'
      : 'Theme default';
  return (
    <fieldset className={styles.role}>
      <legend className={styles.roleLegend}>
        <span className={styles.roleSwatch} style={{ background: resolved }} aria-hidden="true" />
        <span>
          <span className={styles.roleLabel}>{label}</span>
          <span className={styles.roleValue}>
            {name}
            {resolved && /^#/.test(resolved) ? ` · ${resolved.toUpperCase()}` : ''}
          </span>
        </span>
      </legend>
      <p className="visually-hidden">{hint}</p>
      <div className={styles.swatches}>
        {colors.map((c) => (
          <label key={c.slug} className={styles.swatch} title={c.name}>
            <input
              type="radio"
              name={`role-${role}`}
              checked={slug === c.slug}
              onChange={() => onChange(presetRef('color', c.slug))}
            />
            <span style={{ background: c.color }} aria-hidden="true" />
            <span className="visually-hidden">{c.name}</span>
          </label>
        ))}
        <label className={`${styles.swatch} ${styles.customSwatch}`} title="Custom colour">
          <input
            type="color"
            value={isHex6(resolved) ? (resolved as string) : '#888888'}
            onChange={(e) => onChange(e.target.value)}
            aria-label={`Custom ${label.toLowerCase()} colour`}
          />
          <span
            aria-hidden="true"
            data-active={Boolean(custom)}
            style={custom ? { background: custom } : undefined}
          />
        </label>
      </div>
    </fieldset>
  );
}

function ContrastCheck({
  label,
  a,
  b,
  minimum = 4.5,
  good = 'easy to read',
  bad = 'hard to read',
}: {
  label: string;
  a: string | undefined;
  b: string | undefined;
  minimum?: number;
  good?: string;
  bad?: string;
}) {
  const ratio = contrastRatio(a, b);
  if (ratio === undefined) return null;
  const ok = ratio >= minimum;
  return (
    <p className={styles.contrast} data-ok={ok}>
      {ok ? (
        <CheckCircle2 size={15} aria-hidden="true" />
      ) : (
        <AlertTriangle size={15} aria-hidden="true" />
      )}
      <span>
        {label}: {ratio.toFixed(1)}:1 — {ok ? good : `${bad} (aim for ${minimum}:1 or more)`}
      </span>
    </p>
  );
}

function PaletteRow({
  color,
  onChange,
}: {
  color: PaletteColor;
  onChange: (value: string) => void;
}) {
  const editable = isHex6(color.color);
  return (
    <li className={styles.paletteRow}>
      <label className={styles.paletteSwatch}>
        <input
          type="color"
          value={editable ? color.color : '#888888'}
          disabled={!editable}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${color.name} colour`}
        />
        <span style={{ background: color.color }} aria-hidden="true" />
      </label>
      <span className={styles.paletteName}>{color.name}</span>
      <code className={styles.paletteValue} title={editable ? undefined : 'Computed by the theme'}>
        {editable ? color.color.toUpperCase() : 'Theme mix'}
      </code>
    </li>
  );
}

/* ------------------------------------------------------------ Typography */

function TypographyTab({
  base,
  draft,
  setDraft,
  pairings,
}: TabProps & { pairings: StyleVariation[] }) {
  const families = fontFamilies(base, draft);
  const sizes = fontSizes(base, draft);
  const bodyValue = styleValue(base, draft, ['typography', 'fontFamily']);
  const headingValue =
    styleValue(base, draft, ['elements', 'heading', 'typography', 'fontFamily']) ?? bodyValue;
  const sizeValue = styleValue(base, draft, ['typography', 'fontSize']);
  const sizeSlug = presetSlug(sizeValue, 'font-size');
  const customPx = sizeSlug ? undefined : lengthToPx(sizeValue);
  const presetsShown = sizes.filter((s) =>
    ['small', 'medium', 'large', 'x-large'].includes(s.slug),
  );
  const sliderPx = customPx ?? lengthToPx(sizes.find((s) => s.slug === sizeSlug)?.size) ?? 18;

  return (
    <>
      {pairings.length > 0 && (
        <Section
          title="Font pairings"
          description="Heading and body fonts chosen to work together."
        >
          <div className={styles.pairingGrid}>
            <PairingCard
              title="Theme fonts"
              base={base}
              config={{}}
              selected={hasNoKind(draft, 'typography')}
              onSelect={() => setDraft(removeKind(draft, 'typography'))}
            />
            {pairings.map((p) => (
              <PairingCard
                key={p.title}
                title={p.title ?? 'Untitled'}
                base={base}
                config={p}
                selected={!hasNoKind(draft, 'typography') && isVariationApplied(draft, p)}
                onSelect={() => setDraft(applyVariation(draft, p))}
              />
            ))}
          </div>
        </Section>
      )}

      <Section title="Fonts" description="From the fonts your theme (or pairing) includes.">
        <div className={styles.fields}>
          <FontSelect
            label="Headings"
            families={families}
            value={presetSlug(headingValue, 'font-family')}
            onChange={(slug) => setDraft(setFont(draft, 'heading', slug))}
          />
          <FontSelect
            label="Body"
            families={families}
            value={presetSlug(bodyValue, 'font-family')}
            onChange={(slug) => setDraft(setFont(draft, 'body', slug))}
          />
        </div>
      </Section>

      <Section
        title="Base size"
        description="The size of body text. Headings scale from the theme’s sizes."
      >
        <fieldset className={styles.segmented}>
          <legend className="visually-hidden">Base size preset</legend>
          {presetsShown.map((s) => (
            <button
              key={s.slug}
              type="button"
              aria-pressed={sizeSlug === s.slug}
              onClick={() =>
                setDraft(
                  setPath(
                    draft,
                    ['styles', 'typography', 'fontSize'],
                    presetRef('font-size', s.slug),
                  ),
                )
              }
            >
              {s.name ?? s.slug}
            </button>
          ))}
        </fieldset>
        <RangeField
          label="Custom size"
          min={14}
          max={26}
          step={1}
          unit="px"
          value={Math.round(sliderPx)}
          active={customPx !== undefined}
          onChange={(px) =>
            setDraft(setPath(draft, ['styles', 'typography', 'fontSize'], `${px}px`))
          }
        />
        <p className={styles.hint}>
          Sizes adapt to the screen: smaller on phones, up to this size on wide screens.
        </p>
      </Section>
    </>
  );
}

function FontSelect({
  label,
  families,
  value,
  onChange,
}: {
  label: string;
  families: FontFamily[];
  value: string | undefined;
  onChange: (slug: string) => void;
}) {
  const id = useId();
  const current = families.find((f) => f.slug === value);
  return (
    <div className={styles.fontField}>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
        {!current && <option value="">Theme default</option>}
        {families.map((f) => (
          <option key={f.slug} value={f.slug}>
            {f.name}
          </option>
        ))}
      </select>
      <span
        className={styles.fontSample}
        style={{ fontFamily: current?.fontFamily }}
        aria-hidden="true"
      >
        The quick brown fox
      </span>
    </div>
  );
}

function PairingCard({
  title,
  base,
  config,
  selected,
  onSelect,
}: {
  title: string;
  base: GlobalStylesConfig;
  config: GlobalStylesConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  const l = look(base, config);
  return (
    <button type="button" className={styles.pairing} aria-pressed={selected} onClick={onSelect}>
      <span className={styles.pairingSample} aria-hidden="true">
        <span style={{ fontFamily: l.heading }}>Aa</span>
        <span style={{ fontFamily: l.body }}>Aa</span>
      </span>
      <span className={styles.variationTitle}>
        {title}
        {selected && <Check size={14} aria-hidden="true" />}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------- Layout */

function LayoutTab({ base, draft, setDraft }: TabProps) {
  const field = (
    key: 'contentSize' | 'wideSize',
    label: string,
    hint: string,
    min: number,
    max: number,
  ) => {
    const user = settingValue({}, draft, ['layout', key]);
    const theme = settingValue(base, {}, ['layout', key]);
    const value = user ?? theme;
    const px = lengthToPx(value);
    return (
      <div className={styles.layoutField}>
        {px !== undefined ? (
          <RangeField
            label={label}
            min={min}
            max={max}
            step={10}
            unit="px"
            value={Math.round(px)}
            active
            onChange={(n) => setDraft(setPath(draft, ['settings', 'layout', key], `${n}px`))}
          />
        ) : (
          <LengthField
            label={label}
            value={value ?? ''}
            onChange={(v) => setDraft(setPath(draft, ['settings', 'layout', key], v))}
          />
        )}
        <p className={styles.hint}>
          {hint}
          {user !== undefined && theme && (
            <>
              {' '}
              <button
                type="button"
                className={styles.inlineButton}
                onClick={() => setDraft(setPath(draft, ['settings', 'layout', key], undefined))}
              >
                Use the theme’s {theme}
              </button>
            </>
          )}
        </p>
      </div>
    );
  };
  return (
    <Section title="Widths" description="How wide content can grow on large screens.">
      {field('contentSize', 'Content width', 'Paragraphs and most blocks.', 480, 1200)}
      {field('wideSize', 'Wide width', 'Blocks set to “Wide width”, like big images.', 720, 1920)}
    </Section>
  );
}

function RangeField({
  label,
  min,
  max,
  step,
  unit,
  value,
  active,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  value: number;
  active: boolean;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className={styles.range} data-active={active}>
      <div className={styles.rangeHead}>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>
          {value}
          {unit}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={Math.max(max, value)}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function LengthField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const invalid = text !== '' && !CSS_LENGTH.test(text);
  return (
    <div className={styles.fontField}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={text}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          if (CSS_LENGTH.test(e.target.value)) onChange(e.target.value);
        }}
        spellCheck={false}
      />
      {invalid && <span className={styles.error}>Use a size such as 720px or 45rem.</span>}
    </div>
  );
}

/* --------------------------------------------------------------- History */

function HistoryTab({
  id,
  version,
  draft,
  saved,
  onRestore,
}: {
  id: number;
  version: number;
  draft: GlobalStylesConfig;
  saved: GlobalStylesConfig;
  onRestore: (config: GlobalStylesConfig) => void;
}) {
  const me = useCurrentUser();
  const [revisions, setRevisions] = useState<GlobalStylesRevision[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [names, setNames] = useState<Record<number, string>>({});

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const list = await api<GlobalStylesRevision[]>(
        `/wp/v2/global-styles/${id}/revisions?per_page=50`,
      );
      setRevisions(list);
      const authors = [...new Set(list.map((r) => r.author).filter((a) => a && a !== me.id))];
      if (authors.length) {
        const users = await api<{ id: number; name: string }[]>(
          `/wp/v2/users?include=${authors.join(',')}&per_page=100`,
        ).catch(() => []);
        setNames(Object.fromEntries(users.map((u) => [u.id, u.name])));
      }
    } catch {
      setFailed(true);
    }
  }, [id, me.id]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const when = (date: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(`${date}`),
    );

  return (
    <Section
      title="Restore previous styles"
      description="Every save is kept. Pick one to see it in the preview, then save to bring it back."
    >
      {failed && (
        <Notice tone="danger" title="The history couldn’t be loaded.">
          <Button size="sm" onClick={load}>
            Try again
          </Button>
        </Notice>
      )}
      {!revisions && !failed && <p className={styles.hint}>Loading…</p>}
      {revisions?.length === 0 && <p className={styles.hint}>Nothing saved yet.</p>}
      {revisions && revisions.length > 0 && (
        <ol className={styles.revisions}>
          {revisions.map((r, i) => {
            const isSaved = configsEqual(r, saved) && i === 0;
            const inPreview = configsEqual(r, draft);
            const author =
              r.author === me.id
                ? 'you'
                : names[r.author] || (r.author ? 'another user' : 'Pressbase');
            const empty = configsEqual(r, {});
            return (
              <li key={r.id} className={styles.revision} data-current={inPreview}>
                <History size={16} aria-hidden="true" />
                <div className={styles.revisionText}>
                  <span className={styles.revisionDate}>
                    {when(r.date_gmt.endsWith('Z') ? r.date_gmt : `${r.date_gmt}Z`)}
                  </span>
                  <span className={styles.revisionMeta}>
                    {empty ? 'Theme defaults' : 'Custom styles'} · by {author}
                    {isSaved && ' · live now'}
                  </span>
                </div>
                {inPreview ? (
                  <span className={styles.revisionBadge}>{isSaved ? 'Current' : 'In preview'}</span>
                ) : (
                  <Button size="sm" onClick={() => onRestore(r)}>
                    Preview
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Section>
  );
}

/* --------------------------------------------------------------- shared */

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h2 id={id} className={styles.sectionTitle}>
        {title}
      </h2>
      {description && <p className={styles.sectionDescription}>{description}</p>}
      {children}
    </section>
  );
}
