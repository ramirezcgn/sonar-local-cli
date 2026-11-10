import { spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cacheDir } from './platform.js';

// Drives sonarlint-language-server (the same LSP server the VS Code extension launches), either
// with the default rules or bound to a SonarQube Cloud/Server project to use its quality profile.
// The jars below are pinned because the server and the analyzer plugins must be mutually
// compatible; it is the set shipped by SonarLint for VS Code 6.3.0. They come from Maven Central,
// never bundled in this package.
const MAVEN = 'https://repo1.maven.org/maven2';
const SERVER = {
  group: 'org.sonarsource.sonarlint.ls',
  artifact: 'sonarlint-language-server',
  version: '6.3.0.79979',
};
const ANALYZERS = [
  {
    group: 'org.sonarsource.javascript',
    artifact: 'sonar-javascript-plugin',
    version: '14.4.0.46458',
  },
  {
    group: 'org.sonarsource.php',
    artifact: 'sonar-php-plugin',
    version: '4.2.0.27261',
  },
  {
    group: 'org.sonarsource.python',
    artifact: 'sonar-python-plugin',
    version: '5.32.0.37250',
  },
  {
    group: 'org.sonarsource.html',
    artifact: 'sonar-html-plugin',
    version: '3.28.0.8018',
  },
  {
    group: 'org.sonarsource.xml',
    artifact: 'sonar-xml-plugin',
    version: '2.19.0.8138',
  },
];

const LANGUAGES = {
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.vue': 'vue',
  '.php': 'php',
  '.py': 'python',
  '.html': 'html',
  '.xml': 'xml',
  '.css': 'css',
};
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  '.next',
  'coverage',
]);
const SEVERITIES = { 1: 'ERROR', 2: 'WARNING', 3: 'WEAK WARNING', 4: 'INFO' };
const QUIET_MS = 3000;
const POLL_MS = 100;
const TIMEOUT_MS = 10 * 60 * 1000;

const jarName = ({ artifact, version }) => `${artifact}-${version}.jar`;

async function ensureFile(dep, dir, log) {
  const dest = path.join(dir, jarName(dep));
  if (fs.existsSync(dest)) return dest;

  const url = `${MAVEN}/${dep.group.replaceAll('.', '/')}/${dep.artifact}/${dep.version}/${jarName(dep)}`;
  log(`Downloading ${jarName(dep)} (one-time)...`);
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  await writeFile(`${dest}.part`, Buffer.from(await response.arrayBuffer()));
  await rename(`${dest}.part`, dest);
  return dest;
}

export async function ensureEngineJars({ log = () => {} } = {}) {
  const dir = path.join(cacheDir(), 'standalone');
  await mkdir(dir, { recursive: true });
  const [server, ...analyzers] = await Promise.all(
    [SERVER, ...ANALYZERS].map((dep) => ensureFile(dep, dir, log))
  );
  return { server, analyzers };
}

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory())
        return SKIPPED_DIRS.has(entry.name) ? undefined : walk(full, out);
      if (LANGUAGES[path.extname(entry.name)]) out.push(full);
      return undefined;
    })
  );
}

// Sonar patterns: ** crosses directories, * and ? stay within one path segment.
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      const slash = glob[i + 2] === '/';
      re += slash ? '(?:.*/)?' : '.*';
      i += slash ? 2 : 1;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`);
    }
  }
  return new RegExp(`^${re}$`);
}

async function collectInto(target, out) {
  let stats;
  try {
    stats = await stat(target);
  } catch {
    throw new Error(`Path not found: ${target}`);
  }
  if (stats.isDirectory()) await walk(target, out);
  else if (LANGUAGES[path.extname(target)]) out.push(target);
}

// `paths` may mix directories and single files; `exclusions` are sonar.exclusions globs relative
// to baseDir.
export async function collectFiles(baseDir, paths, exclusions = []) {
  const found = [];
  await Promise.all(
    paths.map((p) => collectInto(path.resolve(baseDir, p), found))
  );
  const excluded = exclusions.map(globToRegExp);
  const relative = (file) => path.relative(baseDir, file).replaceAll('\\', '/');
  return [...new Set(found)].filter(
    (file) => !excluded.some((re) => re.test(relative(file)))
  );
}

export function parseMessages(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(
        /Content-Length: (\d+)/i.exec(buf.subarray(0, headerEnd).toString())[1]
      );
      if (buf.length < headerEnd + 4 + length) return;
      onMessage(
        JSON.parse(
          buf.subarray(headerEnd + 4, headerEnd + 4 + length).toString()
        )
      );
      buf = buf.subarray(headerEnd + 4 + length);
    }
  };
}

const CONNECTION_ID = 'sonar-local';
// Last step the server logs when it binds a project: the analyzer configuration is in place.
const SYNC_DONE_RE = /Synchronizing project branches/;
const SYNC_TIMEOUT_MS = 3 * 60 * 1000;
const CLOUD_REGIONS = [
  [/sonarqube\.us/, 'US'],
  [/sonarcloud\.io/, 'EU'],
];

// Settings the server reads through workspace/configuration (section "sonarlint"): the connection
// and the project binding that makes it use the project's quality profile.
export function connectionSettings({ host, org, project, token }) {
  const cloudRegion = CLOUD_REGIONS.find(([re]) => re.test(host))?.[1];
  const connections = cloudRegion
    ? {
        sonarcloud: [
          {
            connectionId: CONNECTION_ID,
            organizationKey: org,
            region: cloudRegion,
            token,
            disableNotifications: true,
          },
        ],
        sonarqube: [],
      }
    : {
        sonarcloud: [],
        sonarqube: [
          {
            connectionId: CONNECTION_ID,
            serverUrl: host,
            token,
            disableNotifications: true,
          },
        ],
      };
  return {
    token,
    connections,
    settings: {
      connectedMode: {
        connections,
        project: { connectionId: CONNECTION_ID, projectKey: project },
      },
      rules: {},
    },
  };
}

// Answers the client-side requests the server blocks on: without isOpenInEditor and
// listFilesInFolder it never starts analyzing; getTokenForServer is how it asks for the token.
export function replyTo(msg, connection, testFilePattern = '') {
  switch (msg.method) {
    case 'workspace/configuration':
      return msg.params.items.map((item) =>
        item.section === 'sonarlint'
          ? { rules: {}, ...connection?.settings, testFilePattern }
          : {}
      );
    case 'sonarlint/isOpenInEditor':
      return true;
    case 'sonarlint/listFilesInFolder':
      return { foundFiles: [] };
    case 'sonarlint/getTokenForServer':
      return connection?.token ?? null;
    default:
      return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate, deadline, pollMs) {
  while (!predicate() && Date.now() < deadline) await sleep(pollMs);
}

// connection (optional): result of connectionSettings(); without it the default rules apply.
const launchServer = (javaBinary, jars) =>
  spawn(
    javaBinary,
    ['-jar', jars.server, '-stdio', '-analyzers', ...jars.analyzers],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );

// `launch` and `quietMs` exist so tests can use a fake language server and short waits.
export async function analyze({
  javaBinary,
  jars,
  baseDir,
  files,
  connection,
  testFilePattern,
  verbose = false,
  launch = launchServer,
  quietMs = QUIET_MS,
}) {
  const child = launch(javaBinary, jars);
  // Never leave the java process behind, whatever makes this run fail.
  process.once('exit', () => child.kill());
  if (verbose) child.stderr.pipe(process.stderr);
  else child.stderr.resume();

  const send = (message) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  };

  const uris = new Map(files.map((file) => [pathToFileURL(file).href, file]));
  const diagnostics = new Map();
  let lastActivity = Date.now();
  let syncDone = false;
  let connectionCheck = null;
  const activeProgress = new Set();
  let progressSeen = false;
  let resolveInit;
  const initialized = new Promise((resolve) => (resolveInit = resolve));

  child.stdout.on(
    'data',
    parseMessages((msg) => {
      lastActivity = Date.now();
      if (msg.method && msg.id !== undefined) {
        send({ id: msg.id, result: replyTo(msg, connection, testFilePattern) });
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        diagnostics.set(msg.params.uri, msg.params.diagnostics);
      } else if (msg.method === 'sonarlint/reportConnectionCheckResult') {
        connectionCheck = msg.params;
      } else if (msg.method === '$/progress') {
        const { kind } = msg.params.value;
        if (kind === 'begin') {
          progressSeen = true;
          activeProgress.add(msg.params.token);
        } else if (kind === 'end') {
          activeProgress.delete(msg.params.token);
        }
      } else if (msg.method === 'window/logMessage') {
        if (SYNC_DONE_RE.test(msg.params.message)) syncDone = true;
        if (verbose) process.stderr.write(`${msg.params.message}\n`);
      } else if (msg.id === 1) {
        resolveInit(msg);
      }
    })
  );

  const rootUri = pathToFileURL(baseDir).href;
  send({
    id: 1,
    method: 'initialize',
    params: {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: path.basename(baseDir) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
      },
      initializationOptions: {
        productKey: 'sonar-local-cli',
        productName: 'sonar-local-cli',
        productVersion: '0.0.0',
        workspaceName: path.basename(baseDir),
        platform: process.platform,
        architecture: process.arch,
        clientNodePath: process.execPath,
        connections: connection?.connections ?? {
          sonarqube: [],
          sonarcloud: [],
        },
        rules: {},
        automaticAnalysis: true,
        disableTelemetry: true,
      },
    },
  });
  await initialized;
  send({ method: 'initialized', params: {} });

  if (connection) {
    // Opening files before the quality profile is synced would analyze them with default rules.
    const syncDeadline = Date.now() + SYNC_TIMEOUT_MS;
    await waitUntil(() => connectionCheck, syncDeadline, POLL_MS);
    if (!connectionCheck?.success) {
      child.kill();
      throw new Error(
        'Could not connect to the server: check the token, organization and host.'
      );
    }
    await waitUntil(() => syncDone, syncDeadline, POLL_MS);
  }

  await Promise.all(
    [...uris].map(async ([uri, file]) => {
      const text = await readFile(file, 'utf8');
      send({
        method: 'textDocument/didOpen',
        params: {
          textDocument: {
            uri,
            languageId: LANGUAGES[path.extname(file)],
            version: 1,
            text,
          },
        },
      });
    })
  );

  // The server has no "analysis finished" signal: done once every file has published, an
  // analysis progress has started and all have ended, and the stream has been quiet for quietMs.
  await waitUntil(
    () =>
      diagnostics.size >= uris.size &&
      progressSeen &&
      activeProgress.size === 0 &&
      Date.now() - lastActivity > quietMs,
    Date.now() + TIMEOUT_MS,
    POLL_MS
  );
  child.kill();

  const issues = [];
  for (const [uri, list] of diagnostics) {
    const file = path
      .relative(baseDir, uris.get(uri) ?? new URL(uri).pathname)
      .replaceAll('\\', '/');
    for (const d of list) {
      issues.push({
        file,
        line: d.range.start.line + 1,
        severity: SEVERITIES[d.severity] ?? 'INFO',
        typeId: d.code,
        message: d.message,
      });
    }
  }
  issues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { issues, analyzed: diagnostics.size, total: uris.size };
}
