# sonar-local-cli

Run real SonarQube/SonarCloud **Connected Mode** analysis from the terminal — no Java
pre-install, no Docker, no MCP server. On first run it downloads a portable JRE
([Eclipse Temurin](https://adoptium.net)) and the analysis engine
([`pavel-zeman/sonarlint-cli`](https://github.com/pavel-zeman/sonarlint-cli), which drives
the same `sonarlint-core`/`sonarlint-language-server` engine the SonarLint IDE plugins use),
caches both under `~/.sonar-local-cli`, then runs the analysis synced against your project's
real quality profile.

## Why

- **SonarLint IDE plugins** are the fastest way to see issues, but they're IDE-only — no CLI,
  no CI, no "run this on a machine without the extension installed."
- **The official `sonar` CLI** (`SonarSource/sonarqube-cli`) needs "Vortex" (SonarCloud's
  server-side AI analysis) for anything beyond secrets scanning — not available on every plan.
- **SonarCloud/SonarQube MCP servers** are great for ad-hoc snippet checks, but full project
  analysis via their tools can hit plan-tier restrictions (e.g. per-branch issue queries), and
  they depend on an MCP client + often Docker being set up and running.

This tool sidesteps all three: it's a thin wrapper that gets a real, Connected-Mode-synced
local analysis with a single command, on any machine with Node ≥18.

## Usage

```bash
npx sonar-local-cli \
  --token <your-sonarcloud-token> \
  --org <your-org-key> \
  --project <your-project-key> \
  --sources backend/app,src
```

Or reuse an existing `sonar-project.properties`:

```bash
npx sonar-local-cli --token <your-token> --properties ./sonar-project.properties
```

`--token` can also be set via `$SONAR_TOKEN`, `--org` via `$SONAR_ORG` — keeps the token out
of shell history in CI or scripts.

Run `npx sonar-local-cli --help` for the full flag list.

**Note:** `--sources`/`--tests` (and the equivalent properties-file keys) must be directories,
not individual file paths — that's a constraint of the underlying `sonarlint-cli` engine.

## What gets cached where

```
~/.sonar-local-cli/
├── jre/21-<os>-<arch>/     # portable JRE, one-time download (~45MB)
└── jar/sonarlint-cli-*.jar # the analysis engine, one-time download (~40MB)
```

Delete `~/.sonar-local-cli` any time to force a clean re-download.

## Output

Issues print in TeamCity's `##teamcity[inspection ...]` format. Grep for `message=` for a
quick scan, or pipe through your own parser if you want structured output. The process exit
code reflects the underlying tool's own exit, not whether issues were found — check the
`Analysis detected N issues` log line for that.

## License

MIT for this wrapper. It downloads and invokes `pavel-zeman/sonarlint-cli` (LGPL-3.0) and
Eclipse Temurin (GPLv2 with the Classpath Exception) as separate, unmodified external
processes/binaries fetched fresh from their own official sources at run time — never bundled
or redistributed inside this package.
