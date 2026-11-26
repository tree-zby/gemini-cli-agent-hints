import assert from 'node:assert/strict';
import test from 'node:test';

import { HintSession, defaultConfig, deriveTurnOpening } from '../dist/state.js';

function view(overrides = {}) {
  return {
    messages: [{ role: 'user', text: 'hello there' }],
    model: 'gemini-2.5-flash',
    tools: [],
    auxiliary: false,
    ...overrides,
  };
}

test('the first accepted-able call is a start, the next is an append', () => {
  const session = new HintSession('ah-1', defaultConfig());
  const first = session.build(view());
  assert.equal(first.session.state, 'start');
  assert.equal(first.session.call_index, 1);
  assert.equal(first.session.epoch, 0);

  const second = session.build(
    view({ messages: [
      { role: 'user', text: 'hello there' },
      { role: 'model', text: 'hi' },
      { role: 'user', text: 'again' },
    ] }),
  );
  assert.equal(second.session.state, 'append');
  assert.equal(second.session.call_index, 2);
});

test('a retry reuses the exact hint until accepted', () => {
  const session = new HintSession('ah-1', defaultConfig());
  const first = session.build(view());
  const retry = session.build(view());
  assert.equal(retry, first);
  assert.equal(session.callIndex, 1);
});

test('a byte-identical prefix keeps the cache hint, a changed model drops it', () => {
  const config = { ...defaultConfig(), cacheMinPrefixTokens: 1 };
  const session = new HintSession('ah-1', config);
  session.build(view());
  const second = session.build(
    view({
      messages: [
        { role: 'user', text: 'hello there' },
        { role: 'model', text: 'hi' },
      ],
    }),
  );
  assert.ok(second.cache_control);
  const switched = session.build(
    view({
      model: 'gemini-2.5-pro',
      messages: [{ role: 'user', text: 'other' }],
    }),
  );
  assert.equal(switched.cache_control, undefined);
});

test('a rewrite bumps the epoch and suppresses the first cache block', () => {
  const config = { ...defaultConfig(), cacheMinPrefixTokens: 1 };
  const session = new HintSession('ah-1', config);
  session.build(view());
  assert.equal(session.noteRewrite(), 0);
  const after = session.build(
    view({ messages: [{ role: 'user', text: 'fresh history' }] }),
  );
  assert.equal(after.session.epoch, 1);
  assert.equal(after.cache_control, undefined);
  const next = session.build(
    view({
      messages: [
        { role: 'user', text: 'fresh history' },
        { role: 'model', text: 'ok' },
      ],
    }),
  );
  assert.ok(next.cache_control);
});

test('auxiliary calls never carry a hint', () => {
  const session = new HintSession('ah-1', defaultConfig());
  assert.equal(session.build(view({ auxiliary: true })), undefined);
  assert.equal(session.callIndex, 0);
});

test('an isolated session stays silent until it is cleared', () => {
  const session = new HintSession('ah-1', defaultConfig());
  session.isolate();
  assert.equal(session.build(view()), undefined);
  session.clearIsolation();
  assert.ok(session.build(view()));
});

test('the default config omits the cache until the prefix is long enough', () => {
  const session = new HintSession('ah-1', defaultConfig());
  const hint = session.build(view({ messages: [{ role: 'user', text: 'hi' }] }));
  assert.equal(hint.cache_control, undefined);
});

test('snapshots round-trip every mutable fact', () => {
  const session = new HintSession('ah-1', defaultConfig());
  session.build(view());
  const restored = HintSession.fromSnapshot(session.toSnapshot(), defaultConfig());
  const next = restored.build(
    view({
      messages: [
        { role: 'user', text: 'hello there' },
        { role: 'model', text: 'hi' },
      ],
    }),
  );
  assert.equal(next.session.call_index, 2);
  assert.equal(next.session.state, 'append');
});

test('tool parts mean the turn is a continuation, not an opening', () => {
  assert.equal(
    deriveTurnOpening([
      { role: 'user', text: 'list files' },
      { role: 'model', text: '', hasToolCall: true },
      { role: 'user', text: '', hasToolResult: true },
    ]),
    false,
  );
  assert.equal(deriveTurnOpening([{ role: 'user', text: 'new turn' }]), true);
});

test('TTL bounds are enforced at construction', () => {
  assert.throws(
    () => new HintSession('ah-1', { ...defaultConfig(), defaultTtlS: 10 }),
    /TTL/,
  );
});
