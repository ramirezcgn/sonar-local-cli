#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureJar } from '../src/jar.js';
import { ensureJre } from '../src/jre.js';
import { resolvePropertiesFile } from '../src/properties.js';
import { formatInspection, parseInspections, parseSummaryLine } from '../src/teamcity.js';

const HELP = `sonar-local — run real SonarQube/SonarCloud Connected-Mode analysis locally.

No Java pre-install, no Docker, no MCP server: downloads a portable JRE and the
sonarlint-cli analysis engine on first run (cached under ~/.sonar-local-cli after that),
then drives the same engine SonarLint IDE plugins use, synced against your project's
real quality profile.

Usage:
  sonar-local --token <token> --org <org> --project <projectKey> --sources <dir[,dir...]> [options]
  sonar-local --token <token> --properties <path/to/sonar-project.properties>
  sonar-local --token <token> --properties <path> --sources <dir[,dir...]> [--tests <dir[,dir...]>]

Options:
  --token <token>        SonarQube/SonarCloud token. Falls back to $SONAR_TOKEN, which in turn
                          can come from a .env file — see --env-file.
  --org <org>             SonarCloud organization key. Falls back to $SONAR_ORG.
  --env-file <path>       Load env vars (SONAR_TOKEN, SONAR_ORG, ...) from a dotenv-format file
                          before resolving options. Default: .env in the current directory, if
                          one exists (silently skipped otherwise — this is not an error).
  --host <url>            Server URL. Default: https://sonarcloud.io
  --project <key>         Project key.
  --sources <dirs>        Comma-separated source directories (relative to --base-dir).
                          Must be directories, not individual files. Combined with
                          --properties, overrides just that file's sonar.sources for this
                          run (everything else in the file — projectKey, exclusions, etc.
                          — stays as-is) instead of replacing the whole config.
  --tests <dirs>          Comma-separated test directories, same rule as --sources.
  --base-dir <path>       Project root. Default: current directory.
  --properties <path>     Use an existing sonar-project.properties file instead of
                          --org/--project/--sources/--tests.
  --verbose, -v           Stream the underlying engine's raw output (Java/Spring/analyzer logs,
                          full TeamCity service messages) instead of the default filtered
                          issue list. Use this to debug a failure that isn't a lint finding.
  -h, --help              Show this help.

By default, prints just the issues found (one line each: severity, file:line, rule, message)
plus a final count — the engine's own verbose startup/analyzer logging is suppressed. Exit code
reflects the tool's own process exit, not whether issues were found — a clean run and a run that
found issues both exit 0; only a real failure (bad config, crash, etc.) exits non-zero, in which
case the raw output is shown regardless of --verbose so you have something to debug from.
`;

// Loads SONAR_TOKEN/SONAR_ORG/etc. from a dotenv-format file into process.env, using Node's
// built-in loader (no dependency). --env-file is explicit and must exist; the bare default (.env
// in cwd) is opportunistic — most invocations won't have one, and that's fine, not an error.
function loadEnvFile(explicitPath) {
  try {
    if (explicitPath) {
      process.loadEnvFile(explicitPath);
    } else {
      process.loadEnvFile();
    }
  } catch (error) {
    if (explicitPath || error.code !== 'ENOENT') {
      throw new Error(`Failed to load env file "${explicitPath ?? '.env'}": ${error.message}`);
    }
  }
}

// Runs the engine with stdio inherited — the pre-existing behavior, used for --verbose and as
// the fallback when a run fails (real errors need the raw log, not a filtered issue list).
function runVerbose(javaBinary, jarPath, propertiesPath, token) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaBinary, ['-jar', jarPath, propertiesPath], {
      stdio: 'inherit',
      env: { ...process.env, SONAR_TOKEN: token },
    });
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
}

// Captures stdout/stderr instead of streaming them, so a successful run can print just the
// parsed issue list instead of the engine's own startup/analyzer/rule-documentation noise. On a
// non-zero exit, falls back to dumping the raw captured output — a real failure needs the actual
// log, not a best-effort issue list parsed out of who-knows-what got printed before it crashed.
async function runQuiet(javaBinary, jarPath, propertiesPath, token) {
  const { code, stdout, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(javaBinary, ['-jar', jarPath, propertiesPath], {
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, SONAR_TOKEN: token },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ code: exitCode ?? 1, stdout, stderr }));
  });

  if (code !== 0) {
    process.stderr.write(stdout);
    process.stderr.write(stderr);
    process.stderr.write(`\n[sonar-local] Engine exited with code ${code} — see raw output above.\n`);
    return code;
  }

  const inspections = parseInspections(stdout);
  for (const inspection of inspections) {
    process.stdout.write(formatInspection(inspection) + '\n');
  }

  const summary = parseSummaryLine(stdout);
  if (summary) {
    process.stdout.write(
      `\n${summary.issues} issue(s), ${summary.securityHotspots} security hotspot(s).\n`,
    );
  } else {
    process.stdout.write(`\n${inspections.length} issue(s).\n`);
  }

  return code;
}

async function main() {
  const { values } = parseArgs({
    options: {
      token: { type: 'string' },
      org: { type: 'string' },
      host: { type: 'string' },
      project: { type: 'string' },
      sources: { type: 'string' },
      tests: { type: 'string' },
      'base-dir': { type: 'string' },
      properties: { type: 'string' },
      'env-file': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  loadEnvFile(values['env-file']);

  const token = values.token ?? process.env.SONAR_TOKEN;
  if (!token) {
    process.stderr.write('Missing token: pass --token <token> or set $SONAR_TOKEN.\n');
    return 1;
  }

  const org = values.org ?? process.env.SONAR_ORG;

  const log = (msg) => process.stderr.write(`[sonar-local] ${msg}\n`);

  const [javaBinary, jarPath] = await Promise.all([ensureJre({ log }), ensureJar({ log })]);

  const { path: propertiesPath, cleanup } = await resolvePropertiesFile({
    properties: values.properties,
    org,
    host: values.host,
    project: values.project,
    sources: values.sources,
    tests: values.tests,
    baseDir: values['base-dir'],
  });

  try {
    return values.verbose
      ? await runVerbose(javaBinary, jarPath, propertiesPath, token)
      : await runQuiet(javaBinary, jarPath, propertiesPath, token);
  } finally {
    await cleanup();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`[sonar-local] ${error.message}\n`);
    process.exit(1);
  });
