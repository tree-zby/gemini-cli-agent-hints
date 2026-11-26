/**
 * `BeforeModel` -> `X-Agent-Hint`.
 *
 * One hook invocation in, one header out. Everything is fail-open: any problem
 * (missing fields, unreadable state, a hint that fails the contract) yields an
 * empty header map so the model call proceeds untouched.
 */

import { readConfig, type PluginConfig } from './config.js';
import { encode } from './encoder.js';
import { messageText, type HookInput } from './hook-input.js';
import { HEADER_NAME, validate, type Hint } from './protocol.js';
import {
  HintSession,
  defaultConfig,
  deriveTurnOpening,
  type HintConfig,
  type MessageView,
} from './state.js';
import { FileStore, conversationRoot, sessionKey } from './store.js';

export interface AdapterResult {
  headers: Record<string, string>;
  hint?: Hint;
  reason?: string;
  sessionKey?: string;
}

export interface AdapterOptions {
  config?: PluginConfig;
  store?: FileStore;
  /** Epoch seconds override, for tests. */
  now?: number;
}

function normalizeRole(role: string | undefined): string {
  switch (role) {
    case 'model':
    case 'assistant':
      return 'model';
    case 'system':
      return 'system';
    default:
      return 'user';
  }
}

export function projectMessages(input: HookInput): MessageView[] {
  const messages = input.llm_request?.messages ?? [];
  const views: MessageView[] = [];
  for (const message of messages) {
    const text = messageText(message);
    // The projection drops tool parts entirely, so a message without text is
    // invisible here; `before_model_meta.has_tool_parts` carries that fact.
    if (!text) continue;
    views.push({ role: normalizeRole(message.role), text });
  }
  return views;
}

function hintConfigFor(config: PluginConfig, wireCount: number): HintConfig {
  return {
    ...defaultConfig(),
    enabled: config.enabled,
    priority: config.priority,
    cache: config.cache,
    priorityLevel: config.priorityLevel,
    cacheMinPrefixTokens: config.cacheMinPrefixTokens,
    defaultTtlS: config.defaultTtlS,
    ttlMinS: config.ttlMinS,
    ttlMaxS: config.ttlMaxS,
    // More than one wire content means this request already carries history,
    // so it is a continuation of a session we never saw start.
    hasHistory: wireCount > 1,
    assumeExistingSession: false,
  };
}

/** Compute the header for one hook invocation. */
export function handleBeforeModel(
  input: HookInput,
  options: AdapterOptions = {},
): AdapterResult {
  const config = options.config ?? readConfig();
  if (!config.enabled) return { headers: {}, reason: 'disabled' };

  const views = projectMessages(input);
  if (views.length === 0) {
    // Nothing to anchor a session on (e.g. a projection with no text at all).
    return { headers: {}, reason: 'no-text-content' };
  }

  const meta = input.before_model_meta;
  const metaWire = meta?.wire_message_count;
  const wireCount =
    typeof metaWire === 'number' && Number.isInteger(metaWire) && metaWire > 0
      ? metaWire
      : views.length;

  const hasToolParts = meta?.has_tool_parts === true;
  const turnOpening = hasToolParts ? false : deriveTurnOpening(views);

  const hostSessionId =
    input.session_id || input.transcript_path || 'gemini-unknown-session';
  const root = conversationRoot(
    views.filter((v) => v.role === 'user' || v.role === 'system').map((v) => v.text),
  );
  const key = sessionKey(hostSessionId, root);

  const store = options.store ?? new FileStore(config.stateDir);
  const snapshot = store.load(key);
  const session = snapshot
    ? HintSession.fromSnapshot(snapshot, hintConfigFor(config, wireCount))
    : new HintSession(undefined, hintConfigFor(config, wireCount));

  const hint = session.build({
    messages: views,
    model: input.llm_request?.model ?? '',
    tools: [],
    auxiliary: false,
    turnOpening,
    // Retries resend the same wire shape; a new turn grows it.
    fingerprintStamp: `${wireCount}|${hasToolParts ? 'tool' : 'text'}`,
    now: options.now,
  });

  if (!hint) {
    store.save(key, session.toSnapshot());
    return { headers: {}, reason: 'no-hint', sessionKey: key };
  }

  // The hook knows the true `contents` length only through the host patch.
  if (hint.cache_control) hint.cache_control.msg_offset = wireCount;

  const errors = validate(hint);
  if (errors.length > 0) {
    // Fail open: never ship a hint that breaks the contract.
    store.save(key, session.toSnapshot());
    return {
      headers: {},
      reason: `invalid-hint: ${errors.join('; ')}`,
      sessionKey: key,
    };
  }

  store.save(key, session.toSnapshot());
  return {
    headers: { [HEADER_NAME]: encode(hint) },
    hint,
    sessionKey: key,
  };
}
