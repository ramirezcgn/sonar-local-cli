import fs from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAt = new Date(Number(response.headers.get('x-ratelimit-reset')) * 1000);
      throw new Error(
        `GitHub's unauthenticated API rate limit (60 req/hour, shared across everything on this ` +
          `network) is exhausted — resets at ${resetAt.toLocaleTimeString()}. This only happens on ` +
          `the very first run on a given machine (nothing to look up once a jar is cached); if it ` +
          `keeps happening, manually place a sonarlint-cli-*.jar from ` +
          `https://github.com/pavel-zeman/sonarlint-cli/releases into ~/.sonar-local-cli/jar/.`,
      );
    }
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

// Only hits the GitHub API (unauthenticated, 60 requests/hour per IP — shared across everything
// on that IP, not just this tool) when no jar is cached at all yet. Once one exists, it's reused
// indefinitely rather than re-resolving "latest" on every single invocation — that earlier
// per-run lookup was hitting the rate limit for zero benefit in the common case, since it just
// re-derived the same cached filename anyway. Delete ~/.sonar-local-cli/jar to force a refresh.
async function findCachedJar(jarDir) {
  if (!fs.existsSync(jarDir)) return null;
  const entries = await readdir(jarDir);
  const jar = entries.find((name) => name.endsWith('.jar'));
  return jar ? path.join(jarDir, jar) : null;
}

export async function ensureJar({ log = () => {} } = {}) {
  const jarDir = path.join(cacheDir(), 'jar');

  const cached = await findCachedJar(jarDir);
  if (cached) {
    return cached;
  }

  const { url, fileName } = await resolveLatestRelease();
  const jarPath = path.join(jarDir, fileName);

  await mkdir(jarDir, { recursive: true });
  log(`Downloading sonarlint-cli (${fileName}, one-time, ~40MB)...`);
  await downloadToFile(url, jarPath);
  log('sonarlint-cli ready.');

  return jarPath;
}
