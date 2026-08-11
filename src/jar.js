import fs from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cacheDir } from './platform.js';

const RELEASES_API = 'https://api.github.com/repos/pavel-zeman/sonarlint-cli/releases/latest';

// pavel-zeman/sonarlint-cli (LGPL-3.0) drives the same sonarlint-core/sonarlint-language-server
// engine SonarLint IDE plugins use, synced against a project's real Connected Mode quality
// profile. We invoke its published jar as a separate process (never link against its code), and
// fetch it fresh from its own GitHub releases here rather than bundling/redistributing a copy —
// keeps this package's own MIT license clean of any LGPL redistribution obligations.
async function resolveLatestRelease() {
  const response = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`Failed to look up the latest sonarlint-cli release: HTTP ${response.status}`);
  }
  const release = await response.json();
  const asset = release.assets?.find((a) => a.name.endsWith('.jar'));
  if (!asset) {
    throw new Error(`No .jar asset found on sonarlint-cli release ${release.tag_name}.`);
  }
  return { version: release.tag_name, url: asset.browser_download_url, fileName: asset.name };
}

async function downloadToFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

export async function ensureJar({ log = () => {} } = {}) {
  const { url, fileName } = await resolveLatestRelease();
  const jarDir = path.join(cacheDir(), 'jar');
  const jarPath = path.join(jarDir, fileName);

  if (fs.existsSync(jarPath)) {
    return jarPath;
  }

  await mkdir(jarDir, { recursive: true });
  log(`Downloading sonarlint-cli (${fileName}, one-time, ~40MB)...`);
  await downloadToFile(url, jarPath);
  log('sonarlint-cli ready.');

  return jarPath;
}
