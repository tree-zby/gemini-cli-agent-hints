/**
 * Deterministic hint derivation (protocol sections 5-6).
 *
 * One request in, one hint out, with every mutable fact held on
 * {@link HintSession}. Gemini CLI runs the sender inside a `BeforeModel` hook
 * process, so the session is serialised to disk by `store.ts` after every
 * request and reloaded on the next one.
 */

import { createHash, randomBytes } from 'node:crypto';

import type { Hint, HintCacheControl, StateName } from './protocol.js';
import { editFor, priorityReason } from './protocol.js';

export interface MessageView {
  role: string;
  text: string;
  hasToolCall?: boolean;
  hasToolResult?: boolean;
}

export interface RequestView {
  messages: MessageView[];
  model: string;
  tools: string[];
  /** Auxiliary calls never carry a hint (protocol section 7.2). */
  auxiliary: boolean;
  /** True when the request ends in fresh user text rather than a tool loop. */
  turnOpening?: boolean;
  /** Extra identity used for retry detection. */
  fingerprintStamp?: string;
  /** Seconds on a monotonic clock; used for the adaptive TTL. */
  now?: number;
}

export type Derive = 'dynamic' | 'omit';

export interface HintConfig {
  enabled: boolean;
  priority: Derive;
  cache: Derive;
  priorityLevel?: number;
  cacheMinPrefixTokens: number;
  defaultTtlS: number;
  ttlMinS: number;
  ttlMaxS: number;
  parentSessionId?: string;
  /** True when the harness already had history at session start. */
  hasHistory: boolean;
  /** True when the hint is a continuation of a session we never saw start. */
  assumeExistingSession: boolean;
}

export function defaultConfig(): HintConfig {
  return {
    enabled: true,
    priority: 'dynamic',
    cache: 'dynamic',
    cacheMinPrefixTokens: 128,
    defaultTtlS: 600,
    ttlMinS: 60,
    ttlMaxS: 3600,
    hasHistory: false,
    assumeExistingSession: false,
  };
}

export class HintError extends Error {}

/** Generate an opaque, non-identifying session id (max 256 chars). */
export function newSessionId(prefix = 'ah'): string {
  return `${prefix}-${randomBytes(12).toString('hex')}`;
}

/** Approximate token cost: CJK = 1 token/char, other text = 4 chars/token. */
export function estimateTextTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(char)) cjk += 1;
  }
  const other = text.length - cjk;
  return cjk + other / 4;
}

export function estimatePrefixTokens(
  messages: readonly MessageView[],
): number | undefined {
  let sawText = false;
  let total = 0;
  for (const message of messages) {
    if (message.text) sawText = true;
    total += estimateTextTokens(message.text);
  }
  return sawText ? Math.round(total) : undefined;
}

/** Stable identity of a logical request, used to reuse a hint on retry. */
export function requestFingerprint(view: RequestView): string {
  const payload = {
    model: view.model,
    tools: [...view.tools].sort(),
    stamp: view.fingerprintStamp ?? '',
    messages: view.messages.map((message) => [
      message.role,
      message.text,
      Boolean(message.hasToolCall),
      Boolean(message.hasToolResult),
    ]),
  };
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/** True when the request ends in fresh user text rather than a tool loop. */
export function deriveTurnOpening(messages: readonly MessageView[]): boolean {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.hasToolCall || message.hasToolResult) return false;
    if (message.role === 'assistant' || message.role === 'model') {
      if (message.text) return false;
      continue;
    }
    if (message.role === 'user') return true;
  }
  return false;
}

export interface SessionSnapshot {
  session_id: string;
  call_index: number;
  epoch: number;
  first_accepted: boolean;
  started: boolean;
  isolated: boolean;
  after_rewrite: boolean;
  last_signature?: string[];
  last_fingerprint?: string;
  last_hint?: Hint;
  last_outcome: 'pending' | 'accepted';
  last_model?: string;
}

export class HintSession {
  sessionId: string;
  callIndex = 0;
  epoch = 0;
  firstAccepted = false;
  started = false;
  isolated = false;
  afterRewrite = false;
  config: HintConfig;

  private lastSignature?: string[];
  private lastFingerprint?: string;
  private lastHint?: Hint;
  private lastOutcome: 'pending' | 'accepted' = 'pending';
  private lastModel?: string;

  constructor(sessionId: string | undefined, config: HintConfig) {
    const resolved = { ...config };
    if (
      resolved.ttlMinS < 60 ||
      resolved.ttlMaxS > 3600 ||
      resolved.ttlMinS > resolved.ttlMaxS
    ) {
      throw new HintError('TTL bounds must satisfy 60 <= min <= max <= 3600');
    }
    if (
      resolved.defaultTtlS < resolved.ttlMinS ||
      resolved.defaultTtlS > resolved.ttlMaxS
    ) {
      throw new HintError('default_ttl_s must be inside the TTL bounds');
    }
    const id = sessionId ?? newSessionId();
    if (!id || id.length > 256) throw new HintError('invalid session id');
    this.sessionId = id;
    this.config = resolved;
  }

  toSnapshot(): SessionSnapshot {
    return {
      session_id: this.sessionId,
      call_index: this.callIndex,
      epoch: this.epoch,
      first_accepted: this.firstAccepted,
      started: this.started,
      isolated: this.isolated,
      after_rewrite: this.afterRewrite,
      last_signature: this.lastSignature,
      last_fingerprint: this.lastFingerprint,
      last_hint: this.lastHint,
      last_outcome: this.lastOutcome,
      last_model: this.lastModel,
    };
  }

  static fromSnapshot(
    snapshot: SessionSnapshot,
    config: HintConfig,
  ): HintSession {
    const session = new HintSession(snapshot.session_id, config);
    session.callIndex = snapshot.call_index;
    session.epoch = snapshot.epoch;
    session.firstAccepted = snapshot.first_accepted;
    session.started = snapshot.started;
    session.isolated = snapshot.isolated;
    session.afterRewrite = snapshot.after_rewrite;
    session.lastSignature = snapshot.last_signature;
    session.lastFingerprint = snapshot.last_fingerprint;
    session.lastHint = snapshot.last_hint;
    session.lastOutcome = snapshot.last_outcome;
    session.lastModel = snapshot.last_model;
    return session;
  }

  /** Record that the endpoint accepted the in-flight ordinary request. */
  noteAccepted(): void {
    this.firstAccepted = true;
    this.lastOutcome = 'accepted';
  }

  /** Record a committed history rewrite; returns the superseded epoch. */
  noteRewrite(): number {
    const superseded = this.epoch;
    this.epoch += 1;
    this.afterRewrite = true;
    return superseded;
  }

  isolate(): void {
    this.isolated = true;
  }

  clearIsolation(): void {
    this.isolated = false;
    this.lastOutcome = 'pending';
  }

  /** Return the hint for an ordinary request, or `undefined` to send none. */
  build(view: RequestView): Hint | undefined {
    if (!this.config.enabled || view.auxiliary) return undefined;
    if (this.isolated) return undefined;

    const fingerprint = requestFingerprint(view);
    if (this.lastFingerprint === fingerprint && this.lastOutcome !== 'accepted') {
      // Same logical request again: a retry reuses the exact hint.
      return this.lastHint;
    }

    this.callIndex += 1;
    const opening = view.turnOpening ?? deriveTurnOpening(view.messages);
    const fresh =
      this.callIndex === 1 &&
      !this.config.hasHistory &&
      !this.config.assumeExistingSession &&
      !this.firstAccepted &&
      !this.started;
    const state: StateName = fresh ? 'start' : 'append';
    if (fresh) this.started = true;

    const hint: Hint = {
      session: {
        session_id: this.sessionId,
        call_index: this.callIndex,
        epoch: this.epoch,
        state,
        ...(this.config.parentSessionId
          ? { parent_session_id: this.config.parentSessionId }
          : {}),
      },
    };

    if (this.config.priority === 'dynamic') {
      const level = this.config.priorityLevel ?? (opening ? 3 : 1);
      hint.priority_control = {
        priority: { level, reason: priorityReason(level) },
      };
    }

    const cache = this.cache(view);
    if (cache) hint.cache_control = cache;

    this.lastFingerprint = fingerprint;
    this.lastHint = hint;
    this.lastOutcome = 'pending';
    this.afterRewrite = false;
    this.lastModel = view.model;
    return hint;
  }

  /** Build a manage hint (protocol sections 5.3 and 8.2). */
  buildManage(state: StateName, callIndex?: number, epoch?: number): Hint {
    const edit = editFor(state);
    if (!edit) throw new HintError(`not a manage verb: ${state}`);
    return {
      session: {
        session_id: this.sessionId,
        call_index: Math.max(1, callIndex ?? this.callIndex),
        epoch: epoch ?? this.epoch,
        state,
        ...(this.config.parentSessionId
          ? { parent_session_id: this.config.parentSessionId }
          : {}),
      },
      context_management: {
        manage_request: true,
        edits: [{ type: edit, target: 'session' }],
      },
    };
  }

  private cache(view: RequestView): HintCacheControl | undefined {
    if (this.config.cache === 'omit' || this.afterRewrite) return undefined;

    const signature = [view.model, ...[...view.tools].sort()];
    const stable = this.lastSignature
      ? this.lastSignature.join('\u0000') === signature.join('\u0000')
      : this.callIndex <= 1;
    this.lastSignature = signature;
    if (!stable) return undefined;

    const tokens = estimatePrefixTokens(view.messages);
    if (tokens === undefined || tokens < this.config.cacheMinPrefixTokens) {
      return undefined;
    }
    return {
      type: 'ephemeral',
      ttl_s: this.config.defaultTtlS,
      msg_offset: view.messages.length,
    };
  }
}
