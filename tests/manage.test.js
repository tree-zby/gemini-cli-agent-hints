import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MANAGE_BODY_PLACEHOLDER,
  buildManageHint,
  resolveTransport,
  sendManage,
} from '../dist/manage.js';
import { decode } from '../dist/encoder.js';
import { HEADER_NAME } from '../dist/protocol.js';

const stored = {
  key: 'k1',
  updatedAt: Date.now(),
  snapshot: {
    session_id: 'ah-1',
    call_index: 3,
    epoch: 1,
    first_accepted: true,
    started: true,
    isolated: false,
    after_rewrite: false,
    last_outcome: 'accepted',
  },
};

test('each lifecycle verb carries exactly one matching edit', () => {
  const expected = {
    pause: 'offload',
    resume: 'prefetch',
    stop: 'evict',
    compact: 'evict',
  };
  for (const [verb, edit] of Object.entries(expected)) {
    const target = buildManageHint(stored, verb);
    const hint = decode(target.header);
    assert.equal(hint.session.state, verb);
    assert.equal(hint.context_management.manage_request, true);
    assert.deepEqual(hint.context_management.edits, [
      { type: edit, target: 'session' },
    ]);
    assert.equal(hint.priority_control, undefined);
    assert.equal(hint.cache_control, undefined);
    assert.equal(target.hint.session.call_index, 4);
  }
});

test('manage hints keep the session epoch', () => {
  const hint = decode(buildManageHint(stored, 'compact').header);
  assert.equal(hint.session.epoch, 1);
});

test('transport reuses an API key, then a bearer token, then degrades', () => {
  const withKey = resolveTransport({ GEMINI_API_KEY: 'k' });
  assert.equal(withKey.transport.authHeaders['x-goog-api-key'], 'k');
  assert.equal(
    withKey.transport.baseUrl,
    'https://generativelanguage.googleapis.com',
  );

  const withBearer = resolveTransport({ GEMINI_AGENT_HINTS_BEARER: 't' });
  assert.equal(withBearer.transport.authHeaders['Authorization'], 'Bearer t');

  const none = resolveTransport({});
  assert.equal(none.transport, undefined);
  assert.ok(none.reason.includes('no reusable credential'));
});

test('a manage request posts the hint with a placeholder body', async () => {
  const captured = {};
  const fakeFetch = async (url, init) => {
    captured.url = url;
    captured.init = init;
    return { ok: true, status: 200 };
  };
  const target = buildManageHint(stored, 'stop');
  const result = await sendManage(
    target,
    {
      baseUrl: 'http://127.0.0.1:9',
      model: 'gemini-2.5-flash',
      authHeaders: { 'x-goog-api-key': 'k' },
    },
    fakeFetch,
  );

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(
    captured.url,
    'http://127.0.0.1:9/v1beta/models/gemini-2.5-flash:generateContent',
  );
  assert.equal(captured.init.headers[HEADER_NAME], target.header);
  assert.equal(captured.init.headers['x-goog-api-key'], 'k');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.contents[0].parts[0].text, MANAGE_BODY_PLACEHOLDER);
});

test('a transport failure is reported, never thrown', async () => {
  const target = buildManageHint(stored, 'pause');
  const result = await sendManage(
    target,
    { baseUrl: 'http://127.0.0.1:9', model: 'm', authHeaders: {} },
    async () => {
      throw new Error('ECONNREFUSED');
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error, 'ECONNREFUSED');
});
