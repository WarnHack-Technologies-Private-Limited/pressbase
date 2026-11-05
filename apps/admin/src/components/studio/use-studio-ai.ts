'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, withUserLocale } from '@/lib/api';
import { useI18n } from '@/lib/i18n/context';
import {
  type AiMessage,
  type AiStatus,
  problemText,
  readEvents,
  upsertMessage,
} from './ai-panel-model';
import type { PageRef } from './site-model';
import { type AiCanvas, type AiEdits, useAiEdits } from './use-ai-edits';

/**
 * Studio's AI panel (#62): the conversation kept with the person's
 * changeset, asking (`POST /pressbase/v1/studio/ai/messages`, read as
 * Server-Sent Events while the reply is written), and applying each
 * proposal with Keep and Undo (use-ai-edits.ts). Lives in Studio rather
 * than the panel, so a set waiting for Keep or Undo, and the commands,
 * outlast the panel. See docs/architecture/ai-edits.md.
 */

const BASE = '/pressbase/v1/studio/ai';

export interface StudioAi {
  /** Null until loaded (or when it couldn't load: `loadError`). */
  status: AiStatus | null;
  loadError: string | null;
  messages: AiMessage[];
  /** The reply being written, while a request runs. */
  streaming: string | null;
  busy: boolean;
  /** Why a request failed before it got an answer. */
  error: string | null;
  /** Why a proposal couldn't be applied, by message ID. */
  problems: Readonly<Record<string, string>>;
  edits: AiEdits;
  ask(message: string): Promise<void>;
  /** Starts the conversation again. */
  clear(): Promise<void>;
  /** The canvas now (StudioEditor's), for applying and undoing. */
  canvas: { current: AiCanvas | null };
  /** Loads the conversation (the panel opening). */
  load(): void;
}

export function useStudioAi({
  edits: editsOptions,
  changesetUuid,
  page,
  saveNow,
}: {
  edits: Omit<Parameters<typeof useAiEdits>[0], 'open'>;
  /** The person's open changeset, once there is one. */
  changesetUuid: string | null;
  /** The page on the canvas. */
  page: { id: PageRef; slug: string } | null;
  /** Hands the canvas's edits to the draft and saves them: the AI reads the draft. */
  saveNow: () => Promise<unknown>;
}): StudioAi {
  const { __, sprintf } = useI18n();
  const edits = useAiEdits({ ...editsOptions, open: page });
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const canvas = useRef<AiCanvas | null>(null);
  const latest = useRef({ changesetUuid, page, saveNow, edits });
  latest.current = { changesetUuid, page, saveNow, edits };
  const loaded = useRef<string | null | undefined>(undefined);

  const load = useCallback(() => {
    const uuid = latest.current.changesetUuid;
    if (loaded.current === uuid) return;
    loaded.current = uuid;
    api<AiStatus>(`${BASE}${uuid ? `?changeset_uuid=${uuid}` : ''}`)
      .then((next) => {
        setStatus(next);
        setMessages(next.messages);
        setLoadError(null);
      })
      .catch((e) => {
        loaded.current = undefined;
        setLoadError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  // Another changeset (the draft resumed, discarded or published): its conversation.
  // A request that starts one notes it first (`start`), so that one isn't reloaded.
  useEffect(() => {
    if (loaded.current === undefined || busy || loaded.current === changesetUuid) return;
    loaded.current = undefined;
    load();
  }, [changesetUuid, busy, load]);

  const applyReply = useCallback(
    async (message: AiMessage) => {
      if (!message.operations?.length) return;
      const result = await latest.current.edits.apply(canvas.current, {
        id: message.id,
        summary: message.summary ?? '',
        operations: message.operations,
        styles: message.styles ?? null,
      });
      if (!result.ok) {
        setProblems((current) => ({
          ...current,
          [message.id]: problemText(result.problem, __, sprintf),
        }));
        api(`${BASE}/messages/${message.id}`, {
          method: 'POST',
          body: { outcome: 'undone', changeset_uuid: latest.current.changesetUuid ?? undefined },
        }).catch(() => {});
      }
    },
    [__, sprintf],
  );

  const ask = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || busy) return;
      setBusy(true);
      setError(null);
      setStreaming('');
      // A set still waiting is kept: the person moved on.
      latest.current.edits.keep();
      try {
        // The AI reads the page as the draft has it.
        await latest.current.saveNow().catch(() => null);
        const { changesetUuid: uuid, page: open } = latest.current;
        const parts = [...(canvas.current?.regions().keys() ?? [])]
          .filter((key) => key.startsWith('wp_template_part:'))
          .map((key) => key.slice('wp_template_part:'.length));
        const res = await fetch(`/wp-json${withUserLocale(`${BASE}/messages`)}`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', 'x-pressbase-request': '1' },
          body: JSON.stringify({
            message,
            ...(uuid ? { changeset_uuid: uuid } : {}),
            page: open
              ? typeof open.id === 'number'
                ? { id: open.id }
                : { slug: open.slug }
              : null,
            parts,
          }),
        });
        if (!(res.headers.get('content-type') ?? '').includes('text/event-stream') || !res.body) {
          const data = (await res.json().catch(() => null)) as {
            code?: string;
            message?: string;
            data?: Partial<AiStatus>;
          } | null;
          if (data?.code === 'ai_daily_limit_reached') {
            setStatus((current) =>
              current ? { ...current, ...data.data, limit_reached: true } : current,
            );
          } else if (data?.code === 'prompt_prevented') {
            setStatus((current) => (current ? { ...current, supports_ai: false } : current));
          }
          throw new ApiError(
            res.status,
            data?.code ?? 'pressbase_unknown_error',
            data?.message ?? __('Something went wrong. Please try again.', 'pressbase-admin'),
          );
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        let reply: AiMessage | null = null;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const read = readEvents(buffer + value);
          buffer = read.rest;
          for (const { event, data } of read.events) {
            const payload = data as Record<string, unknown>;
            if (event === 'start') {
              loaded.current = String(payload.changeset_uuid ?? '') || null;
              setMessages((current) => upsertMessage(current, payload.request as AiMessage));
            } else if (event === 'text') {
              setStreaming((current) => (current ?? '') + String(payload.text ?? ''));
            } else if (event === 'done') {
              reply = payload.message as AiMessage;
              setMessages((current) => upsertMessage(current, reply as AiMessage));
              setStatus((current) =>
                current
                  ? {
                      ...current,
                      daily_limit: Number(payload.daily_limit ?? current.daily_limit),
                      requests_today: Number(payload.requests_today ?? current.requests_today),
                      limit_reached: Boolean(payload.limit_reached),
                    }
                  : current,
              );
            }
          }
        }
        setStreaming(null);
        if (reply) await applyReply(reply);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setStreaming(null);
        setBusy(false);
      }
    },
    [__, busy, applyReply],
  );

  const clear = useCallback(async () => {
    const uuid = latest.current.changesetUuid;
    latest.current.edits.keep();
    try {
      await api(`${BASE}${uuid ? `?changeset_uuid=${uuid}` : ''}`, { method: 'DELETE' });
      setMessages([]);
      setProblems({});
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return {
    status,
    loadError,
    messages,
    streaming,
    busy,
    error,
    problems,
    edits,
    ask,
    clear,
    canvas,
    load,
  };
}
