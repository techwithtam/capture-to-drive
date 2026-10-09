#!/usr/bin/env node
// Size probe for the Capture to Drive mailbox: how large a file can the Apps Script
// web app save reliably? Sends `save` requests with random bytes and prints one table row per request.
//
// WARNING: every request creates a real file in the Capture folder. They are named
// "TEST size probe <N>MB run <i>.bin"; delete them from Drive when the probe is done.
//
// Needs Node.js 22 (22.12 or newer), 24, or 26 and later, like the extension, and no packages. The mailbox URL
// and key come from environment variables only, so they never end up in a file or in the shell history of a
// command line:
//   MAILBOX_URL  the Web app /exec URL
//   MAILBOX_KEY  the mailbox key
// See mailbox/SETUP.md for the full procedure.

import { randomBytes, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const MIB = 1024 * 1024;
const DEFAULT_SIZES = '5,10,20,30';
const DEFAULT_RUNS = 3;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MIN_SIZE_MB = 0.001;
const MAX_SIZE_MB = 100;
const MAX_RUNS = 10;
// A cautious bound for a warning. The extension itself waits 60 s plus 10 s per MB (uploadTimeoutMs in
// extension/lib/queue.ts), but a file that takes a minute is already a poor fit.
const SLOW_RUN_SECONDS = 60;
const SAFE_FRACTION = 0.8;
const PROBE_DESCRIPTION = 'Size probe. Safe to delete.';

const USAGE = `Usage: node mailbox/tools/probe-size-limit.mjs --yes [options]

Saves random files of increasing size to the mailbox and reports what happened.
Every request creates a real file in the Capture folder (named "TEST size probe ...").

Environment (required):
  MAILBOX_URL   Web app /exec URL
  MAILBOX_KEY   mailbox key

Options:
  --yes             Confirm that real files may be created. Without it the probe sends nothing.
  --sizes <list>    Comma-separated sizes in MB, ${MIN_SIZE_MB} to ${MAX_SIZE_MB}. Default: ${DEFAULT_SIZES}
  --runs <n>        Requests per size, 1 to ${MAX_RUNS}. Default: ${DEFAULT_RUNS}
  --timeout <sec>   Give up on a request after this many seconds. Default: ${DEFAULT_TIMEOUT_SECONDS}
  -h, --help        Show this help.`;

class UsageError extends Error {}

function parseNumber(flag, text, { min, max, integer }) {
  const valid = /^\d+(\.\d+)?$/.test(text.trim());
  const value = valid ? Number(text) : NaN;
  if (!valid || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new UsageError(`${flag} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}, not "${text}".`);
  }
  return value;
}

function parseCli(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowPositionals: false,
      options: {
        yes: { type: 'boolean', default: false },
        sizes: { type: 'string', default: DEFAULT_SIZES },
        runs: { type: 'string', default: String(DEFAULT_RUNS) },
        timeout: { type: 'string', default: String(DEFAULT_TIMEOUT_SECONDS) },
        help: { type: 'boolean', short: 'h', default: false },
      },
    }));
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (values.help) {
    return { help: true };
  }

  const sizes = [...new Set(values.sizes.split(',').map((part) => parseNumber('--sizes', part, { min: MIN_SIZE_MB, max: MAX_SIZE_MB })))];
  return {
    help: false,
    yes: values.yes,
    sizes: sizes.map((size) => ({ mb: size, label: String(size), bytes: Math.round(size * MIB) })),
    runs: parseNumber('--runs', values.runs, { min: 1, max: MAX_RUNS, integer: true }),
    timeoutSeconds: parseNumber('--timeout', values.timeout, { min: 1, max: 3600 }),
  };
}

function parseMailboxUrl(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

function formatRow(sizeLabel, run, http, result, seconds) {
  return [sizeLabel.padStart(9), String(run).padStart(3), http.padStart(4), result.padEnd(13), seconds.padStart(7)].join('  ');
}

function snippet(text, key) {
  const flat = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  return flat.split(key).join('[key]');
}

/** Turns the response body into a table label plus an optional detail line. */
function classifyBody(text, key) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { result: 'non-JSON', detail: snippet(text, key) };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { result: 'unexpected', detail: snippet(text, key) };
  }
  if (parsed.ok === true) {
    return { result: 'ok' };
  }
  if (parsed.ok === false && typeof parsed.error === 'string') {
    return { result: parsed.error, detail: typeof parsed.message === 'string' ? snippet(parsed.message, key) : undefined };
  }
  return { result: 'unexpected', detail: snippet(text, key) };
}

async function probeOnce({ url, key, sizeLabel, bytes, run, timeoutSeconds }) {
  const body = JSON.stringify({
    v: 1,
    action: 'save',
    key,
    captureId: randomUUID(),
    filename: `TEST size probe ${sizeLabel}MB run ${run}.bin`,
    mimeType: 'application/octet-stream',
    description: PROBE_DESCRIPTION,
    data: randomBytes(bytes).toString('base64'),
  });

  const started = performance.now();
  const elapsed = () => ((performance.now() - started) / 1000).toFixed(2);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body,
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const text = await response.text();
    return { http: String(response.status), ...classifyBody(text, key), seconds: elapsed() };
  } catch (error) {
    if (error?.name === 'TimeoutError') {
      return { http: '-', result: 'timeout', seconds: elapsed() };
    }
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? 'unknown error';
    return { http: '-', result: 'network-error', detail: snippet(String(reason), key), seconds: elapsed() };
  }
}

function printSummary(outcomes, runs) {
  const saved = new Map();
  let slowest = 0;
  for (const outcome of outcomes) {
    if (outcome.result === 'ok') {
      saved.set(outcome.size.label, (saved.get(outcome.size.label) ?? 0) + 1);
      slowest = Math.max(slowest, Number(outcome.seconds));
    }
  }
  const reliable = [...new Set(outcomes.map((outcome) => outcome.size))].filter((size) => saved.get(size.label) === runs);

  console.log('');
  console.log(`Sent ${plural(outcomes.length, 'request')}; ${[...saved.values()].reduce((a, b) => a + b, 0)} saved.`);
  if (reliable.length === 0) {
    console.log('No size saved in every run, so there is no safe MAX_FILE_BYTES to suggest yet.');
  } else {
    const largest = reliable.reduce((a, b) => (b.mb > a.mb ? b : a));
    const suggested = Math.floor(largest.mb * SAFE_FRACTION * MIB);
    console.log(`Largest size that saved in every run: ${largest.label} MB.`);
    console.log(`About ${SAFE_FRACTION * 100}% of that is ${suggested} bytes. That is the value to use for MAX_FILE_BYTES (here and in the extension).`);
  }
  if (slowest > SLOW_RUN_SECONDS) {
    console.log(`The slowest saved run took ${slowest.toFixed(1)} s, over the cautious ${SLOW_RUN_SECONDS} s bound. ` +
      'The extension waits 60 s plus 10 s per MB before it retries, but uploads this slow are a poor fit. Choose a smaller size.');
  }
  console.log('');
  console.log('Next:');
  console.log('  1. In Drive, delete every file named "TEST size probe ..." from the Capture folder.');
  console.log('  2. In Apps Script > Project Settings > Script Properties, set MAX_FILE_BYTES to the value you chose.');
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }

  const url = parseMailboxUrl(process.env.MAILBOX_URL ?? '');
  const key = process.env.MAILBOX_KEY ?? '';
  const requests = options.sizes.length * options.runs;
  const totalMb = options.sizes.reduce((sum, size) => sum + size.mb, 0) * options.runs;
  console.log(
    `Plan: ${options.sizes.map((size) => size.label).join(', ')} MB, ${options.runs} runs each ` +
      `(${plural(requests, 'request')}, about ${Number(totalMb.toFixed(3))} MB of random data)` +
      `${url ? ` to ${url.host}` : ''}.`,
  );

  const problems = [];
  if (!process.env.MAILBOX_URL) problems.push('MAILBOX_URL is not set.');
  else if (!url) problems.push('MAILBOX_URL is not a valid http(s) URL.');
  if (!key) problems.push('MAILBOX_KEY is not set.');
  if (!options.yes) problems.push('Pass --yes to confirm. This creates real files in the Capture folder.');
  if (problems.length > 0) {
    console.error(['Not running:', ...problems.map((problem) => `  - ${problem}`), '', 'Run with --help for details.'].join('\n'));
    return 1;
  }

  console.log('');
  console.log(formatRow('Size (MB)', 'Run', 'HTTP', 'Result', 'Seconds'));
  const outcomes = [];
  for (const size of options.sizes) {
    for (let run = 1; run <= options.runs; run++) {
      const outcome = await probeOnce({ url: url.href, key, sizeLabel: size.label, bytes: size.bytes, run, timeoutSeconds: options.timeoutSeconds });
      outcomes.push({ ...outcome, size });
      console.log(formatRow(size.label, run, outcome.http, outcome.result, outcome.seconds));
      if (outcome.detail) {
        console.log(`${' '.repeat(16)}${outcome.detail}`);
      }
    }
  }

  printSummary(outcomes, options.runs);
  return 0;
}

process.exitCode = await main();
