import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/sonar-local.js', import.meta.url));
// A token-less environment, so a stray SONAR_TOKEN on the machine cannot switch the mode.
const env = { ...process.env, SONAR_TOKEN: '', SONAR_ORG: '' };
const cli = (args, cwd) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, env, encoding: 'utf8' });

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-cli-test-'));
});
after(() =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
);

describe('cli (no downloads)', () => {
  test('--help documents standalone and connected usage', () => {
    const r = cli(['--help'], dir);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Connected Mode/);
    assert.match(r.stdout, /--standalone/);
  });

  test('a directory with nothing analyzable exits 1 before downloading anything', () => {
    const r = cli([], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No analyzable files/);
  });

  test('a missing --sources path exits 1 with the path in the message', () => {
    const r = cli(['--sources', 'nope'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Path not found/);
  });

  test('an unknown --fail-on level exits 1 before doing any work', () => {
    const r = cli(['--fail-on', 'critical'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Invalid --fail-on "critical"/);
  });

  test('a token without a project exits 1 naming the missing option', () => {
    const r = cli(['--token', 'x', '--org', 'o'], dir);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--project/);
  });
});

// Real JRE + language server (downloaded on first run). Opt in with SONAR_LOCAL_E2E=1.
describe('cli e2e (standalone)', { skip: !process.env.SONAR_LOCAL_E2E }, () => {
  test('analyzes a loose file and reports its issues', async () => {
    await writeFile(
      path.join(dir, 'a.js'),
      'function f(a) {\n  var x = 1;\n}\n'
    );
    const r = cli(['--sources', 'a.js'], dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /a\.js:2\s+\[javascript:S1481\]/);
    assert.match(r.stdout, /2 issue\(s\) in 1\/1 file\(s\)/);
  });

  test('--fail-on-issues exits 2 when issues are found', () => {
    const r = cli(['--sources', 'a.js', '--fail-on-issues'], dir);
    assert.equal(r.status, 2, r.stderr);
  });

  test('--fail-on only trips for issues at least that severe', () => {
    // a.js only has WARNING-level issues.
    assert.equal(
      cli(['--sources', 'a.js', '--fail-on', 'warning'], dir).status,
      2
    );
    assert.equal(
      cli(['--sources', 'a.js', '--fail-on', 'error'], dir).status,
      0
    );
  });
});
