import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const OVERRIDABLE_KEYS = ['sonar.sources', 'sonar.tests'];
const SCOPE_KEYS = new Set([...OVERRIDABLE_KEYS, 'sonar.projectBaseDir']);

async function tempPropertiesFile(content) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-cli-'));
  const filePath = path.join(dir, 'sonar-project.properties');
  await writeFile(filePath, content);

  return {
    path: filePath,
    cleanup: async () => rm(dir, { recursive: true, force: true }),
  };
}

// Replaces (or appends) sonar.sources/sonar.tests lines in an existing properties file's content,
// leaving every other line — including comments and formatting — untouched. Lets --sources/--tests
// narrow the scope of a full project's tracked properties file for a fast, targeted run without
// hand-writing a whole separate file each time.
function applyOverrides(content, overrides) {
  const lines = content.split('\n');
  const applied = new Set();

  const result = lines.map((line) => {
    const match = OVERRIDABLE_KEYS.find((key) =>
      line.trim().startsWith(`${key}=`)
    );
    if (!match || !(match in overrides)) return line;
    applied.add(match);
    return `${match}=${overrides[match]}`;
  });

  for (const [key, value] of Object.entries(overrides)) {
    if (!applied.has(key)) result.push(`${key}=${value}`);
  }

  return result.join('\n');
}

// Standalone mode has no server-side project config, so it reads just the scope keys from the file.
export async function readScope(propertiesPath) {
  const props = {};
  for (const line of (await readFile(propertiesPath, 'utf8')).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (SCOPE_KEYS.has(key)) props[key] = line.slice(eq + 1).trim();
  }
  const split = (value) =>
    (value ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return {
    baseDir: props['sonar.projectBaseDir'],
    sources: split(props['sonar.sources']),
    tests: split(props['sonar.tests']),
  };
}

// Token is deliberately never written here — it's passed to the analysis process as the
// SONAR_TOKEN env var, which sonarlint-cli reads directly (see Configuration.java: every
// sonar.* property falls back to an uppercased/underscored env var before the file).
export async function resolvePropertiesFile(options) {
  if (options.properties) {
    const overrides = {};
    if (options.sources) overrides['sonar.sources'] = options.sources;
    if (options.tests) overrides['sonar.tests'] = options.tests;

    if (Object.keys(overrides).length === 0) {
      return { path: options.properties, cleanup: async () => {} };
    }

    const original = await readFile(options.properties, 'utf8');
    return tempPropertiesFile(applyOverrides(original, overrides));
  }

  const required = ['org', 'project', 'sources'];
  const missing = required.filter((key) => !options[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required option(s): ${missing.map((k) => `--${k}`).join(', ')} ` +
        '(or pass --properties <file> to use an existing sonar-project.properties instead).'
    );
  }

  const lines = [
    `sonar.projectKey=${options.project}`,
    `sonar.organization=${options.org}`,
    `sonar.host.url=${options.host ?? 'https://sonarcloud.io'}`,
    `sonar.projectBaseDir=${options.baseDir ?? process.cwd()}`,
    `sonar.sources=${options.sources}`,
  ];
  if (options.tests) {
    lines.push(`sonar.tests=${options.tests}`);
  }

  return tempPropertiesFile(lines.join('\n') + '\n');
}
