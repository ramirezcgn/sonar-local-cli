#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { ensureJar } from '../src/jar.js';
import { ensureJre } from '../src/jre.js';
import { resolvePropertiesFile } from '../src/properties.js';

const HELP = `sonar-local — run real SonarQube/SonarCloud Connected-Mode analysis locally.

No Java pre-install, no Docker, no MCP server: downloads a portable JRE and the
sonarlint-cli analysis engine on first run (cached under ~/.sonar-local-cli after that),
then drives the same engine SonarLint IDE plugins use, synced against your project's
real quality profile.

Usage:
  sonar-local --token <token> --org <org> --project <projectKey> --sources <dir[,dir...]> [options]
  sonar-local --token <token> --properties <path/to/sonar-project.properties>

Options:
  --token <token>        SonarQube/SonarCloud token. Falls back to $SONAR_TOKEN.
  --org <org>             SonarCloud organization key. Falls back to $SONAR_ORG.
  --host <url>            Server URL. Default: https://sonarcloud.io
  --project <key>         Project key.
  --sources <dirs>        Comma-separated source directories (relative to --base-dir).
                          Must be directories, not individual files.
  --tests <dirs>          Comma-separated test directories, same rule as --sources.
  --base-dir <path>       Project root. Default: current directory.
  --properties <path>     Use an existing sonar-project.properties file instead of
                          --org/--project/--sources/--tests.
  -h, --help              Show this help.

Output prints in TeamCity ##teamcity[inspection ...] format — grep for "message=" for a
quick read. Exit code reflects the tool's own process exit, not whether issues were found;
check the "Analysis detected N issues" log line for that.
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
      help: { type: 'boolean', short: 'h' },
    },
  });

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

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
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawn(javaBinary, ['-jar', jarPath, propertiesPath], {
        stdio: 'inherit',
        env: { ...process.env, SONAR_TOKEN: token },
      });
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
    return exitCode;
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
