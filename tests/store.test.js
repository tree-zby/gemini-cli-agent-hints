import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  FileStore,
  MAX_SESSIONS,
  conversationRoot,
  sessionKey,
} from '../dist/store.js';

const snapshot = (id) => ({
  session_id: id,
  call_index: 1,
  epoch: 0,
  first_accepted: false,
  started: true,
  isolated: false,
  after_rewrite: false,
  last_outcome: 'pending',
});

test('the key separates conversations that share a host session id', () => {
  const main = sessionKey('cli-1', 'implement the feature');
  const subagent = sessionKey('cli-1', 'review this patch');
  assert.notEqual(main, subagent);
  assert.equal(main.length, 32);
});

test('the conversation root is the first user or system text', () => {
  assert.equal(conversationRoot(['first', 'second']), 'first');
  assert.equal(conversationRoot([]), '');
});

test('a saved session comes back byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-store-'));
  const store = new FileStore(dir);
  const key = sessionKey('cli-1', 'root');
  store.save(key, snapshot('ah-1'));
  assert.deepEqual(store.load(key), snapshot('ah-1'));
  assert.equal(store.list().length, 1);
});

test('a corrupt file is moved aside instead of breaking the hook', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-store-'));
  const store = new FileStore(dir);
  const key = sessionKey('cli-1', 'root');
  writeFileSync(join(dir, `${key}.json`), '{"session_id": ""}', 'utf8');
  assert.equal(store.load(key), undefined);
  assert.ok(existsSync(join(dir, `${key}.json.corrupt`)));
});

test('the store keeps at most MAX_SESSIONS entries', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-store-'));
  const store = new FileStore(dir);
  for (let i = 0; i < MAX_SESSIONS + 4; i += 1) {
    store.save(sessionKey('cli-1', `root-${i}`), snapshot(`ah-${i}`));
  }
  assert.equal(store.list().length, MAX_SESSIONS);
});

test('remove is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-store-'));
  const store = new FileStore(dir);
  const key = sessionKey('cli-1', 'root');
  store.save(key, snapshot('ah-1'));
  assert.equal(store.remove(key), true);
  assert.equal(store.remove(key), false);
});
