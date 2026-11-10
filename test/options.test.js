import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { resolveOptions } from '../src/options.js';
import { readScope } from '../src/properties.js';

const PROPERTIES = `# comment
sonar.projectKey=acme_app
sonar.organization = acme
sonar.host.url=https://sonarcloud.io
sonar.sources=app, lib
sonar.tests=tests
sonar.exclusions=**/dist/**,**/*.css
sonar.test.inclusions=**/*.spec.ts,**/*Test.php
unrelated.key=1
no equals sign
`;

// cms/                  .env (SONAR_TOKEN), sonar-project.properties
// cms/catalog/          the cwd of the sub-project script
let root;
let sub;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-opts-'));
  sub = path.join(root, 'catalog');
  await mkdir(path.join(sub, 'src'), { recursive: true });
  await writeFile(path.join(root, 'sonar-project.properties'), PROPERTIES);
  await writeFile(
    path.join(root, '.env'),
    'SONAR_TOKEN=from-file\nSONAR_ORG=env-org\n'
  );
});
after(() => rm(root, { recursive: true, force: true }));

describe('readScope', () => {
  test('reads only the keys the analysis needs', async () => {
    const scope = await readScope(path.join(root, 'sonar-project.properties'));
    assert.deepEqual(scope, {
      baseDir: undefined,
      sources: ['app', 'lib'],
      tests: ['tests'],
      exclusions: ['**/dist/**', '**/*.css'],
      testInclusions: ['**/*.spec.ts', '**/*Test.php'],
      projectKey: 'acme_app',
      organization: 'acme',
      host: 'https://sonarcloud.io',
    });
  });
});

describe('resolveOptions', () => {
  const opts = (values, cwd, env = {}) => resolveOptions(values, { cwd, env });

  test('no token: standalone, defaults to the current directory', async () => {
    const o = await opts({}, sub);
    assert.equal(o.connection, null);
    assert.equal(o.baseDir, sub);
    assert.deepEqual(o.paths, ['.']);
  });

  test('--sources is relative to the cwd even with --base-dir', async () => {
    const o = await opts({ 'base-dir': '..', sources: 'src' }, sub);
    assert.equal(o.baseDir, root);
    assert.deepEqual(o.paths, [path.join(sub, 'src')]);
  });

  test('an explicit --sources drops the file tests; --tests brings them back', async () => {
    const none = await opts({ 'base-dir': '..', sources: 'src' }, sub);
    assert.equal(none.testFilePattern, '**/*.spec.ts,**/*Test.php');
    const some = await opts(
      { 'base-dir': '..', sources: 'src', tests: 'src/__tests__' },
      sub
    );
    assert.deepEqual(some.paths, [
      path.join(sub, 'src'),
      path.join(sub, 'src', '__tests__'),
    ]);
    assert.equal(
      some.testFilePattern,
      'catalog/src/__tests__/**,**/*.spec.ts,**/*Test.php'
    );
  });

  test('a single test file matches itself, not a subtree', async () => {
    await writeFile(path.join(sub, 'src', 'x.test.ts'), '');
    const o = await opts({ 'base-dir': '..', tests: 'src/x.test.ts' }, sub);
    assert.ok(o.testFilePattern.startsWith('catalog/src/x.test.ts,'));
  });

  test('the file tests become the test file pattern, relative to the base dir', async () => {
    const o = await opts({}, root);
    assert.equal(o.testFilePattern, 'tests/**,**/*.spec.ts,**/*Test.php');
  });

  test('--base-dir finds .env and the properties file in the parent', async () => {
    const o = await opts({ 'base-dir': '..', sources: 'src' }, sub);
    assert.deepEqual(o.connection, {
      token: 'from-file',
      host: 'https://sonarcloud.io',
      org: 'env-org',
      project: 'acme_app',
    });
    assert.deepEqual(o.exclusions, ['**/dist/**', '**/*.css']);
  });

  test('without --base-dir, the properties file in the cwd sets the base dir and sources', async () => {
    const o = await opts({}, root);
    assert.equal(o.baseDir, root);
    assert.deepEqual(o.paths, ['app', 'lib', 'tests']);
  });

  test('--properties is relative to the cwd', async () => {
    const o = await opts(
      { properties: '../sonar-project.properties', token: 't' },
      sub
    );
    assert.equal(o.baseDir, root);
    assert.equal(o.connection.project, 'acme_app');
  });

  test('environment variables win over the .env file; flags win over both', async () => {
    const env = { SONAR_TOKEN: 'from-env' };
    assert.equal(
      (await opts({ 'base-dir': '..' }, sub, env)).connection.token,
      'from-env'
    );
    const flagged = await opts(
      { 'base-dir': '..', token: 'flag', org: 'flag-org' },
      sub,
      env
    );
    assert.equal(flagged.connection.token, 'flag');
    assert.equal(flagged.connection.org, 'flag-org');
  });

  test('--standalone ignores the token', async () => {
    const o = await opts({ 'base-dir': '..', standalone: true }, sub);
    assert.equal(o.connection, null);
  });

  test('--project skips the properties auto-detection', async () => {
    const o = await opts({ 'base-dir': '..', project: 'other', org: 'o' }, sub);
    assert.equal(o.connection.project, 'other');
    assert.deepEqual(o.exclusions, []);
  });

  test('a token without a project or org is an error naming what is missing', async () => {
    await assert.rejects(
      opts({ token: 't' }, sub),
      /Missing required option\(s\): --project, --org/
    );
  });

  test('an org is not required for a self-hosted SonarQube Server', async () => {
    const o = await opts(
      { token: 't', project: 'p', host: 'https://sonar.corp.example' },
      sub
    );
    assert.equal(o.connection.host, 'https://sonar.corp.example');
  });

  test('--env-file must exist; the default .env may be missing', async () => {
    await assert.rejects(
      opts({ 'env-file': 'nope.env' }, sub),
      /Failed to load env file/
    );
    assert.equal((await opts({}, sub)).connection, null);
  });
});
