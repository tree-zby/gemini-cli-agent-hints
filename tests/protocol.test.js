import assert from 'node:assert/strict';
import test from 'node:test';

import { decode, encode } from '../dist/encoder.js';
import {
  HEADER_NAME,
  MAX_HEADER_BYTES,
  priorityReason,
  validate,
} from '../dist/protocol.js';

const minimalStart = {
  session: { session_id: 'ah-1', call_index: 1, epoch: 0, state: 'start' },
};

test('the header name matches the contract', () => {
  assert.equal(HEADER_NAME, 'X-Agent-Hint');
});

test('encodes without padding and round-trips', () => {
  const encoded = encode(minimalStart);
  assert.equal(encoded.includes('='), false);
  assert.deepEqual(decode(encoded), minimalStart);
});

test('accepts a minimal start hint', () => {
  assert.deepEqual(validate(minimalStart), []);
});

test('rejects unknown top-level and session keys', () => {
  assert.equal(validate({ ...minimalStart, extra: 1 }).length, 1);
  assert.equal(
    validate({
      session: { ...minimalStart.session, unknown: true },
    }).length,
    1,
  );
});

test('rejects a context_management block on an ordinary request', () => {
  const errors = validate({
    ...minimalStart,
    context_management: { manage_request: false, edits: [] },
  });
  assert.ok(errors.some((e) => e.includes('MUST NOT appear')));
});

test('rejects priority or cache on a manage request', () => {
  const manage = {
    session: { session_id: 'ah-1', call_index: 2, epoch: 0, state: 'pause' },
    context_management: {
      manage_request: true,
      edits: [{ type: 'offload', target: 'session' }],
    },
  };
  assert.deepEqual(validate(manage), []);
  assert.equal(
    validate({ ...manage, priority_control: { priority: { level: 1 } } }).length,
    1,
  );
  assert.equal(
    validate({
      ...manage,
      cache_control: { type: 'ephemeral', ttl_s: 600, msg_offset: 1 },
    }).length,
    1,
  );
});

test('rejects the wrong edit for the state', () => {
  const errors = validate({
    session: { session_id: 'ah-1', call_index: 2, epoch: 0, state: 'pause' },
    context_management: {
      manage_request: true,
      edits: [{ type: 'evict', target: 'session' }],
    },
  });
  assert.ok(errors.some((e) => e.includes('offload')));
});

test('rejects mismatched priority pairs and bad ttl', () => {
  assert.equal(priorityReason(3), 'user_waiting');
  assert.equal(priorityReason(1), 'critical_path');
  assert.equal(
    validate({
      ...minimalStart,
      priority_control: { priority: { level: 3, reason: 'critical_path' } },
    }).length,
    1,
  );
  assert.equal(
    validate({
      ...minimalStart,
      cache_control: { type: 'ephemeral', ttl_s: 30, msg_offset: 2 },
    }).length,
    1,
  );
  assert.equal(
    validate({
      ...minimalStart,
      cache_control: { type: 'ephemeral', ttl_s: 600, msg_offset: 2 },
    }).length,
    0,
  );
});

test('refuses hints above the header budget', () => {
  const huge = {
    ...minimalStart,
    session: { ...minimalStart.session, session_id: 'x'.repeat(MAX_HEADER_BYTES) },
  };
  assert.throws(() => encode(huge), /budget/);
});
