/**
 * Strict reader for the `BeforeModel` hook payload.
 *
 * Gemini CLI sends the hook a text-only projection of the request
 * (`llm_request.messages`) plus, with `patches/0001`, `before_model_meta` with
 * the real `contents` length and a tool-part flag. Everything here is lenient:
 * unknown or missing fields degrade to "send no hint", never to a failure.
 */

export type HookRole = 'user' | 'model' | 'system';

export interface HookMessage {
  role?: string;
  content?: unknown;
}

export interface HookLlmRequest {
  model?: string;
  messages?: HookMessage[];
  config?: Record<string, unknown>;
}

export interface BeforeModelMeta {
  wire_message_count?: number;
  has_tool_parts?: boolean;
}

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  timestamp?: string;
  before_model_meta?: BeforeModelMeta;
  llm_request?: HookLlmRequest;
}

/** Flatten a hook message's content into plain text. */
export function messageText(message: HookMessage): string {
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const text = (part as Record<string, unknown>)['text'];
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('');
}
