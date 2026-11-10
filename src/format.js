// Most to least severe; matches what the language server reports (error, warning, hint levels).
const SEVERITIES = ['ERROR', 'WARNING', 'WEAK WARNING', 'INFO'];

export function formatIssue(issue) {
  const location = `${issue.file}:${issue.line}`;
  return `${issue.severity.padEnd(13)} ${location}  [${issue.typeId}]  ${issue.message}`;
}

// `--fail-on` value ("warning", "weak-warning", ...) to a severity name.
export function parseFailLevel(value) {
  const name = (value === 'any' ? 'info' : value)
    .toUpperCase()
    .replaceAll('-', ' ');
  if (!SEVERITIES.includes(name)) {
    throw new Error(
      `Invalid --fail-on "${value}": use one of ${SEVERITIES.map((s) => s.toLowerCase().replaceAll(' ', '-')).join(', ')}, any.`
    );
  }
  return name;
}

// 0 clean or tolerated; 2 when an issue is at least as severe as `threshold`; 1 is reserved for
// real failures.
export function exitCodeFor(issues, threshold) {
  if (!threshold) return 0;
  const limit = SEVERITIES.indexOf(threshold);
  return issues.some((i) => SEVERITIES.indexOf(i.severity) <= limit) ? 2 : 0;
}
