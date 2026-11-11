import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { findJavaBinary } from '../src/jre.js';

const BINARY = process.platform === 'win32' ? 'java.exe' : 'java';

let dir;
before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-jre-'));
});
after(() =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
);

async function layout(name, ...segments) {
  const root = path.join(dir, name);
  const bin = path.join(root, 'jdk-21.0.12+8-jre', ...segments, BINARY);
  await mkdir(path.dirname(bin), { recursive: true });
  await writeFile(bin, '');
  return { root, bin };
}

describe('findJavaBinary', () => {
  test('Linux and Windows archives keep the JRE under bin/', async () => {
    const { root, bin } = await layout('flat', 'bin');
    assert.equal(await findJavaBinary(root), bin);
  });

  test('macOS archives are bundles: the JRE lives under Contents/Home/bin', async () => {
    const { root, bin } = await layout('mac', 'Contents', 'Home', 'bin');
    assert.equal(await findJavaBinary(root), bin);
  });

  test('an extraction with no top-level directory is an error', async () => {
    const root = path.join(dir, 'empty');
    await mkdir(root, { recursive: true });
    await assert.rejects(findJavaBinary(root), /no top-level directory/);
  });
});
