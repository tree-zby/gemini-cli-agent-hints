/**
 * File-backed session store.
 *
 * The sender runs as a short-lived hook process, so every hint needs its state
 * on disk before the process exits. Files are written atomically (tmp + rename)
 * and keyed by a hash of `(host session id, conversation root)`: Gemini CLI
 * hands the same `session_id` to the main chat and to every subagent, while
 * their conversations are unrelated.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { SessionSnapshot } from './state.js';

/** Keep the store bounded; the oldest entries are pruned past this. */
export const MAX_SESSIONS = 256;

export function sessionKey(hostSessionId: string, conversationRoot: string): string {
  return createHash('sha256')
    .update(`${hostSessionId}\u0000${conversationRoot}`)
    .digest('hex')
    .slice(0, 32);
}

/**
 * The first user/system text of the conversation.
 *
 * Gemini CLI gives subagents the parent's session id, so this is what separates
 * the main chat from a subagent run. A committed history rewrite changes the
 * root, which correctly starts a new logical session.
 */
export function conversationRoot(texts: readonly string[]): string {
  return texts[0] ?? '';
}

export interface StoredSession {
  key: string;
  snapshot: SessionSnapshot;
  updatedAt: number;
}

export class FileStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // best effort on filesystems without POSIX modes
    }
  }

  private pathFor(key: string): string {
    return join(this.dir, `${key}.json`);
  }

  load(key: string): SessionSnapshot | undefined {
    const path = this.pathFor(key);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
      const snapshot = parsed as SessionSnapshot;
      if (typeof snapshot.session_id !== 'string' || !snapshot.session_id) {
        throw new Error('missing session_id');
      }
      return snapshot;
    } catch {
      // Never let a corrupt file break a model call: quarantine and move on.
      try {
        renameSync(path, `${path}.corrupt`);
      } catch {
        // ignore
      }
      return undefined;
    }
  }

  save(key: string, snapshot: SessionSnapshot): void {
    this.ensureDir();
    const path = this.pathFor(key);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
    this.prune();
  }

  list(): StoredSession[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const sessions: StoredSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      const snapshot = this.load(key);
      if (!snapshot) continue;
      let updatedAt = 0;
      try {
        updatedAt = statSync(this.pathFor(key)).mtimeMs;
      } catch {
        // ignore
      }
      sessions.push({ key, snapshot, updatedAt });
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }

  remove(key: string): boolean {
    try {
      unlinkSync(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  private prune(): void {
    const sessions = this.list();
    for (const stale of sessions.slice(MAX_SESSIONS)) {
      this.remove(stale.key);
    }
  }
}
