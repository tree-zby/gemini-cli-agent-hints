#!/usr/bin/env node
/**
 * Stable-path shim for the `BeforeModel` hook.
 *
 * Equivalent to `node dist/cli.js hook`; useful when settings.json should not
 * depend on the build layout.
 */
import { readFileSync } from 'node:fs';

import { runHook } from '../dist/cli.js';

process.stdout.write(`${runHook(readFileSync(0, 'utf8'))}\n`);
