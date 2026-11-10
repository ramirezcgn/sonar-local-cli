import assert from 'node:assert/strict';
import { test } from 'node:test';

import { exitCodeFor, formatIssue, parseFailLevel } from '../src/format.js';

test('formats severity, location, rule and message on one line', () => {
  const line = formatIssue({
    severity: 'WARNING',
    file: 'src/a.ts',
    line: 12,
    typeId: 'typescript:S1481',
    message: 'Remove the unused variable.',
  });
  assert.equal(
    line,
    'WARNING       src/a.ts:12  [typescript:S1481]  Remove the unused variable.'
  );
});

test('parseFailLevel accepts the documented names and rejects the rest', () => {
  assert.equal(parseFailLevel('error'), 'ERROR');
  assert.equal(parseFailLevel('weak-warning'), 'WEAK WARNING');
  assert.equal(parseFailLevel('any'), 'INFO');
  assert.throws(
    () => parseFailLevel('critical'),
    /Invalid --fail-on "critical"/
  );
});

test('exit code is 2 only when an issue reaches the threshold', () => {
  const at = (severity) => [{ severity }];
  assert.equal(exitCodeFor(at('WARNING'), null), 0);
  assert.equal(exitCodeFor(at('WARNING'), false), 0);
  assert.equal(exitCodeFor(at('ERROR'), 'WARNING'), 2);
  assert.equal(exitCodeFor(at('WARNING'), 'WARNING'), 2);
  assert.equal(exitCodeFor(at('WEAK WARNING'), 'WARNING'), 0);
  assert.equal(exitCodeFor(at('INFO'), 'INFO'), 2);
  assert.equal(exitCodeFor([], 'INFO'), 0);
});
