#!/usr/bin/env node
/**
 * The executable. Everything it does is wire the process to `run` — kept apart
 * from `cli.ts` so the test suite can drive the CLI without a process to exit.
 */

import { writeFileSync } from 'node:fs';
import { run } from './cli.js';

run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout: (text) => process.stdout.write(`${text}\n`),
  stderr: (text) => process.stderr.write(`${text}\n`),
  now: new Date(),
  isTty: process.stdout.isTTY === true,
  writeFile: (path, content) => writeFileSync(path, content, 'utf8'),
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`aiusage: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
