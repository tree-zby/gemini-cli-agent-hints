import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { handleBeforeModel } from '../dist/adapter.js';
import { readConfig } from '../dist/config.js';
import { decode } from '../dist/encoder.js';
import { HEADER_NAME } from '../dist/protocol.js';
import { FileStore, sessionKey } from '../dist/store.js';

function configFor(dir, overrides = {}) {
  return {
    ...readConfig({ GEMINI_AGENT_HINTS_DIR: dir }),
    stateDir: dir,
    cacheMinPrefixTokens: 1,
    defaultTtlS: 600,
    ...overrides,
  };
}

function hookInput(overrides = {}) {
  return {
    session_id: 'cli-session-1',
    transcript_path: '/tmp/transcript.json',
    cwd: '/work',
    hook_event_name: 'BeforeModel',
    timestamp: '2026-01-01T00:00:00.000Z',
    before_model_meta: { wire_message_count: 1, has_tool_parts: false },
    llm_request: {
      model: 'gemini-2.5-flash',
      messages: [{ role: 'user', content: 'hello there' }],
    },
    ...overrides,
  };
}

function headerHint(result) {
  const raw = result.headers[HEADER_NAME];
  assert.ok(raw, `expected ${HEADER_NAME}, got ${JSON.stringify(result)}`);
  return decode(raw);
}

test('the first hook call starts a session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  const result = handleBeforeModel(hookInput(), { config });
  const hint = headerHint(result);
  assert.equal(hint.session.state, 'start');
  assert.equal(hint.session.call_index, 1);
  assert.equal(hint.cache_control.msg_offset, 1);
  assert.equal(hint.priority_control.priority.level, 3);
});

test('the hint describes the wire, not the text projection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  handleBeforeModel(hookInput(), { config });
  const result = handleBeforeModel(
    hookInput({
      // Two text messages in the projection, six wire contents: the hint must
      // describe the wire count (protocol V-02), not the projection.
      before_model_meta: { wire_message_count: 6, has_tool_parts: true },
      llm_request: {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'hello there' },
          { role: 'model', content: 'calling a tool' },
        ],
      },
    }),
    { config },
  );
  const hint = headerHint(result);
  assert.equal(hint.session.state, 'append');
  assert.equal(hint.cache_control.msg_offset, 6);
});

test('the next call appends, and a tool loop is critical path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  handleBeforeModel(hookInput(), { config });
  const result = handleBeforeModel(
    hookInput({
      before_model_meta: { wire_message_count: 5, has_tool_parts: true },
      llm_request: {
        model: 'gemini-2.5-flash',
        messages: [
          { role: 'user', content: 'hello there' },
          { role: 'model', content: 'running a tool' },
        ],
      },
    }),
    { config },
  );
  const hint = headerHint(result);
  assert.equal(hint.session.state, 'append');
  assert.equal(hint.session.call_index, 2);
  assert.equal(hint.priority_control.priority.level, 1);
  assert.equal(hint.priority_control.priority.reason, 'critical_path');
});

test('a retried hook invocation reuses the same hint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  const first = handleBeforeModel(hookInput(), { config });
  const retry = handleBeforeModel(hookInput(), { config });
  assert.equal(retry.headers[HEADER_NAME], first.headers[HEADER_NAME]);
});

test('the plugin can be switched off entirely', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir, { enabled: false });
  const result = handleBeforeModel(hookInput(), { config });
  assert.deepEqual(result.headers, {});
  assert.equal(result.reason, 'disabled');
});

test('a corrupt state file is quarantined, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  const store = new FileStore(dir);
  const key = sessionKey(
    'cli-session-1',
    'hello there',
  );
  store.save(key, {
    session_id: 'ah-old',
    call_index: 7,
    epoch: 0,
    first_accepted: true,
    started: true,
    isolated: false,
    after_rewrite: false,
    last_outcome: 'pending',
  });
  writeFileSync(join(dir, `${key}.json`), '{not json', 'utf8');

  const result = handleBeforeModel(hookInput(), { config, store });
  const hint = headerHint(result);
  assert.equal(hint.session.state, 'start');
  assert.equal(hint.session.call_index, 1);
});

test('main chat and subagent share a session id but not a hint session', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-adapter-'));
  const config = configFor(dir);
  const main = handleBeforeModel(hookInput(), { config });
  const subagent = handleBeforeModel(
    hookInput({
      llm_request: {
        model: 'gemini-2.5-flash',
        messages: [{ role: 'user', content: 'summarise this file: x' }],
      },
    }),
    { config },
  );
  const first = headerHint(main);
  const second = headerHint(subagent);
  assert.notEqual(first.session.session_id, second.session.session_id);
  assert.equal(second.session.state, 'start');
  assert.equal(second.session.call_index, 1);
});
