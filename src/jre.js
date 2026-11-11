import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { adoptiumArch, adoptiumOs, cacheDir, isWindows } from './platform.js';

const execFileAsync = promisify(execFile);

const JAVA_FEATURE_VERSION = 21;

// https://api.adoptium.net/q/openapi — /v3/binary/latest/{feature_version}/{release_type}/{os}/{arch}/{image_type}/{jvm_impl}/{heap_size}/{vendor}
// Verified live: this endpoint 307-redirects to a real GitHub release asset
// (temurin{N}-binaries), a .zip on Windows and a .tar.gz on macOS/Linux.
function adoptiumDownloadUrl() {
  const os_ = adoptiumOs();
  const arch = adoptiumArch();
  return `https://api.adoptium.net/v3/binary/latest/${JAVA_FEATURE_VERSION}/ga/${os_}/${arch}/jre/hotspot/normal/eclipse`;
}

function jreInstallDir() {
  return path.join(
    cacheDir(),
    'jre',
    `${JAVA_FEATURE_VERSION}-${adoptiumOs()}-${adoptiumArch()}`
  );
}

function sentinelPath() {
  return path.join(jreInstallDir(), '.ready');
}

async function downloadToFile(url, destPath) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(destPath, buffer);
}

async function extractArchive(archivePath, destDir) {
  if (isWindows()) {
    // Expand-Archive ships with PowerShell on every Windows 10+/11 install — no extra
    // dependency needed for a zip we control the contents of.
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
    ]);
  } else {
    // GNU/BSD tar are both preinstalled on macOS and every mainstream Linux distro.
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destDir]);
  }
}

// Adoptium archives extract to a single top-level dir whose name embeds the exact build
// (e.g. "jdk-21.0.12+8-jre") — that suffix isn't predictable ahead of time, so find it.
export async function findJavaBinary(extractedRoot) {
  const entries = await readdir(extractedRoot, { withFileTypes: true });
  const topLevelDir = entries.find((entry) => entry.isDirectory());
  if (!topLevelDir) {
    throw new Error(
      `Extracted JRE at ${extractedRoot} has no top-level directory — unexpected archive layout.`
    );
  }
  const binaryName = isWindows() ? 'java.exe' : 'java';
  const jreRoot = path.join(extractedRoot, topLevelDir.name);
  // macOS Temurin archives are bundles: the JRE lives under Contents/Home.
  const macBinary = path.join(jreRoot, 'Contents', 'Home', 'bin', binaryName);
  return fs.existsSync(macBinary)
    ? macBinary
    : path.join(jreRoot, 'bin', binaryName);
}

export async function ensureJre({ log = () => {} } = {}) {
  const installDir = jreInstallDir();
  const sentinel = sentinelPath();

  if (fs.existsSync(sentinel)) {
    return findJavaBinary(installDir);
  }

  log(
    `Downloading a portable Java ${JAVA_FEATURE_VERSION} runtime (one-time, ~45MB)...`
  );
  await rm(installDir, { recursive: true, force: true });
  await mkdir(installDir, { recursive: true });

  const archiveExt = isWindows() ? 'zip' : 'tar.gz';
  const archivePath = path.join(installDir, `jre.${archiveExt}`);
  await downloadToFile(adoptiumDownloadUrl(), archivePath);

  log('Extracting runtime...');
  await extractArchive(archivePath, installDir);
  await rm(archivePath, { force: true });

  const javaBinary = await findJavaBinary(installDir);
  if (!fs.existsSync(javaBinary)) {
    throw new Error(
      `Extraction succeeded but no java binary found at ${javaBinary}.`
    );
  }
  if (!isWindows()) {
    await fs.promises.chmod(javaBinary, 0o755);
  }

  await writeFile(sentinel, new Date().toISOString());
  log('Java runtime ready.');

  return javaBinary;
}
