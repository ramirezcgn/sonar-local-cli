import { readFile } from 'node:fs/promises';

const KEYS = new Set([
  'sonar.sources',
  'sonar.tests',
  'sonar.exclusions',
  'sonar.test.inclusions',
  'sonar.projectBaseDir',
  'sonar.projectKey',
  'sonar.organization',
  'sonar.host.url',
]);

export const splitList = (value) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Reads only the keys the analysis needs from a sonar-project.properties file.
export async function readScope(propertiesPath) {
  const props = {};
  for (const line of (await readFile(propertiesPath, 'utf8')).split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (KEYS.has(key)) props[key] = line.slice(eq + 1).trim();
  }
  return {
    baseDir: props['sonar.projectBaseDir'],
    sources: splitList(props['sonar.sources']),
    tests: splitList(props['sonar.tests']),
    exclusions: splitList(props['sonar.exclusions']),
    testInclusions: splitList(props['sonar.test.inclusions']),
    projectKey: props['sonar.projectKey'],
    organization: props['sonar.organization'],
    host: props['sonar.host.url'],
  };
}
