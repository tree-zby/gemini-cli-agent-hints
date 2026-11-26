/**
 * Manage requests (protocol sections 8-9).
 *
 * Lifecycle verbs never ride an ordinary model call: each one is its own HTTP
 * request carrying a hint with `context_management.manage_request = true` and
 * exactly one edit. The body is a protocol placeholder, because a manage
 * request is never meant to produce tokens.
 */

import { encode } from './encoder.js';
import type { Hint, StateName } from './protocol.js';
import { HEADER_NAME, validate } from './protocol.js';
import { HintSession, defaultConfig } from './state.js';
import type { StoredSession } from './store.js';

export const MANAGE_BODY_PLACEHOLDER = '.';

export interface ManageTarget {
  key: string;
  hint: Hint;
  header: string;
}

/** Build one manage hint from a stored session snapshot. */
export function buildManageHint(
  stored: StoredSession,
  verb: StateName,
  callIndex?: number,
): ManageTarget {
  const session = HintSession.fromSnapshot(stored.snapshot, defaultConfig());
  const hint = session.buildManage(verb, callIndex ?? stored.snapshot.call_index + 1);
  const errors = validate(hint);
  if (errors.length > 0) {
    throw new Error(`invalid manage hint for ${stored.key}: ${errors.join('; ')}`);
  }
  return { key: stored.key, hint, header: encode(hint) };
}

export interface ManageTransport {
  baseUrl: string;
  model: string;
  authHeaders: Record<string, string>;
}

/** Reuse whatever authentication the host already has for model calls. */
export function resolveTransport(
  env: NodeJS.ProcessEnv = process.env,
): { transport?: ManageTransport; reason?: string } {
  const baseUrl = (
    env['GOOGLE_GEMINI_BASE_URL'] ||
    env['GEMINI_AGENT_HINTS_BASE_URL'] ||
    'https://generativelanguage.googleapis.com'
  ).replace(/\/+$/, '');
  const model =
    env['GEMINI_AGENT_HINTS_MODEL']?.trim() || 'gemini-2.5-flash';

  const apiKey = env['GEMINI_API_KEY'] || env['GOOGLE_API_KEY'];
  if (apiKey) {
    return {
      transport: { baseUrl, model, authHeaders: { 'x-goog-api-key': apiKey } },
    };
  }
  const bearer = env['GEMINI_AGENT_HINTS_BEARER'];
  if (bearer) {
    return {
      transport: {
        baseUrl,
        model,
        authHeaders: { Authorization: `Bearer ${bearer}` },
      },
    };
  }
  return {
    reason:
      'no reusable credential: set GEMINI_API_KEY / GOOGLE_API_KEY, or GEMINI_AGENT_HINTS_BEARER for other auth modes',
  };
}

export interface ManageSendResult {
  key: string;
  status?: number;
  ok: boolean;
  error?: string;
}

/**
 * POST one manage hint.
 *
 * The placeholder body is a single `.` part: the Gemini API rejects empty
 * `contents`, while the protocol only requires that the request is recognisable
 * as a manage request from its hint.
 */
export async function sendManage(
  target: ManageTarget,
  transport: ManageTransport,
  fetchImpl: typeof fetch = fetch,
): Promise<ManageSendResult> {
  const url = `${transport.baseUrl}/v1beta/models/${encodeURIComponent(
    transport.model,
  )}:generateContent`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [HEADER_NAME]: target.header,
        ...transport.authHeaders,
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: MANAGE_BODY_PLACEHOLDER }] },
        ],
        generationConfig: { maxOutputTokens: 1 },
      }),
    });
    return { key: target.key, status: response.status, ok: response.ok };
  } catch (error) {
    return { key: target.key, ok: false, error: (error as Error).message };
  }
}
