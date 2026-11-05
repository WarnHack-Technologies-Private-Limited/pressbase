'use client';

import { BlockControls, store as blockEditorStore } from '@wordpress/block-editor';
import { type Block as BlockInstance, serialize } from '@wordpress/blocks';
import { ToolbarButton, ToolbarGroup } from '@wordpress/components';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useRegistry } from '@wordpress/data';
import { addFilter } from '@wordpress/hooks';
import { FilePlus2, LayoutPanelTop, Sparkles } from 'lucide-react';
import {
  type ComponentType,
  createContext,
  type FormEvent,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { TextAreaField } from '../ui/field';
import { problemText } from './ai-panel-model';
import styles from './ask-ai.module.css';
import {
  LANGUAGES,
  type RewriteAction,
  type SlotText,
  sectionTexts,
  selectionText,
  slotsUpdate,
  spliceSelection,
  TONES,
  type Tone,
} from './ask-ai-model';
import { useStudioCommands } from './command-palette';
import { contentRootId, sectionLabel, sectionOf } from './sections-panel';
import type { PageRef, StudioPage } from './site-model';
import { loadPatterns } from './use-ai-edits';
import type { StudioAi } from './use-studio-ai';

/**
 * *Ask AI* in Studio (#63): on a section (its toolbar's ✦), on selected
 * text (✦ in the block toolbar of a text block), a prompt to a section
 * ("pricing with three tiers") and a prompt to a page. Quick requests use
 * the quick-edits model (`POST /pressbase/v1/studio/ai/rewrite`); sections
 * and pages come back from core as checked operations (`/section`,
 * `/page`). Every answer goes on the page through the AI edits applier
 * (#57): highlighted, one undo step, with Keep and Undo. Nothing is
 * published. See docs/architecture/ai-edits.md#ask-ai.
 */

/** A section on the canvas, as Ask AI reads it when it opens. */
export interface AskSection {
  /** Its place among the page's sections. */
  index: number;
  /** Its block markup (`serialize()`), to read its slots. */
  markup: string;
  /** The pattern it came from (`metadata.patternName`), for its declared slots. */
  pattern: string;
  label: string;
}

export type AskTarget =
  | { kind: 'section'; section: AskSection }
  | {
      kind: 'text';
      section: AskSection;
      /** The text block's path from the section's root list (the section is `[0]`). */
      path: number[];
      /** The block's plain text, as the editor holds it. */
      text: string;
      /** The selected part, when some is selected. */
      range: { start: number; end: number } | null;
    }
  | { kind: 'add-section'; index: number | null; after?: string }
  | { kind: 'new-page' };

/** Opens Ask AI; null outside Studio (the post editor shows no Ask AI). */
const AskAiContext = createContext<((target: AskTarget) => void) | null>(null);
export const AskAiProvider = AskAiContext.Provider;
export const useAskAiOpener = () => useContext(AskAiContext);

interface Select {
  getBlocks: () => BlockInstance[];
  getBlock: (id: string) => BlockInstance | null;
  getBlockOrder: (root?: string) => string[];
  getBlockParents: (id: string) => string[];
  getBlockIndex: (id: string) => number;
  getBlockName: (id: string) => string | null;
  getBlockAttributes: (id: string) => Record<string, unknown> | null;
  getSelectionStart: () => { clientId?: string; attributeKey?: string; offset?: number };
  getSelectionEnd: () => { clientId?: string; attributeKey?: string; offset?: number };
}

/** A section as Ask AI reads it, from the canvas's store. */
export function readSection(select: Select, clientId: string): AskSection | null {
  const root = contentRootId(select);
  const block = select.getBlock(clientId);
  if (!root || !block) return null;
  const index = select.getBlockOrder(root).indexOf(clientId);
  if (index < 0) return null;
  const pattern = (block.attributes.metadata as { patternName?: unknown } | undefined)?.patternName;
  return {
    index,
    markup: serialize([block]),
    pattern: typeof pattern === 'string' ? pattern : '',
    label: sectionLabel(select as never, clientId),
  };
}

/* ------------------------------------------------- text blocks' toolbar */

/** Blocks whose text Ask AI changes, by the attribute holding it. */
const TEXT_ATTRIBUTES: Record<string, string> = {
  'core/paragraph': 'content',
  'core/heading': 'content',
  'core/list-item': 'content',
  'core/button': 'text',
  'core/details': 'summary',
};

/** Rich text's plain text: WordPress's RichTextData has it as `text`; HTML is stripped. */
function plainText(value: unknown): string {
  if (value && typeof value === 'object' && 'text' in value) {
    return String((value as { text: unknown }).text ?? '');
  }
  if (typeof value !== 'string') return '';
  const doc = new DOMParser().parseFromString(value.replace(/<br\s*\/?>/gi, '\n'), 'text/html');
  return doc.body.textContent ?? '';
}

function AskAiControl({ clientId, name }: { clientId: string; name: string }) {
  const { __ } = useI18n();
  const open = useAskAiOpener();
  const registry = useRegistry();
  if (!open) return null;
  const onClick = () => {
    const select = registry.select(blockEditorStore) as unknown as Select;
    const root = contentRootId(select);
    const section = root ? sectionOf(select, root, clientId) : null;
    const read = section ? readSection(select, section) : null;
    if (!section || !read) return;
    // Its path within the section: [0], then each block's index under its parent.
    const chain = [...select.getBlockParents(clientId), clientId];
    const from = chain.indexOf(section);
    const path = [0, ...chain.slice(from + 1).map((id) => select.getBlockIndex(id))];
    const attribute = TEXT_ATTRIBUTES[name] ?? 'content';
    const text = plainText(select.getBlockAttributes(clientId)?.[attribute]);
    const start = select.getSelectionStart();
    const end = select.getSelectionEnd();
    const range =
      start.clientId === clientId &&
      end.clientId === clientId &&
      typeof start.offset === 'number' &&
      typeof end.offset === 'number' &&
      start.offset !== end.offset
        ? { start: Math.min(start.offset, end.offset), end: Math.max(start.offset, end.offset) }
        : null;
    open({ kind: 'text', section: read, path, text, range });
  };
  return (
    <BlockControls group="other">
      <ToolbarGroup>
        <ToolbarButton
          icon={<Sparkles size={20} aria-hidden="true" />}
          label={__('Ask AI about this text', 'pressbase-admin')}
          data-studio-ask-ai-text
          onClick={onClick}
        />
      </ToolbarGroup>
    </BlockControls>
  );
}

/** Whether the block sits in the page's content (not the header, footer or template). */
function useInContent(clientId: string): boolean {
  const registry = useRegistry();
  const select = registry.select(blockEditorStore) as unknown as Select;
  const root = contentRootId(select);
  return Boolean(root && sectionOf(select, root, clientId));
}

function InContentControl(props: { clientId: string; name: string }) {
  return useInContent(props.clientId) ? <AskAiControl {...props} /> : null;
}

const withAskAi = createHigherOrderComponent(
  (BlockEdit: ComponentType<Record<string, unknown>>) =>
    function StudioAskAiEdit(props: Record<string, unknown>) {
      const open = useContext(AskAiContext);
      const name = String(props.name ?? '');
      const show = open && props.isSelected && name in TEXT_ATTRIBUTES;
      return (
        <>
          <BlockEdit {...props} />
          {show && <InContentControl clientId={String(props.clientId)} name={name} />}
        </>
      );
    },
  'withStudioAskAi',
);

let registered = false;
/** ✦ Ask AI in text blocks' toolbar, inside Studio only (it needs AskAiProvider). */
export function registerAskAiControls(): void {
  if (registered) return;
  registered = true;
  addFilter('editor.BlockEdit', 'pressbase/studio/ask-ai', withAskAi);
}

/* ------------------------------------------------------------- requests */

export interface AskAi {
  target: AskTarget | null;
  open(target: AskTarget): void;
  close(): void;
  busy: string | null;
  error: string | null;
  rewrite(action: RewriteAction, options?: { tone?: Tone; language?: string }): Promise<void>;
  addSection(prompt: string): Promise<void>;
  newPage(prompt: string): Promise<void>;
  /** Something else: the AI panel, with the section named. */
  askPanel(text: string): void;
  ai: StudioAi;
}

const errorText = (e: unknown) =>
  e instanceof ApiError || e instanceof Error ? e.message : String(e);

export function useAskAi({
  ai,
  page,
  pages,
  saveNow,
  onOpenPage,
  onOpenHome,
  onOpenPanel,
  onDone,
}: {
  ai: StudioAi;
  /** The page on the canvas. */
  page: { id: PageRef; slug: string } | null;
  /** The pages as the draft leaves them. */
  pages: readonly StudioPage[];
  saveNow: () => Promise<{ uuid: string } | null>;
  onOpenPage: (id: PageRef) => void;
  onOpenHome: () => void;
  onOpenPanel: () => void;
  /** Says what happened (a toast). */
  onDone: (message: string) => void;
}): AskAi {
  const { __, sprintf } = useI18n();
  const [target, setTarget] = useState<AskTarget | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A page Ask AI added and opened: if its changes are undone, it's gone.
  const [created, setCreated] = useState<string | null>(null);
  const latest = useRef({ page, saveNow });
  latest.current = { page, saveNow };

  useEffect(() => {
    if (created && !pages.some((p) => String(p.id) === created)) {
      setCreated(null);
      onOpenHome();
    }
  }, [created, pages, onOpenHome]);

  const open = useCallback(
    (next: AskTarget) => {
      setError(null);
      setTarget(next);
      ai.load();
    },
    [ai.load],
  );
  const close = useCallback(() => {
    if (busy) return;
    setTarget(null);
    setError(null);
  }, [busy]);

  /** Applies a set with Keep and Undo; false (and says why) if it can't be. */
  const apply = async (summary: string, operations: unknown[], onCanvas = true) => {
    const result = await ai.edits.apply(onCanvas ? ai.canvas.current : null, {
      summary,
      operations,
    });
    if (!result.ok) {
      setError(problemText(result.problem, __, sprintf));
      return false;
    }
    return true;
  };

  const run = async (what: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const rewrite: AskAi['rewrite'] = (action, options = {}) =>
    run(action, async () => {
      if (!target || (target.kind !== 'section' && target.kind !== 'text')) return;
      const { section } = target;
      const declarations = (await loadPatterns()).get(section.pattern)?.slots;
      let texts: SlotText[];
      let selection: ReturnType<typeof selectionText> = null;
      if (target.kind === 'section') texts = sectionTexts(section.markup, declarations);
      else {
        selection = selectionText(
          section.markup,
          declarations,
          target.path,
          target.text,
          target.range,
        );
        texts = selection ? [selection] : [];
      }
      if (!texts.length) {
        setError(
          target.kind === 'text'
            ? __(
                'There’s no text here for AI to change. Fill in the gap in [square brackets] yourself.',
                'pressbase-admin',
              )
            : __(
                'This section has no text for AI to change yet: its text is still placeholders for you to fill in.',
                'pressbase-admin',
              ),
        );
        return;
      }
      const answer = await api<{ texts: { id: string; text: string }[]; kept: string[] }>(
        '/pressbase/v1/studio/ai/rewrite',
        {
          method: 'POST',
          body: {
            action,
            ...(action === 'tone' ? { tone: options.tone ?? 'friendly' } : {}),
            ...(action === 'translate' ? { language: options.language || 'English' } : {}),
            texts: texts.map((t) => ({ id: t.id, text: t.text })),
          },
        },
      );
      const byId = new Map(texts.map((t) => [t.id, t]));
      const changes = answer.texts.flatMap((t) => {
        const found = byId.get(t.id);
        if (!found || t.text === found.text) return [];
        const text = selection ? spliceSelection(selection, t.text) : t.text;
        return [{ address: found.address, text }];
      });
      if (!changes.length) {
        setError(
          answer.kept.length
            ? __(
                'AI’s new wording added details nobody gave (numbers, names or addresses), so the text stays as it was.',
                'pressbase-admin',
              )
            : __('AI didn’t change anything: the text already reads that way.', 'pressbase-admin'),
        );
        return;
      }
      const summaries: Record<Exclude<RewriteAction, 'translate'>, string> = {
        rewrite: __('Rewrites the text in “%s”.', 'pressbase-admin'),
        shorten: __('Shortens the text in “%s”.', 'pressbase-admin'),
        expand: __('Expands the text in “%s”.', 'pressbase-admin'),
        tone: __('Changes the tone of the text in “%s”.', 'pressbase-admin'),
        fix_spelling: __('Fixes the spelling in “%s”.', 'pressbase-admin'),
      };
      const summary =
        action === 'translate'
          ? sprintf(
              __('Translates the text in “%1$s” into %2$s.', 'pressbase-admin'),
              section.label,
              options.language ?? '',
            )
          : sprintf(summaries[action] as '%s', section.label);
      const slots = slotsUpdate(section.markup, declarations, changes);
      if (await apply(summary, [{ type: 'updateSlots', index: section.index, slots }])) {
        setTarget(null);
      }
    });

  const addSection: AskAi['addSection'] = (prompt) =>
    run('section', async () => {
      if (target?.kind !== 'add-section') return;
      const current = latest.current.page;
      if (!current) {
        setError(__('Open a page first, then add a section to it.', 'pressbase-admin'));
        return;
      }
      // Core reads the page as the draft has it (a page the draft adds, too).
      const changeset = await latest.current.saveNow().catch(() => null);
      const proposal = await api<{ operations: unknown[]; summary: string }>(
        '/pressbase/v1/studio/ai/section',
        {
          method: 'POST',
          body: {
            prompt,
            page: typeof current.id === 'number' ? { id: current.id } : { slug: current.slug },
            ...(target.index !== null ? { index: target.index } : {}),
            ...(changeset?.uuid ? { changeset_uuid: changeset.uuid } : {}),
          },
        },
      );
      if (await apply(proposal.summary, proposal.operations)) setTarget(null);
    });

  const newPage: AskAi['newPage'] = (prompt) =>
    run('page', async () => {
      const changeset = await latest.current.saveNow().catch(() => null);
      const proposal = await api<{
        operations: unknown[];
        summary: string;
        page: { title: string; slug: string };
      }>('/pressbase/v1/studio/ai/page', {
        method: 'POST',
        body: { prompt, ...(changeset?.uuid ? { changeset_uuid: changeset.uuid } : {}) },
      });
      // Not tied to this canvas: the set waits for Keep or Undo on the new page.
      if (await apply(proposal.summary, proposal.operations, false)) {
        setTarget(null);
        setCreated(proposal.page.slug);
        onOpenPage(proposal.page.slug);
        onDone(
          sprintf(
            __('“%s” is a new page in your draft. Keep it, or undo it.', 'pressbase-admin'),
            proposal.page.title,
          ),
        );
      }
    });

  const askPanel: AskAi['askPanel'] = (text) => {
    if (!target || (target.kind !== 'section' && target.kind !== 'text')) return;
    const { section } = target;
    setTarget(null);
    onOpenPanel();
    ai.ask(
      sprintf(
        __('About section %1$d (“%2$s”): %3$s', 'pressbase-admin'),
        section.index + 1,
        section.label,
        text,
      ),
    );
  };

  return { target, open, close, busy, error, rewrite, addSection, newPage, askPanel, ai };
}

/* --------------------------------------------------------------- dialog */

const TONE_LABELS: Record<Tone, string> = {
  friendly: 'Friendlier',
  formal: 'More formal',
  confident: 'More confident',
  simple: 'Simpler',
  playful: 'More playful',
};

/** Ask AI's dialog, and its commands in the palette. */
export function AskAiDialog({ ask }: { ask: AskAi }) {
  const { __, sprintf } = useI18n();
  const { target, busy, error } = ask;
  const [tone, setTone] = useState<Tone>('friendly');
  const [language, setLanguage] = useState('French');
  const [prompt, setPrompt] = useState('');
  const [other, setOther] = useState('');
  const languagesId = useId();
  const promptForm = useRef<HTMLFormElement>(null);
  // The prompt's text box, for the dialog to start in.
  const promptRef = useRef({
    get current() {
      return promptForm.current?.querySelector('textarea') ?? null;
    },
  }).current as RefObject<HTMLTextAreaElement | null>;
  const firstRef = useRef<HTMLButtonElement>(null);
  const kind = target?.kind;
  const off = ask.ai.status ? !ask.ai.status.supports_ai : false;

  useEffect(() => {
    if (kind === 'add-section' || kind === 'new-page') setPrompt('');
    setOther('');
  }, [kind, target]);

  useStudioCommands(
    () => [
      {
        id: 'pressbase/ai/add-section',
        label: __('Add a section with AI…', 'pressbase-admin'),
        group: 'ai',
        keywords: [__('prompt', 'pressbase-admin'), __('generate', 'pressbase-admin')],
        icon: <LayoutPanelTop size={16} />,
        run: () => ask.open({ kind: 'add-section', index: null }),
      },
      {
        id: 'pressbase/ai/new-page',
        label: __('New page with AI…', 'pressbase-admin'),
        group: 'ai',
        keywords: [__('prompt', 'pressbase-admin'), __('generate', 'pressbase-admin')],
        icon: <FilePlus2 size={16} />,
        run: () => ask.open({ kind: 'new-page' }),
      },
    ],
    [__, ask.open],
  );

  const title =
    kind === 'section' && target?.kind === 'section'
      ? sprintf(__('Ask AI about “%s”', 'pressbase-admin'), target.section.label)
      : kind === 'text'
        ? __('Ask AI about this text', 'pressbase-admin')
        : kind === 'add-section'
          ? __('Add a section with AI', 'pressbase-admin')
          : __('New page with AI', 'pressbase-admin');

  const onPrompt = (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim()) return;
    if (kind === 'add-section') ask.addSection(prompt.trim());
    else ask.newPage(prompt.trim());
  };

  const quote =
    target?.kind === 'text'
      ? target.range
        ? target.text.slice(target.range.start, target.range.end)
        : target.text
      : '';

  return (
    <Dialog
      open={Boolean(target)}
      title={title}
      busy={Boolean(busy)}
      onClose={ask.close}
      initialFocus={kind === 'add-section' || kind === 'new-page' ? promptRef : firstRef}
      footer={
        <Button variant="ghost" onClick={ask.close} disabled={Boolean(busy)}>
          {__('Close', 'pressbase-admin')}
        </Button>
      }
    >
      <div className={styles.body} data-studio-ask-ai={kind}>
        {off && (
          <p className={styles.note} role="status">
            {__(
              'AI isn’t on for this site yet. Someone who manages the site can turn it on in Settings → AI.',
              'pressbase-admin',
            )}
          </p>
        )}
        {(kind === 'section' || kind === 'text') && (
          <>
            {quote && <blockquote className={styles.quote}>{quote}</blockquote>}
            <p className={styles.note}>
              {kind === 'section'
                ? __(
                    'Changes every text in the section. Gaps in [square brackets] stay for you to fill in.',
                    'pressbase-admin',
                  )
                : target?.kind === 'text' && target.range
                  ? __('Changes the selected words.', 'pressbase-admin')
                  : __('Changes this block’s text.', 'pressbase-admin')}
            </p>
            <fieldset className={styles.actions}>
              <legend className="visually-hidden">{__('Quick changes', 'pressbase-admin')}</legend>
              {(
                [
                  ['rewrite', __('Rewrite', 'pressbase-admin')],
                  ['shorten', __('Shorten', 'pressbase-admin')],
                  ['expand', __('Expand', 'pressbase-admin')],
                  ['fix_spelling', __('Fix spelling', 'pressbase-admin')],
                ] as [RewriteAction, string][]
              ).map(([action, label], i) => (
                <Button
                  key={action}
                  ref={i === 0 ? firstRef : undefined}
                  variant="secondary"
                  size="sm"
                  loading={busy === action}
                  disabled={Boolean(busy) || off}
                  onClick={() => ask.rewrite(action)}
                >
                  {label}
                </Button>
              ))}
            </fieldset>
            <div className={styles.row}>
              <label className={styles.inline}>
                <span>{__('Tone', 'pressbase-admin')}</span>
                <select
                  className={styles.control}
                  value={tone}
                  onChange={(e) => setTone(e.target.value as Tone)}
                >
                  {TONES.map((t) => (
                    <option key={t} value={t}>
                      {__(TONE_LABELS[t], 'pressbase-admin')}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'tone'}
                disabled={Boolean(busy) || off}
                onClick={() => ask.rewrite('tone', { tone })}
              >
                {__('Change tone', 'pressbase-admin')}
              </Button>
            </div>
            <div className={styles.row}>
              <label className={styles.inline}>
                <span>{__('Language', 'pressbase-admin')}</span>
                <input
                  className={styles.control}
                  list={languagesId}
                  value={language}
                  maxLength={60}
                  onChange={(e) => setLanguage(e.target.value)}
                />
                <datalist id={languagesId}>
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l} />
                  ))}
                </datalist>
              </label>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === 'translate'}
                disabled={Boolean(busy) || off || !language.trim()}
                onClick={() => ask.rewrite('translate', { language: language.trim() })}
              >
                {__('Translate', 'pressbase-admin')}
              </Button>
            </div>
            <form
              className={styles.other}
              onSubmit={(e) => {
                e.preventDefault();
                if (other.trim()) ask.askPanel(other.trim());
              }}
            >
              <TextAreaField
                label={__('Or describe another change', 'pressbase-admin')}
                hint={__(
                  'It goes to the AI panel, which can also change layouts and colours.',
                  'pressbase-admin',
                )}
                optional
                rows={2}
                value={other}
                onChange={(e) => setOther(e.target.value)}
              />
              <Button
                type="submit"
                variant="ghost"
                size="sm"
                disabled={!other.trim() || Boolean(busy) || off}
              >
                {__('Ask in the AI panel', 'pressbase-admin')}
              </Button>
            </form>
            {target?.kind === 'section' && (
              <Button
                variant="ghost"
                size="sm"
                icon={<LayoutPanelTop size={16} aria-hidden="true" />}
                disabled={Boolean(busy)}
                onClick={() =>
                  ask.open({
                    kind: 'add-section',
                    index: target.section.index + 1,
                    after: target.section.label,
                  })
                }
              >
                {__('Add a section below with AI…', 'pressbase-admin')}
              </Button>
            )}
          </>
        )}
        {(kind === 'add-section' || kind === 'new-page') && (
          <form ref={promptForm} className={styles.prompt} onSubmit={onPrompt}>
            <TextAreaField
              label={
                kind === 'add-section'
                  ? __('What should the section be?', 'pressbase-admin')
                  : __('What’s the page for?', 'pressbase-admin')
              }
              hint={
                kind === 'add-section'
                  ? target?.kind === 'add-section' && target.after
                    ? sprintf(
                        __(
                          'For example: pricing with three tiers. It goes after “%s”.',
                          'pressbase-admin',
                        ),
                        target.after,
                      )
                    : __(
                        'For example: pricing with three tiers. It goes at the end of the page.',
                        'pressbase-admin',
                      )
                  : __(
                      'For example: catering, with our services, prices and a way to get in touch.',
                      'pressbase-admin',
                    )
              }
              rows={3}
              maxLength={500}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
            <p className={styles.note}>
              {__(
                'AI uses the facts in your site’s brief. Anything it doesn’t know (prices, quotes, opening hours) is left in [square brackets] for you to fill in.',
                'pressbase-admin',
              )}
            </p>
            <Button
              type="submit"
              variant="primary"
              icon={<Sparkles size={16} aria-hidden="true" />}
              loading={busy === 'section' || busy === 'page'}
              disabled={!prompt.trim() || Boolean(busy) || off}
            >
              {kind === 'add-section'
                ? __('Add the section', 'pressbase-admin')
                : __('Create the page', 'pressbase-admin')}
            </Button>
          </form>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
