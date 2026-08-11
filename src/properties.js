import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Token is deliberately never written here — it's passed to the analysis process as the
// SONAR_TOKEN env var, which sonarlint-cli reads directly (see Configuration.java: every
// sonar.* property falls back to an uppercased/underscored env var before the file).
export async function resolvePropertiesFile(options) {
  if (options.properties) {
    return { path: options.properties, cleanup: async () => {} };
  }

  const required = ['org', 'project', 'sources'];
  const missing = required.filter((key) => !options[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required option(s): ${missing.map((k) => `--${k}`).join(', ')} ` +
        '(or pass --properties <file> to use an existing sonar-project.properties instead).',
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

  const dir = await mkdtemp(path.join(os.tmpdir(), 'sonar-local-cli-'));
  const filePath = path.join(dir, 'sonar-project.properties');
  await writeFile(filePath, lines.join('\n') + '\n');

  return {
    path: filePath,
    cleanup: async () => {
      await import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true }));
    },
  };
}
