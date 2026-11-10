import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { cacheDir } from './platform.js';

// Standalone mode drives sonarlint-language-server (the same LSP server the VS Code extension
// launches) with the default rules and no server connection. The set below is pinned because the
// server and the analyzer plugins must be mutually compatible; it is the one shipped by
// SonarLint for VS Code 6.3.0. Jars come from Maven Central, never bundled in this package.
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

export async function ensureStandaloneJars({ log = () => {} } = {}) {
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

export async function collectFiles(baseDir, dirs) {
  const files = [];
  await Promise.all(dirs.map((dir) => walk(path.resolve(baseDir, dir), files)));
  return [...new Set(files)];
}

function parseMessages(onMessage) {
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

// Answers the few client-side requests the server blocks on; without isOpenInEditor and
// listFilesInFolder it never starts analyzing.
function replyTo(msg) {
  switch (msg.method) {
    case 'workspace/configuration':
      return msg.params.items.map(() => ({}));
    case 'sonarlint/isOpenInEditor':
      return true;
    case 'sonarlint/listFilesInFolder':
      return { foundFiles: [] };
    default:
      return null;
  }
}

export async function analyzeStandalone({
  javaBinary,
  jars,
  baseDir,
  files,
  verbose = false,
}) {
  const child = spawn(
    javaBinary,
    ['-jar', jars.server, '-stdio', '-analyzers', ...jars.analyzers],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
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
  const activeProgress = new Set();
  let progressSeen = false;
  let resolveInit;
  const initialized = new Promise((resolve) => (resolveInit = resolve));

  child.stdout.on(
    'data',
    parseMessages((msg) => {
      lastActivity = Date.now();
      if (msg.method && msg.id !== undefined) {
        send({ id: msg.id, result: replyTo(msg) });
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        diagnostics.set(msg.params.uri, msg.params.diagnostics);
      } else if (msg.method === '$/progress') {
        const { kind } = msg.params.value;
        if (kind === 'begin') {
          progressSeen = true;
          activeProgress.add(msg.params.token);
        } else if (kind === 'end') {
          activeProgress.delete(msg.params.token);
        }
      } else if (msg.method === 'window/logMessage' && verbose) {
        process.stderr.write(`${msg.params.message}\n`);
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
        connections: { sonarqube: [], sonarcloud: [] },
        rules: {},
        automaticAnalysis: true,
        disableTelemetry: true,
      },
    },
  });
  await initialized;
  send({ method: 'initialized', params: {} });

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
  // analysis progress has started and all have ended, and the stream has been quiet for QUIET_MS.
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const settled =
      progressSeen &&
      activeProgress.size === 0 &&
      Date.now() - lastActivity > QUIET_MS;
    if (diagnostics.size >= uris.size && settled) break;
  }
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
