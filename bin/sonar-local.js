#!/usr/bin/env node

import { parseArgs } from 'node:util';

import {
  analyze,
  collectFiles,
  connectionSettings,
  ensureEngineJars,
} from '../src/engine.js';
import { exitCodeFor, formatIssue, parseFailLevel } from '../src/format.js';
import { ensureJre } from '../src/jre.js';
import { resolveOptions } from '../src/options.js';

const HELP = `sonar-local — run SonarQube/SonarCloud analysis locally.

No Java pre-install, no Docker, no MCP server: downloads a portable JRE and the SonarLint
language server with its analyzers on first run (cached under ~/.sonar-local-cli after that).

With a token it runs in Connected Mode: bound to your project, so it applies the project's real
quality profile. Without a token (or with --standalone) it uses the default rules, no server.

Usage:
  sonar-local [--sources <path[,path...]>]                              (standalone, no token)
  sonar-local --token <token> --org <org> --project <projectKey> [--sources <path[,path...]>]
  sonar-local --token <token> --properties <path/to/sonar-project.properties>

Options:
  --token <token>         SonarQube/SonarCloud token. Falls back to $SONAR_TOKEN, which in turn
                          can come from a .env file — see --env-file.
  --org <org>             SonarCloud organization key. Falls back to $SONAR_ORG, then to
                          sonar.organization in the properties file.
  --env-file <path>       Load env vars (SONAR_TOKEN, SONAR_ORG, ...) from a dotenv-format file.
                          Default: .env in --base-dir, if one exists (silently skipped otherwise).
  --host <url>            Server URL. Default: sonar.host.url from the properties file, else
                          https://sonarcloud.io
  --project <key>         Project key. Falls back to sonar.projectKey in the properties file.
  --sources <paths>       Comma-separated directories or single files to analyze. Default:
                          sonar.sources from the properties file, else the base directory.
  --tests <paths>         Comma-separated test directories or files, same rule as --sources.
  --base-dir <path>       Project root, and where .env and sonar-project.properties are looked
                          up when not given explicitly. All explicit paths (--sources, --tests,
                          --properties, --env-file) are relative to the current directory.
                          Default: current directory (with --properties: that file's directory).
  --properties <path>     sonar-project.properties to read sonar.sources, sonar.tests,
                          sonar.exclusions, sonar.projectKey, sonar.organization, sonar.host.url
                          and sonar.projectBaseDir from. Default: the one in --base-dir, if it
                          exists and --project is not given.
  --standalone            Force default rules even when a token is available.
  --fail-on <level>       Exit with code 2 when an issue is at least this severe: error, warning,
                          weak-warning, info (or any). For a pre-commit hook.
  --fail-on-issues        Same as --fail-on any.
  --verbose, -v           Stream the language server's own log (analyzers, synchronization).
  -h, --help              Show this help.

Prints one line per issue (severity, file:line, rule, message) and a final count. Exit codes: 0
when the analysis ran (issues or not), 2 when --fail-on / --fail-on-issues matches an issue, 1 on a
real failure (bad config, connection error).
`;

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
      standalone: { type: 'boolean' },
      'fail-on-issues': { type: 'boolean' },
      'fail-on': { type: 'string' },
      verbose: { type: 'boolean', short: 'v' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const failThreshold = values['fail-on']
    ? parseFailLevel(values['fail-on'])
    : values['fail-on-issues'] && 'INFO';
  const log = (msg) => process.stderr.write(`[sonar-local] ${msg}\n`);
  const { baseDir, paths, exclusions, testFilePattern, connection } =
    await resolveOptions(values);

  const files = await collectFiles(baseDir, paths, exclusions);
  if (files.length === 0) {
    log('No analyzable files found in the given sources.');
    return 1;
  }

  log(
    connection
      ? `Connected mode: ${connection.project} on ${connection.host}.`
      : 'No token: standalone mode (default rules, no server connection).'
  );
  const [javaBinary, jars] = await Promise.all([
    ensureJre({ log }),
    ensureEngineJars({ log }),
  ]);
  const { issues, analyzed, total } = await analyze({
    javaBinary,
    jars,
    baseDir,
    files,
    connection: connection && connectionSettings(connection),
    testFilePattern,
    verbose: values.verbose,
  });

  for (const issue of issues) process.stdout.write(formatIssue(issue) + '\n');
  process.stdout.write(
    `\n${issues.length} issue(s) in ${analyzed}/${total} file(s).\n`
  );
  return exitCodeFor(issues, failThreshold);
}

try {
  process.exit(await main());
} catch (error) {
  process.stderr.write(`[sonar-local] ${error.message}\n`);
  process.exit(1);
}
