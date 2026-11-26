/**
 * Environment-driven configuration.
 *
 * Every knob has a safe default and the whole plugin can be switched off with
 * one variable, because the hook runs inside the user's model path.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import { TTL_MAX_S, TTL_MIN_S } from './protocol.js';
import type { Derive } from './state.js';

export interface PluginConfig {
  enabled: boolean;
  stateDir: string;
  priority: Derive;
  cache: Derive;
  priorityLevel?: number;
  defaultTtlS: number;
  ttlMinS: number;
  ttlMaxS: number;
  cacheMinPrefixTokens: number;
  debug: boolean;
}

function asBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  if (['1', 'true', 'on', 'yes'].includes(value)) return true;
  return fallback;
}

function asInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['GEMINI_AGENT_HINTS_DIR']?.trim();
  if (explicit) return explicit;
  const home = env['HOME'] || env['USERPROFILE'] || homedir();
  return join(home, '.gemini', 'agent-hints');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): PluginConfig {
  const enabled = asBool(env['GEMINI_AGENT_HINTS'], true);

  const priorityRaw = (env['GEMINI_AGENT_HINTS_PRIORITY'] ?? 'dynamic')
    .trim()
    .toLowerCase();
  const priority: Derive = priorityRaw === 'omit' ? 'omit' : 'dynamic';
  const cacheRaw = (env['GEMINI_AGENT_HINTS_CACHE'] ?? 'dynamic')
    .trim()
    .toLowerCase();
  const cache: Derive = cacheRaw === 'omit' ? 'omit' : 'dynamic';

  let priorityLevel: number | undefined;
  if (['0', '1', '2', '3'].includes(priorityRaw)) {
    priorityLevel = Number(priorityRaw);
  }

  const ttlMinS = TTL_MIN_S;
  const ttlMaxS = TTL_MAX_S;
  const defaultTtlS = Math.min(
    ttlMaxS,
    Math.max(ttlMinS, asInt(env['GEMINI_AGENT_HINTS_TTL_S'], 600)),
  );

  return {
    enabled,
    stateDir: defaultStateDir(env),
    priority,
    cache,
    priorityLevel,
    defaultTtlS,
    ttlMinS,
    ttlMaxS,
    cacheMinPrefixTokens: Math.max(
      1,
      asInt(env['GEMINI_AGENT_HINTS_MIN_PREFIX_TOKENS'], 128),
    ),
    debug: asBool(env['GEMINI_AGENT_HINTS_DEBUG'], false),
  };
}
