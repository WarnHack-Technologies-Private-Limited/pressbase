'use client';

import { Check, Info, RotateCcw, Sparkles, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n/context';
import { msgid } from '../../lib/i18n/locale';
import { BUILD_PATH, BuildOffer } from '../site-builder/build-offer';
import { Button, Spinner } from '../ui/button';
import styles from './ai-panel.module.css';
import { type AiMessage, requestsLeft } from './ai-panel-model';
import { useStudioCommands } from './command-palette';
import type { AiCanvas } from './use-ai-edits';
import type { StudioAi } from './use-studio-ai';

/**
 * Studio's AI panel (#62) and the review of AI changes (#57). The panel is
 * a conversation kept with the person's draft: they ask in their own
 * words, the reply is written as it arrives, and its changes go straight
 * onto the page, highlighted, for Keep or Undo. `AiReview` stays mounted
 * with the canvas: the highlight, the Keep / Undo bar and the AI commands.
 * See docs/architecture/ai-edits.md.
 */

/** Where the composer is, for the command that opens the panel. */
export const AI_INPUT_ID = 'studio-ai-input';

const SUGGESTIONS = [
  msgid('Make the buttons rounder'),
  msgid('Add an FAQ to this page'),
  msgid('Change the headline to something warmer'),
];

export function AiPanel({ ai }: { ai: StudioAi }) {
  const { __, _n, sprintf } = useI18n();
  const [input, setInput] = useState('');
  const threadRef = useRef<HTMLOListElement>(null);
  const { status, messages, streaming, busy } = ai;

  useEffect(() => {
    ai.load();
  }, [ai.load]);

  // Start in the composer, once it's there, unless the person has moved on from the panel's heading.
  const ready = Boolean(status?.supports_ai && !status.limit_reached);
  useEffect(() => {
    if (!ready) return;
    let frame = requestAnimationFrame(() => {
      // After the panel's own first focus (its heading).
      frame = requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body || active.matches('#studio-panel h2')) {
          document.getElementById(AI_INPUT_ID)?.focus();
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // Keep the newest message in view as the reply is written.
  const last = messages[messages.length - 1]?.id;
  useEffect(() => {
    const thread = threadRef.current;
    if (thread && (last || streaming !== null)) thread.scrollTop = thread.scrollHeight;
  }, [last, streaming]);

  if (ai.loadError) {
    return (
      <p className={styles.note} role="alert">
        {ai.loadError}
      </p>
    );
  }
  if (!status) {
    return (
      <p className={styles.note} aria-busy="true">
        {__('Opening the conversation…', 'pressbase-admin')}
      </p>
    );
  }
  if (!status.supports_ai) {
    return (
      <div className={styles.off}>
        <p>
          {__(
            'Once AI is on, ask for changes here in your own words: “make the buttons rounder”, “add an FAQ”. You see each change on the page, then keep it or undo it.',
            'pressbase-admin',
          )}
        </p>
        <BuildOffer variant="panel" />
      </div>
    );
  }

  const send = (text: string) => {
    if (!text.trim() || busy || status.limit_reached) return;
    setInput('');
    ai.ask(text);
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    send(input);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send(input);
    }
  };
  const left = requestsLeft(status);

  return (
    <div className={styles.panel}>
      {messages.length === 0 && streaming === null ? (
        <div className={styles.intro}>
          <Sparkles size={24} aria-hidden="true" className={styles.introIcon} />
          <p>
            {__(
              'Ask for a change in your own words. It appears on the page, highlighted, and you keep it or undo it. Nothing goes live until you publish.',
              'pressbase-admin',
            )}
          </p>
          <ul className={styles.suggestions} aria-label={__('Ideas to try', 'pressbase-admin')}>
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button
                  type="button"
                  className={styles.suggestion}
                  onClick={() => {
                    setInput(__(suggestion, 'pressbase-admin'));
                    document.getElementById(AI_INPUT_ID)?.focus();
                  }}
                >
                  {__(suggestion, 'pressbase-admin')}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ol
          ref={threadRef}
          className={styles.thread}
          aria-label={__('Conversation with AI', 'pressbase-admin')}
          aria-live="polite"
          aria-busy={busy || undefined}
        >
          {messages.map((message) => (
            <Message key={message.id} message={message} ai={ai} />
          ))}
          {streaming !== null && (
            <li className={styles.message} data-role="assistant">
              {streaming ? (
                <p>{streaming}</p>
              ) : (
                <p className={styles.thinking}>
                  <Spinner />
                  {__('Looking at your site…', 'pressbase-admin')}
                </p>
              )}
            </li>
          )}
        </ol>
      )}

      {ai.error && (
        <p className={styles.error} role="alert">
          {ai.error}
        </p>
      )}

      {status.limit_reached ? (
        <p className={styles.limit} role="status">
          <Info size={16} aria-hidden="true" />
          <span>
            {sprintf(
              __(
                'This site has used all %d of its AI requests for today. You can ask again after midnight (UTC).',
                'pressbase-admin',
              ),
              status.daily_limit,
            )}
            {status.can_manage_ai && (
              <>
                {' '}
                <Link href="/admin/settings/ai">
                  {__('Change the limit in Settings → AI', 'pressbase-admin')}
                </Link>
              </>
            )}
          </span>
        </p>
      ) : (
        <form className={styles.composer} onSubmit={onSubmit}>
          <label htmlFor={AI_INPUT_ID} className="visually-hidden">
            {__('Ask AI for a change', 'pressbase-admin')}
          </label>
          <textarea
            id={AI_INPUT_ID}
            className={styles.input}
            rows={3}
            maxLength={2000}
            value={input}
            placeholder={__('Ask for a change…', 'pressbase-admin')}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            aria-describedby="studio-ai-hint"
          />
          <div className={styles.composerFoot}>
            <span id="studio-ai-hint" className={styles.hint}>
              {left <= 5
                ? sprintf(
                    _n('%d request left today', '%d requests left today', left, 'pressbase-admin'),
                    left,
                  )
                : __('Enter to send, Shift+Enter for a new line', 'pressbase-admin')}
            </span>
            <Button
              type="submit"
              size="sm"
              variant="primary"
              loading={busy}
              disabled={!input.trim()}
              icon={<Sparkles size={16} aria-hidden="true" />}
            >
              {__('Ask', 'pressbase-admin')}
            </Button>
          </div>
        </form>
      )}

      <div className={styles.foot}>
        {messages.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            icon={<RotateCcw size={14} aria-hidden="true" />}
            disabled={busy}
            onClick={() => ai.clear()}
          >
            {__('Start again', 'pressbase-admin')}
          </Button>
        )}
        <Link href={BUILD_PATH} className={styles.build}>
          {__('Build a new site', 'pressbase-admin')}
        </Link>
      </div>
    </div>
  );
}

function Message({ message, ai }: { message: AiMessage; ai: StudioAi }) {
  const { __ } = useI18n();
  if (message.role === 'user') {
    return (
      <li className={styles.message} data-role="user">
        <span className="visually-hidden">{__('You:', 'pressbase-admin')} </span>
        <p>{message.text}</p>
      </li>
    );
  }
  const pending = ai.edits.pending?.id === message.id ? ai.edits.pending : null;
  const outcome = ai.edits.outcomes[message.id] ?? message.outcome;
  const problem = ai.problems[message.id];
  return (
    <li className={styles.message} data-role="assistant" data-message={message.id}>
      <span className="visually-hidden">{__('AI:', 'pressbase-admin')} </span>
      {message.text && <p>{message.text}</p>}
      {message.error && (
        <p className={styles.error} role="alert">
          {message.error.message}
        </p>
      )}
      {message.operations && message.operations.length > 0 && (
        <div
          className={styles.proposal}
          data-state={pending ? 'pending' : problem ? 'failed' : outcome}
        >
          {message.summary && <p className={styles.summary}>{message.summary}</p>}
          {problem ? (
            <p className={styles.problem}>
              {__('These changes couldn’t be made:', 'pressbase-admin')} {problem}
            </p>
          ) : pending ? (
            <>
              <p className={styles.state}>
                {__(
                  'On the page now, highlighted. Keep the changes, or undo them.',
                  'pressbase-admin',
                )}
              </p>
              {pending.unused.length > 0 && (
                <p className={styles.state}>
                  {__('The new layout has no place for:', 'pressbase-admin')}{' '}
                  {pending.unused.join(' · ')}
                </p>
              )}
              <ReviewButtons ai={ai} />
            </>
          ) : outcome === 'kept' ? (
            <p className={styles.state}>
              <Check size={14} aria-hidden="true" /> {__('Kept', 'pressbase-admin')}
            </p>
          ) : outcome === 'undone' ? (
            <p className={styles.state}>
              <Undo2 size={14} aria-hidden="true" /> {__('Undone', 'pressbase-admin')}
            </p>
          ) : null}
        </div>
      )}
    </li>
  );
}

function ReviewButtons({ ai }: { ai: StudioAi }) {
  const { __ } = useI18n();
  return (
    <div className={styles.review}>
      <Button
        size="sm"
        variant="primary"
        icon={<Check size={14} aria-hidden="true" />}
        onClick={() => ai.edits.keep()}
      >
        {__('Keep', 'pressbase-admin')}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={<Undo2 size={14} aria-hidden="true" />}
        onClick={() => ai.edits.undo(ai.canvas.current)}
      >
        {__('Undo', 'pressbase-admin')}
      </Button>
    </div>
  );
}

/**
 * With the canvas: hands it to the AI (for applying and undoing),
 * highlights a set waiting for Keep or Undo, offers Keep and Undo over the
 * canvas while the panel is closed, and registers the AI commands.
 */
export function AiReview({
  ai,
  canvas,
  panelOpen,
  onOpenPanel,
}: {
  ai: StudioAi;
  canvas: AiCanvas | null;
  panelOpen: boolean;
  onOpenPanel: () => void;
}) {
  const { __, sprintf } = useI18n();
  const { pending, keep, undo } = ai.edits;
  ai.canvas.current = canvas;

  // Another page opened: the changes are in the draft, so they're kept.
  useEffect(() => {
    if (pending?.canvasKey && canvas && canvas.key !== pending.canvasKey) keep();
  }, [canvas, pending, keep]);

  useStudioCommands(
    () => [
      {
        id: 'pressbase/ai/ask',
        label: __('Ask AI for a change', 'pressbase-admin'),
        group: 'ai',
        keywords: [__('assistant', 'pressbase-admin'), __('help', 'pressbase-admin')],
        icon: <Sparkles size={16} />,
        run: () => {
          // The panel starts in its composer; when it's open already, go there.
          document.getElementById(AI_INPUT_ID)?.focus();
          onOpenPanel();
        },
      },
      {
        id: 'pressbase/ai/keep',
        label: __('Keep the changes from AI', 'pressbase-admin'),
        group: 'ai',
        hint: pending ? pending.summary : __('Nothing to keep', 'pressbase-admin'),
        icon: <Check size={16} />,
        disabled: !pending,
        run: keep,
      },
      {
        id: 'pressbase/ai/undo',
        label: __('Undo the changes from AI', 'pressbase-admin'),
        group: 'ai',
        hint: pending ? pending.summary : __('Nothing to undo', 'pressbase-admin'),
        icon: <Undo2 size={16} />,
        disabled: !pending,
        run: () => undo(ai.canvas.current),
      },
      {
        id: 'pressbase/ai/clear',
        label: __('Start a new conversation with AI', 'pressbase-admin'),
        group: 'ai',
        icon: <RotateCcw size={16} />,
        disabled: !ai.messages.length || ai.busy,
        run: () => {
          onOpenPanel();
          ai.clear();
        },
      },
    ],
    [__, pending, keep, undo, ai.messages.length, ai.busy, ai.clear, onOpenPanel],
  );

  return (
    <>
      <AiHighlight ids={pending?.highlight ?? []} />
      {pending && !panelOpen && (
        <section
          className={styles.bar}
          aria-label={__('Changes from AI', 'pressbase-admin')}
          data-studio-ai-review
        >
          <Sparkles size={16} aria-hidden="true" />
          <p>{sprintf(__('From AI: %s', 'pressbase-admin'), pending.summary)}</p>
          <ReviewButtons ai={ai} />
        </section>
      )}
    </>
  );
}

const HIGHLIGHT_STYLE = 'pressbase-ai-highlight';

/** Outlines the blocks a set changed, in the canvas iframe, and scrolls to the first. */
function AiHighlight({ ids }: { ids: readonly string[] }) {
  const key = ids.join(',');
  useEffect(() => {
    const list = key ? key.split(',') : [];
    let scrolled = false;
    const paint = () => {
      const doc = document.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      )?.contentDocument;
      if (!doc?.head) return;
      let style = doc.getElementById(HIGHLIGHT_STYLE);
      if (!list.length) {
        style?.remove();
        return;
      }
      if (!style) {
        style = doc.createElement('style');
        style.id = HIGHLIGHT_STYLE;
        doc.head.append(style);
      }
      const selectors = list.map((id) => `[data-block="${CSS.escape(id)}"]`).join(',\n');
      style.textContent = `${selectors} {
  outline: 2px dashed var(--wp-admin-theme-color, #3b4cca) !important;
  outline-offset: 3px;
}`;
      if (!scrolled) {
        const first = doc.querySelector(`[data-block="${CSS.escape(list[0] as string)}"]`);
        if (first) {
          first.scrollIntoView({ block: 'center', behavior: 'smooth' });
          scrolled = true;
        }
      }
    };
    paint();
    // The canvas may draw the new blocks a moment later, or redraw its iframe.
    const timer = list.length ? setInterval(paint, 500) : undefined;
    return () => {
      if (timer) clearInterval(timer);
      const doc = document.querySelector<HTMLIFrameElement>(
        'iframe[name="editor-canvas"]',
      )?.contentDocument;
      doc?.getElementById(HIGHLIGHT_STYLE)?.remove();
    };
  }, [key]);
  return null;
}
