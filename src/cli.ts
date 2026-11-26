#!/usr/bin/env node
/**
 * `gemini-agent-hints` command line.
 *
 *   gemini-agent-hints hook          # invoked by the BeforeModel hook
 *   gemini-agent-hints status [--json]
 *   gemini-agent-hints manage <pause|resume|stop|compact> [--all|--key K] [--dry-run]
 *   gemini-agent-hints reset [--all|--key K]
 *
 * The `hook` subcommand is the only one on the hot path: it must always exit 0
 * and always print a JSON object, because Gemini CLI treats a malformed hook
 * response as a failed model call.
 */

import { readFileSync } from 'node:fs';

import { handleBeforeModel } from './adapter.js';
import { readConfig } from './config.js';
import type { HookInput } from './hook-input.js';
import {
  buildManageHint,
  resolveTransport,
  sendManage,
} from './manage.js';
import { MANAGE_STATES, type StateName } from './protocol.js';
import { FileStore } from './store.js';

const VERSION = '0.1.0';

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

/** `hook` subcommand: silent on every failure, never throws. */
export function runHook(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return '{}';
  }
  if (!parsed || typeof parsed !== 'object') return '{}';

  try {
    const result = handleBeforeModel(parsed as HookInput);
    if (result.reason && readConfig().debug) {
      process.stderr.write(`agent-hints: ${result.reason}\n`);
    }
    if (Object.keys(result.headers).length === 0) return '{}';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'BeforeModel',
        http_headers: result.headers,
      },
    });
  } catch (error) {
    try {
      process.stderr.write(`agent-hints: ${(error as Error).message}\n`);
    } catch {
      // ignore
    }
    return '{}';
  }
}

function parseFlags(argv: string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(arg.slice(2), next);
      i += 1;
    } else {
      flags.set(arg.slice(2), true);
    }
  }
  return flags;
}

function storeFor(): FileStore {
  return new FileStore(readConfig().stateDir);
}

function selectTargets(
  store: FileStore,
  flags: Map<string, string | true>,
): ReturnType<FileStore['list']> {
  const sessions = store.list();
  const key = flags.get('key');
  if (typeof key === 'string') {
    const match = sessions.find((s) => s.key === key);
    return match ? [match] : [];
  }
  const session = flags.get('session');
  if (typeof session === 'string') {
    return sessions.filter((s) => s.snapshot.session_id === session);
  }
  if (flags.get('all') === true) return sessions;
  // Default: the session touched most recently.
  return sessions.slice(0, 1);
}

async function main(argv: string[]): Promise<number> {
  const command = argv[0] ?? '--help';

  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(
      [
        'gemini-agent-hints — Agent Hint protocol sender for Gemini CLI',
        '',
        'Usage:',
        '  gemini-agent-hints hook',
        '  gemini-agent-hints status [--json]',
        '  gemini-agent-hints manage <pause|resume|stop|compact> [--all|--key K] [--dry-run]',
        '  gemini-agent-hints reset [--all|--key K]',
        '',
        'Environment:',
        '  GEMINI_AGENT_HINTS=off            disable the hook entirely',
        '  GEMINI_AGENT_HINTS_DIR=<path>     state directory (default ~/.gemini/agent-hints)',
        '  GEMINI_AGENT_HINTS_PRIORITY=omit|0..3',
        '  GEMINI_AGENT_HINTS_CACHE=omit',
        '  GEMINI_AGENT_HINTS_TTL_S=600',
        '  GEMINI_AGENT_HINTS_MODEL=<model>  model used for manage requests',
        '',
      ].join('\n'),
    );
    return 0;
  }

  if (command === 'hook') {
    process.stdout.write(`${runHook(readStdin())}\n`);
    return 0;
  }

  if (command === 'status') {
    const config = readConfig();
    const sessions = storeFor().list();
    const summary = {
      enabled: config.enabled,
      state_dir: config.stateDir,
      priority: config.priority,
      cache: config.cache,
      sessions: sessions.map((session) => ({
        key: session.key,
        session_id: session.snapshot.session_id,
        call_index: session.snapshot.call_index,
        epoch: session.snapshot.epoch,
        started: session.snapshot.started,
        last_model: session.snapshot.last_model,
        updated_at: new Date(session.updatedAt).toISOString(),
      })),
    };
    if (argv.includes('--json')) {
      writeJson(summary);
    } else {
      process.stdout.write(
        `enabled: ${summary.enabled}\nstate:   ${summary.state_dir}\nsessions: ${summary.sessions.length}\n`,
      );
      for (const session of summary.sessions) {
        process.stdout.write(
          `  ${session.key}  ${session.session_id}  call=${session.call_index} epoch=${session.epoch} ${session.updated_at}\n`,
        );
      }
    }
    return 0;
  }

  if (command === 'reset') {
    const store = storeFor();
    const targets = selectTargets(store, parseFlags(argv.slice(1)));
    for (const target of targets) store.remove(target.key);
    writeJson({ removed: targets.map((target) => target.key) });
    return 0;
  }

  if (command === 'manage') {
    const verb = argv[1] as StateName | undefined;
    if (!verb || !MANAGE_STATES.includes(verb)) {
      process.stderr.write(
        `usage: gemini-agent-hints manage <${MANAGE_STATES.join('|')}>\n`,
      );
      return 2;
    }
    const flags = parseFlags(argv.slice(2));
    const store = storeFor();
    const targets = selectTargets(store, flags);
    if (targets.length === 0) {
      writeJson({ sent: [], reason: 'no stored session' });
      return 0;
    }
    const built = targets.map((target) => buildManageHint(target, verb));

    if (flags.get('dry-run') === true) {
      writeJson({
        dry_run: true,
        hints: built.map((target) => ({ key: target.key, hint: target.hint })),
      });
      return 0;
    }

    const resolved = resolveTransport();
    if (!resolved.transport) {
      // Degrade to L1 rather than fail: the lifecycle intent is recorded.
      process.stderr.write(`agent-hints: manage skipped — ${resolved.reason}\n`);
      writeJson({
        sent: [],
        degraded: true,
        reason: resolved.reason,
        hints: built.map((target) => ({ key: target.key, hint: target.hint })),
      });
      return 0;
    }

    const results = [];
    for (const target of built) {
      results.push(await sendManage(target, resolved.transport));
    }
    writeJson({ sent: results });
    return results.every((result) => result.ok) ? 0 : 1;
  }

  process.stderr.write(`unknown command: ${command}\n`);
  return 2;
}

const isMain =
  process.argv[1] !== undefined &&
  /cli\.(js|ts)$/.test(process.argv[1].replace(/\\/g, '/'));

if (isMain) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`agent-hints: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}
