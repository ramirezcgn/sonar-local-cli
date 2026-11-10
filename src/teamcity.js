// Minimal parser for the TeamCity service-message format sonarlint-cli prints issues in
// (##teamcity[inspection key='value' ...]). Its sibling ##teamcity[inspectionType ...] messages
// carry each rule's full HTML documentation — useful context, but far too noisy for a terminal
// summary by default, so callers filter to just "inspection" messages.
//
// Escaping per the TeamCity spec: |' |n |r |[ |] || for ' \n \r [ ] |. The (?:[^'|]|\|.) pattern
// treats every "| + next char" pair as one atomic unit, so it never mistakes an escaped |' for the
// real closing quote.
const MESSAGE_RE = /##teamcity\[(\w+)((?:\s+\w+='(?:[^'|]|\|.)*')*)\s*\]/g;
const ATTR_RE = /(\w+)='((?:[^'|]|\|.)*)'/g;

function unescapeTeamCity(value) {
  return value
    .replace(/\|n/g, '\n')
    .replace(/\|r/g, '\r')
    .replace(/\|\[/g, '[')
    .replace(/\|\]/g, ']')
    .replace(/\|'/g, "'")
    .replace(/\|\|/g, '|');
}

function parseAttrs(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let match;
  while ((match = ATTR_RE.exec(raw))) {
    attrs[match[1]] = unescapeTeamCity(match[2]);
  }
  return attrs;
}

export function parseInspections(output) {
  const inspections = [];
  MESSAGE_RE.lastIndex = 0;
  let match;
  while ((match = MESSAGE_RE.exec(output))) {
    const [, name, attrsRaw] = match;
    if (name !== 'inspection') continue;
    inspections.push(parseAttrs(attrsRaw));
  }
  return inspections;
}

// sonarlint-cli's own plain-text summary line, e.g. "Analysis detected 3 issues and 1 Security
// Hotspots in 4176ms" — treated as the authoritative count (inspections.length only covers
// CODE_SMELL/BUG/VULNERABILITY messages, not whatever message type Security Hotspots use).
export function parseSummaryLine(output) {
  const match = output.match(
    /Analysis detected (\d+) issues? and (\d+) Security Hotspots?/
  );
  if (!match) return null;
  return { issues: Number(match[1]), securityHotspots: Number(match[2]) };
}

export function formatInspection(inspection) {
  const location = inspection.line
    ? `${inspection.file}:${inspection.line}`
    : (inspection.file ?? '?');
  const severity = (inspection.severity ?? '').padEnd(13);
  const rule = inspection.typeId ?? '?';
  return `${severity} ${location}  [${rule}]  ${inspection.message ?? ''}`;
}
