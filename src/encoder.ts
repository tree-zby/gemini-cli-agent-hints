/**
 * Base64url codec for the `X-Agent-Hint` header (protocol section 3.2).
 *
 * Node's `base64url` mode is used everywhere; decoders also accept padding.
 */

import { MAX_HEADER_BYTES } from './protocol.js';

export class EncodeError extends Error {}
export class DecodeError extends Error {}

/** Serialise a hint: UTF-8 JSON -> base64url without padding. */
export function encode(hint: unknown): string {
  const raw = JSON.stringify(hint);
  const encoded = Buffer.from(raw, 'utf8').toString('base64url');
  if (encoded.length > MAX_HEADER_BYTES) {
    throw new EncodeError(
      `encoded hint is ${encoded.length} bytes, above the ${MAX_HEADER_BYTES}-byte budget`,
    );
  }
  return encoded;
}

/** Decode a header value. Padded and unpadded base64url are both accepted. */
export function decode(value: string): Record<string, unknown> {
  const text = value.trim();
  if (!text) throw new DecodeError('header value is empty');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
  } catch (error) {
    throw new DecodeError(
      `invalid base64url payload: ${(error as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DecodeError('hint payload must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}
