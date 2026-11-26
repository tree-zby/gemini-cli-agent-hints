/**
 * Wire schema and validation for `agent-hint-protocol` v1.0.
 *
 * The sender is the only party that needs this module at runtime: a receiver
 * MUST NOT reject a model request because a hint is malformed, so validation
 * here exists to keep us honest, never to police the network.
 */

export const HEADER_NAME = 'X-Agent-Hint';

/** Sender budget from protocol section 3.3. */
export const MAX_HEADER_BYTES = 4096;

/** Section 6.4: TTL bounds. */
export const TTL_MIN_S = 60;
export const TTL_MAX_S = 3600;

export type StateName =
  | 'start'
  | 'append'
  | 'pause'
  | 'resume'
  | 'stop'
  | 'compact';

export const MANAGE_STATES: readonly StateName[] = [
  'pause',
  'resume',
  'stop',
  'compact',
];

export interface HintSessionBlock {
  session_id: string;
  call_index: number;
  epoch: number;
  state: StateName;
  parent_session_id?: string;
}

export interface HintContextManagement {
  manage_request: true;
  edits: Array<{ type: 'offload' | 'prefetch' | 'evict'; target: 'session' }>;
}

export interface HintPriority {
  level: number;
  reason: 'user_waiting' | 'critical_path';
}

export interface HintCacheControl {
  type: 'ephemeral';
  ttl_s: number;
  msg_offset: number;
}

/**
 * The whole hint. Exactly four top-level blocks are allowed (section 4).
 *
 * `session` is always present; the rest are optional and mutually exclusive
 * with `context_management`, which only appears on manage requests.
 */
export interface Hint {
  session: HintSessionBlock;
  context_management?: HintContextManagement;
  priority_control?: { priority: HintPriority };
  cache_control?: HintCacheControl;
}

/** The single edit type a manage request for this state must carry. */
export function editFor(state: StateName): 'offload' | 'prefetch' | 'evict' | undefined {
  switch (state) {
    case 'pause':
      return 'offload';
    case 'resume':
      return 'prefetch';
    case 'stop':
    case 'compact':
      return 'evict';
    default:
      return undefined;
  }
}

export function isOrdinary(state: StateName): boolean {
  return state === 'start' || state === 'append';
}

/** Section 9.4: levels 3 are user-waiting, everything below is critical path. */
export function priorityReason(level: number): 'user_waiting' | 'critical_path' {
  return level >= 3 ? 'user_waiting' : 'critical_path';
}

export function isManageHint(hint: unknown): boolean {
  if (!hint || typeof hint !== 'object') return false;
  const context = (hint as Record<string, unknown>)['context_management'];
  return (
    !!context &&
    typeof context === 'object' &&
    (context as Record<string, unknown>)['manage_request'] === true
  );
}

const TOP_LEVEL = [
  'session',
  'context_management',
  'priority_control',
  'cache_control',
];

/** Return every contract violation found in `hint`. */
export function validate(hint: unknown): string[] {
  const errors: string[] = [];
  if (!hint || typeof hint !== 'object' || Array.isArray(hint)) {
    return ['hint must be a JSON object'];
  }
  const object = hint as Record<string, unknown>;

  for (const key of Object.keys(object)) {
    if (!TOP_LEVEL.includes(key)) {
      errors.push(`unexpected top-level key: ${JSON.stringify(key)}`);
    }
  }

  const session = object['session'];
  if (!session || typeof session !== 'object' || Array.isArray(session)) {
    errors.push('session is required and must be an object');
    return errors;
  }
  validateSession(session as Record<string, unknown>, errors);

  if ('context_management' in object) {
    validateContext(object['context_management'], errors);
  }

  const manage = isManageHint(hint);

  if (manage) {
    const state = (session as Record<string, unknown>)['state'];
    if (typeof state !== 'string' || !MANAGE_STATES.includes(state as StateName)) {
      errors.push(
        `manage request state must be one of pause/resume/stop/compact, got ${JSON.stringify(state)}`,
      );
    } else {
      const expected = editFor(state as StateName);
      const edits = (object['context_management'] as Record<string, unknown>)[
        'edits'
      ];
      const actual = Array.isArray(edits)
        ? (edits[0] as Record<string, unknown> | undefined)?.['type']
        : undefined;
      if (actual !== expected) {
        errors.push(
          `edits[0].type must be ${JSON.stringify(expected)} for state ${JSON.stringify(state)}`,
        );
      }
    }
    for (const forbidden of ['priority_control', 'cache_control']) {
      if (forbidden in object) {
        errors.push(`${forbidden} MUST NOT appear on a manage request`);
      }
    }
    return errors;
  }

  if ('context_management' in object) {
    errors.push('context_management MUST NOT appear on an ordinary request');
  }

  if ('priority_control' in object) {
    const control = object['priority_control'];
    if (!control || typeof control !== 'object' || Array.isArray(control)) {
      errors.push('priority_control must be an object');
    } else {
      const priority = (control as Record<string, unknown>)['priority'];
      if (!priority || typeof priority !== 'object') {
        errors.push('priority_control.priority must be an object');
      } else {
        const level = (priority as Record<string, unknown>)['level'];
        const reason = (priority as Record<string, unknown>)['reason'];
        if (!Number.isInteger(level) || (level as number) < 0 || (level as number) > 3) {
          errors.push('priority.level must be an integer in 0..3');
        } else if (reason !== priorityReason(level as number)) {
          errors.push(
            `priority.reason must be ${JSON.stringify(priorityReason(level as number))} for level ${level}`,
          );
        }
      }
    }
  }

  if ('cache_control' in object) {
    const cache = object['cache_control'];
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) {
      errors.push('cache_control must be an object');
    } else {
      const record = cache as Record<string, unknown>;
      if (record['type'] !== 'ephemeral') {
        errors.push('cache_control.type must be "ephemeral"');
      }
      const ttl = record['ttl_s'];
      if (
        !Number.isInteger(ttl) ||
        (ttl as number) < TTL_MIN_S ||
        (ttl as number) > TTL_MAX_S
      ) {
        errors.push(`cache_control.ttl_s must be an integer in ${TTL_MIN_S}..${TTL_MAX_S}`);
      }
      const offset = record['msg_offset'];
      if (!Number.isInteger(offset) || (offset as number) < 1) {
        errors.push('cache_control.msg_offset must be an integer >= 1');
      }
    }
  }

  return errors;
}

function validateSession(
  session: Record<string, unknown>,
  errors: string[],
): void {
  const allowed = [
    'session_id',
    'call_index',
    'epoch',
    'state',
    'parent_session_id',
  ];
  for (const key of Object.keys(session)) {
    if (!allowed.includes(key)) errors.push(`unexpected session key: ${key}`);
  }
  const id = session['session_id'];
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) {
    errors.push('session_id must be a non-empty string <= 256 chars');
  }
  const callIndex = session['call_index'];
  if (!Number.isInteger(callIndex) || (callIndex as number) < 1) {
    errors.push('call_index must be an integer >= 1');
  }
  if (!Number.isInteger(session['epoch']) || (session['epoch'] as number) < 0) {
    errors.push('epoch must be an integer >= 0');
  }
  const state = session['state'];
  if (
    typeof state !== 'string' ||
    ![...MANAGE_STATES, 'start', 'append'].includes(state)
  ) {
    errors.push(`unknown state: ${JSON.stringify(state)}`);
  }
}

function validateContext(value: unknown, errors: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push('context_management must be an object');
    return;
  }
  const context = value as Record<string, unknown>;
  for (const key of Object.keys(context)) {
    if (!['manage_request', 'edits'].includes(key)) {
      errors.push(`unexpected context_management key: ${key}`);
    }
  }
  if (typeof context['manage_request'] !== 'boolean') {
    errors.push('context_management.manage_request must be a boolean');
  }
  const edits = context['edits'];
  if (!Array.isArray(edits) || edits.length !== 1) {
    errors.push('context_management.edits must contain exactly one edit');
    return;
  }
  const edit = edits[0];
  if (!edit || typeof edit !== 'object') {
    errors.push('context_management.edits[0] must be an object');
    return;
  }
  const record = edit as Record<string, unknown>;
  if (record['target'] !== 'session') {
    errors.push('context_management.edits[0].target must be "session"');
  }
  if (!['offload', 'prefetch', 'evict'].includes(record['type'] as string)) {
    errors.push('context_management.edits[0].type must be offload/prefetch/evict');
  }
}
