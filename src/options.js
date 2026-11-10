import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { readScope, splitList } from './properties.js';

const DEFAULT_HOST = 'https://sonarcloud.io';

// The default .env is opportunistic; one named with --env-file must exist.
function readEnvFile(file, explicit) {
  try {
    return parseEnv(readFileSync(file, 'utf8'));
  } catch (error) {
    if (explicit || error.code !== 'ENOENT') {
      throw new Error(`Failed to load env file "${file}": ${error.message}`);
    }
    return {};
  }
}

function missingOptions({ host, org, project }) {
  const missing = [];
  if (!project) missing.push('--project');
  if (!org && /sonarcloud\.io|sonarqube\.us/.test(host)) missing.push('--org');
  return missing;
}

// Turns the parsed CLI flags into what the run needs. Explicit path flags are relative to `cwd`;
// --base-dir is the project root and the default place for .env and sonar-project.properties.
export async function resolveOptions(
  values,
  { cwd = process.cwd(), env = process.env } = {}
) {
  const root = path.resolve(cwd, values['base-dir'] ?? '.');
  const abs = (p) => path.resolve(cwd, p);
  const envFile = values['env-file']
    ? abs(values['env-file'])
    : path.join(root, '.env');
  // Like process.loadEnvFile, variables already set in the environment win over the file.
  const merged = {
    ...readEnvFile(envFile, Boolean(values['env-file'])),
    ...env,
  };

  let propertiesPath = values.properties ? abs(values.properties) : undefined;
  if (!propertiesPath && !values.project) {
    const detected = path.join(root, 'sonar-project.properties');
    if (existsSync(detected)) propertiesPath = detected;
  }
  const scope = propertiesPath
    ? await readScope(propertiesPath)
    : { sources: [], tests: [], exclusions: [], testInclusions: [] };

  let baseDir = cwd;
  if (values['base-dir']) baseDir = root;
  else if (propertiesPath) {
    baseDir = path.resolve(path.dirname(propertiesPath), scope.baseDir ?? '.');
  }

  const cliSources = splitList(values.sources).map(abs);
  const cliTests = splitList(values.tests).map(abs);
  let sources = cliSources.length > 0 ? cliSources : scope.sources;
  if (sources.length === 0) sources = ['.'];
  // An explicit --sources narrows the run, so the file's test directories stay out unless asked.
  let tests = scope.tests;
  if (cliTests.length > 0) tests = cliTests;
  else if (cliSources.length > 0) tests = [];
  // A test directory matches everything under it; a single test file matches itself.
  const toPattern = (p) => {
    const abs = path.resolve(baseDir, p);
    const rel = path.relative(baseDir, abs).split(path.sep).join('/') || '.';
    return statSync(abs, { throwIfNoEntry: false })?.isFile()
      ? rel
      : `${rel}/**`;
  };
  const testFilePattern = [
    ...tests.map(toPattern),
    ...scope.testInclusions,
  ].join(',');

  const token = values.token ?? merged.SONAR_TOKEN;
  let connection = null;
  if (token && !values.standalone) {
    connection = {
      token,
      host: values.host ?? scope.host ?? DEFAULT_HOST,
      org: values.org ?? merged.SONAR_ORG ?? scope.organization,
      project: values.project ?? scope.projectKey,
    };
    const missing = missingOptions(connection);
    if (missing.length > 0) {
      throw new Error(
        `Missing required option(s): ${missing.join(', ')} (or a sonar-project.properties with sonar.projectKey and sonar.organization).`
      );
    }
  }

  return {
    baseDir,
    paths: [...sources, ...tests],
    exclusions: scope.exclusions,
    testFilePattern,
    connection,
  };
}
