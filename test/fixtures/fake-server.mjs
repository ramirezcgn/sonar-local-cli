// Minimal stand-in for sonarlint-language-server, speaking just enough LSP over stdio for the
// engine's flow. FAKE_CHECK=ok|fail|none controls the connection check a bound server reports.
import { parseMessages } from '../../src/engine.js';

const check = process.env.FAKE_CHECK ?? 'none';
const CRLF = String.fromCharCode(13, 10);

const send = (message) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }));
  process.stdout.write(`Content-Length: ${body.length}${CRLF}${CRLF}`);
  process.stdout.write(body);
};
const log = (message) =>
  send({ method: 'window/logMessage', params: { type: 3, message } });

let syncDone = check === 'none';
let tokenAnswer = null;
let project = null;

function startSync() {
  send({
    method: 'sonarlint/reportConnectionCheckResult',
    params: { connectionId: 'sonar-local', success: check === 'ok' },
  });
  if (check !== 'ok') return;
  [0, 150].forEach((delay) =>
    setTimeout(() => log(`[SYNC] step at ${delay}`), delay)
  );
  setTimeout(() => {
    log("Synchronizing project branches for project 'p'");
    syncDone = true;
  }, 300);
}

function publish(textDocument) {
  const flagged = textDocument.text.includes('ISSUE');
  const diagnostics = flagged
    ? [
        {
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
          severity: 2,
          code: 'js:S1',
          message: `early=${!syncDone} token=${tokenAnswer} project=${project}`,
        },
      ]
    : [];
  send({
    method: '$/progress',
    params: { token: 't', value: { kind: 'begin' } },
  });
  send({
    method: 'textDocument/publishDiagnostics',
    params: { uri: textDocument.uri, diagnostics },
  });
  send({
    method: '$/progress',
    params: { token: 't', value: { kind: 'end' } },
  });
}

process.stdin.on(
  'data',
  parseMessages((msg) => {
    if (msg.method === 'initialize') {
      send({ id: msg.id, result: { capabilities: {} } });
    } else if (msg.method === 'initialized') {
      send({
        id: 100,
        method: 'sonarlint/getTokenForServer',
        params: ['EU_org'],
      });
      send({
        id: 101,
        method: 'workspace/configuration',
        params: { items: [{ section: 'sonarlint' }] },
      });
      if (check !== 'none') startSync();
    } else if (msg.id === 100) {
      tokenAnswer = msg.result;
    } else if (msg.id === 101) {
      project = msg.result[0]?.connectedMode?.project?.projectKey ?? null;
    } else if (msg.method === 'textDocument/didOpen') {
      publish(msg.params.textDocument);
    }
  })
);
