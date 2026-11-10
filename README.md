# sonar-local-cli

Run SonarQube/SonarCloud analysis from the terminal, **bound to your project** (Connected
Mode) or with the default rules — no Java pre-install, no Docker, no MCP server. On first run
it downloads a portable JRE ([Eclipse Temurin](https://adoptium.net)) and the SonarLint
language server with its analyzers (from Maven Central), caches them under
`~/.sonar-local-cli`, and drives the same engine the SonarLint IDE plugins use.

## Why

- **SonarLint IDE plugins** are the fastest way to see issues, but they're IDE-only — no CLI,
  no CI, no "run this on a machine without the extension installed."
- **The official `sonar` CLI** (`SonarSource/sonarqube-cli`) needs "Vortex" (SonarCloud's
  server-side AI analysis) for anything beyond secrets scanning — not available on every plan.
- **SonarCloud/SonarQube MCP servers** are great for ad-hoc snippet checks, but full project
  analysis via their tools can hit plan-tier restrictions (e.g. per-branch issue queries), and
  they depend on an MCP client + often Docker being set up and running.

This tool sidesteps all three: one command, on any machine with Node ≥21.7.

## Two modes

- **Connected Mode** (a token is available): the project's real quality profile is applied.
  The server is bound to your project (`--project`, `--org`, `--host`) and downloads its rules
  before analyzing.
- **Standalone** (no token, or `--standalone`): the default rules, no server connection.

## Usage

```bash
# Standalone: default rules
npx sonar-local-cli --sources backend/app,src/index.ts   # default: current directory

# Connected Mode
npx sonar-local-cli \
  --token <your-sonarcloud-token> \
  --org <your-org-key> \
  --project <your-project-key> \
  --sources backend/app,src
```

`--sources` and `--tests` take **directories and single files**, relative to the current
directory. An explicit `--sources` narrows the run: the `sonar.tests` of the properties file
are left out unless you also pass `--tests`.

### Using a `sonar-project.properties`

If `--base-dir` (default: the current directory) contains a `sonar-project.properties`, it is
picked up automatically, unless you pass `--project`. Use `--properties <path>` for another
file. These keys are read: `sonar.sources`, `sonar.tests`, `sonar.exclusions`,
`sonar.test.inclusions`, `sonar.projectBaseDir`, `sonar.projectKey`, `sonar.organization` and
`sonar.host.url`. `--project`, `--org`, `--host`, `--sources` and `--tests` override the file.

```bash
npx sonar-local-cli --token <your-token> --sources backend/app/SomeModule
```

### Token and `.env`

Drop a `.env` file (gitignored — never commit a real token) in `--base-dir`:

```
SONAR_TOKEN=your-token-here
SONAR_ORG=your-org-key
```

It's picked up automatically. Point at a different file with `--env-file <path>`. Variables
already set in the environment win over the file. `--token` and `--org` override both.

### A sub-project inside a monorepo

Run from the sub-project and point `--base-dir` at the repository root, where the `.env` and
the properties file live. Paths you type stay relative to where you are:

```bash
cd catalog && npx sonar-local-cli --base-dir .. --sources src
```

Run `npx sonar-local-cli --help` for the full flag list.

## What gets cached where

```
~/.sonar-local-cli/
├── jre/21-<os>-<arch>/   # portable JRE, one-time download (~45MB)
└── standalone/           # language server + analyzers (JS/TS, PHP, Python, HTML, XML), one-time
```

Delete `~/.sonar-local-cli` any time to force a clean re-download. The jars are pinned to the
set shipped with SonarLint for VS Code 6.3.0, because the server and the analyzers must be
mutually compatible. JS/TS analysis needs Node on the machine.

## Output

One line per issue — severity, `file:line`, rule, message — plus a final count:

```
WARNING       pos/src/components/Foo.tsx:83  [typescript:S9011]  Add an explicit "type" attribute to this button.

1 issue(s) in 42/42 file(s).
```

Pass `--verbose`/`-v` to stream the language server's own log.

Exit codes: `0` when the analysis ran (issues or not), `2` when an issue matches
`--fail-on <level>` (e.g. a pre-commit hook), `1` on a real failure (bad config, connection
error). Levels, most to least severe: `error`, `warning`, `weak-warning`, `info`. `--fail-on
warning` fails on errors and warnings but tolerates the rest; `--fail-on-issues` is shorthand
for `--fail-on any`.

## Development

```bash
npm test                          # unit tests, no network, no Java
SONAR_LOCAL_E2E=1 npm test        # also runs one real standalone analysis (downloads the JRE and jars)
npm run format:check
```

The unit tests drive the whole analysis flow against a fake language server
(`test/fixtures/fake-server.mjs`), so the connection, sync and token handling are covered
without a SonarCloud account. A real Connected Mode run needs a token, e.g.
`npx sonar-local-cli --base-dir <repo> --sources <dir>`.

## License

MIT for this wrapper. It downloads and invokes Eclipse Temurin, the SonarLint language server
and the SonarSource analyzers as separate, unmodified external binaries fetched at run time
from their own official sources (Adoptium, Maven Central), each under its own license — never
bundled or redistributed inside this package.
