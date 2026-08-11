import os from 'node:os';

// Maps Node's process.platform/arch to Adoptium's API enum values.
// See https://api.adoptium.net/q/openapi — Architecture/OperatingSystem schemas.
const OS_MAP = {
  win32: 'windows',
  darwin: 'mac',
  linux: 'linux',
};

const ARCH_MAP = {
  x64: 'x64',
  arm64: 'aarch64',
};

export function adoptiumOs() {
  const mapped = OS_MAP[process.platform];
  if (!mapped) {
    throw new Error(`Unsupported platform "${process.platform}" — sonar-local-cli supports Windows, macOS, and Linux.`);
  }
  return mapped;
}

export function adoptiumArch() {
  const mapped = ARCH_MAP[process.arch];
  if (!mapped) {
    throw new Error(`Unsupported architecture "${process.arch}" — sonar-local-cli supports x64 and arm64.`);
  }
  return mapped;
}

export function isWindows() {
  return process.platform === 'win32';
}

export function cacheDir() {
  return `${os.homedir()}/.sonar-local-cli`;
}
