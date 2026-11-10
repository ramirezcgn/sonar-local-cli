import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  analyze,
  collectFiles,
  connectionSettings,
  globToRegExp,
  replyTo,
} from '../src/engine.js';

const FAKE = fileURLToPath(
  new URL('fixtures/fake-server.mjs', import.meta.url)
);
const launchFake = (check) => () =>
  spawn(process.execPath, [FAKE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FAKE_CHECK: check },
  });

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-test-'));
  await mkdir(path.join(dir, 'src', 'gen'), { recursive: true });
  await mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(dir, 'src', 'a.js'), 'x\nISSUE\n');
  await writeFile(path.join(dir, 'src', 'b.ts'), 'clean\n');
  await writeFile(path.join(dir, 'src', 'notes.txt'), 'not analyzable');
  await writeFile(path.join(dir, 'src', 'gen', 'c.js'), 'generated');
  await writeFile(path.join(dir, 'src', 'style.css'), 'a{}');
  await writeFile(path.join(dir, 'node_modules', 'x', 'd.js'), 'dep');
});
after(() => rm(dir, { recursive: true, force: true }));

const rel = (files) =>
  files.map((f) => path.relative(dir, f).split(path.sep).join('/')).sort();

describe('globToRegExp', () => {
  const matches = (glob, file) => globToRegExp(glob).test(file);

  test('** crosses directories, * and ? do not', () => {
    assert.ok(matches('**/dist/**', 'a/b/dist/x/y.js'));
    assert.ok(matches('**/dist/**', 'dist/y.js'));
    assert.ok(matches('**/*.css', 'src/deep/a.css'));
    assert.ok(matches('**/*.css', 'a.css'));
    assert.ok(!matches('src/*.js', 'src/gen/c.js'));
    assert.ok(matches('src/?.js', 'src/a.js'));
    assert.ok(!matches('src/?.js', 'src/ab.js'));
  });

  test('regex metacharacters in a pattern are literal', () => {
    assert.ok(matches('a+b(1).js', 'a+b(1).js'));
    assert.ok(!matches('a.js', 'aXjs'));
  });
});

describe('collectFiles', () => {
  test('walks directories, skipping node_modules and unsupported files', async () => {
    const files = await collectFiles(dir, ['.']);
    assert.deepEqual(rel(files), [
      'src/a.js',
      'src/b.ts',
      'src/gen/c.js',
      'src/style.css',
    ]);
  });

  test('accepts single files next to directories without duplicates', async () => {
    const files = await collectFiles(dir, ['src/a.js', 'src/gen', 'src/a.js']);
    assert.deepEqual(rel(files), ['src/a.js', 'src/gen/c.js']);
  });

  test('ignores a single file of an unsupported type', async () => {
    assert.deepEqual(await collectFiles(dir, ['src/notes.txt']), []);
  });

  test('applies sonar.exclusions relative to the base dir', async () => {
    const files = await collectFiles(dir, ['.'], ['**/gen/**', '**/*.css']);
    assert.deepEqual(rel(files), ['src/a.js', 'src/b.ts']);
  });

  test('fails with a clear message for a missing path', async () => {
    await assert.rejects(collectFiles(dir, ['nope']), /Path not found/);
  });
});

describe('connectionSettings', () => {
  const base = { org: 'acme', project: 'acme_app', token: 'tok' };

  test('SonarQube Cloud EU', () => {
    const c = connectionSettings({ ...base, host: 'https://sonarcloud.io' });
    assert.equal(c.connections.sonarcloud[0].region, 'EU');
    assert.equal(c.connections.sonarcloud[0].organizationKey, 'acme');
    assert.deepEqual(c.connections.sonarqube, []);
    assert.equal(c.settings.connectedMode.project.projectKey, 'acme_app');
  });

  test('SonarQube Cloud US', () => {
    const c = connectionSettings({ ...base, host: 'https://sonarqube.us' });
    assert.equal(c.connections.sonarcloud[0].region, 'US');
  });

  test('any other host is a SonarQube Server', () => {
    const c = connectionSettings({
      ...base,
      host: 'https://sonar.corp.example',
    });
    assert.deepEqual(c.connections.sonarcloud, []);
    assert.equal(
      c.connections.sonarqube[0].serverUrl,
      'https://sonar.corp.example'
    );
  });
});

describe('replyTo', () => {
  const connection = connectionSettings({
    org: 'o',
    project: 'p',
    token: 'tok',
    host: 'https://sonarcloud.io',
  });

  test('answers the token request only when connected', () => {
    const msg = { method: 'sonarlint/getTokenForServer' };
    assert.equal(replyTo(msg, connection), 'tok');
    assert.equal(replyTo(msg, undefined), null);
  });

  test('serves the binding in the sonarlint config section only', () => {
    const msg = {
      method: 'workspace/configuration',
      params: { items: [{ section: 'sonarlint' }, { section: 'other' }] },
    };
    const [sonarlint, other] = replyTo(msg, connection);
    assert.equal(sonarlint.connectedMode.project.projectKey, 'p');
    assert.deepEqual(other, {});
    assert.deepEqual(replyTo(msg, undefined, 'tests/**'), [
      { rules: {}, testFilePattern: 'tests/**' },
      {},
    ]);
    assert.equal(
      replyTo(msg, connection, 'tests/**')[0].testFilePattern,
      'tests/**'
    );
  });

  test('answers the requests the server blocks on', () => {
    assert.equal(replyTo({ method: 'sonarlint/isOpenInEditor' }), true);
    assert.deepEqual(replyTo({ method: 'sonarlint/listFilesInFolder' }), {
      foundFiles: [],
    });
  });
});

describe('analyze (fake language server)', () => {
  const run = async (check, connection) => {
    const files = await collectFiles(dir, ['src/a.js', 'src/b.ts']);
    return analyze({
      javaBinary: 'unused',
      jars: {},
      baseDir: dir,
      files,
      connection,
      quietMs: 400,
      launch: launchFake(check),
    });
  };

  test('standalone: reports issues with relative paths and 1-based lines', async () => {
    const { issues, analyzed, total } = await run('none');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].file, 'src/a.js');
    assert.equal(issues[0].line, 2);
    assert.equal(issues[0].typeId, 'js:S1');
    assert.equal(issues[0].severity, 'WARNING');
    assert.equal([analyzed, total].join('/'), '2/2');
  });

  test('connected: answers the token, sends the binding and opens files only after the sync', async () => {
    const connection = connectionSettings({
      org: 'acme',
      project: 'acme_app',
      token: 'secret',
      host: 'https://sonarcloud.io',
    });
    const { issues } = await run('ok', connection);
    assert.equal(
      issues[0].message,
      'early=false token=secret project=acme_app'
    );
  });

  test('connected: a failed connection check is a clear error', async () => {
    const connection = connectionSettings({
      org: 'acme',
      project: 'p',
      token: 'bad',
      host: 'https://sonarcloud.io',
    });
    await assert.rejects(run('fail', connection), /Could not connect/);
  });
});
