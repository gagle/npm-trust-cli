<h1 align="center">npm-trust-cli</h1>

<p align="center">
  Bulk-configure npm OIDC Trusted Publishing for every package in your npm scope.
</p>

<p align="center">
  <a href="https://github.com/gagle/npm-trust-cli/blob/main/LICENSE"><img src="https://img.shields.io/github/license/gagle/npm-trust-cli" alt="license" /></a>
  <a href="https://www.npmjs.com/package/npm-trust-cli"><img src="https://img.shields.io/npm/v/npm-trust-cli" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/npm-trust-cli"><img src="https://img.shields.io/npm/dm/npm-trust-cli" alt="npm downloads" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/node/v/npm-trust-cli" alt="node version" /></a>
</p>

---

> **Built for LLM consumption.** Every entry point is shaped for an agent to drive end to end:
>
> - A bundled **Claude Code skill** (`npx npm-trust-cli --init-skill`) that walks an agent through detect → diff → manual auth pauses → configure → verify, with no per-project setup.
> - **Filesystem auto-detection** (`--auto`) that removes the "what packages live here?" guesswork — works for pnpm/npm/yarn workspaces and single-package repos, picks up scope from package names automatically.
> - **`--only-new`** for incremental setup so the agent doesn't waste calls re-checking packages that are already trust-configured.
> - A **typed programmatic API** alongside the CLI (`discoverFromCwd`, `checkPackageStatuses`, `findUnconfiguredPackages`, `configureTrust`, …) so an agent can choose between spawning the binary or importing the library — same primitives, same data shapes.
> - **Deterministic output**: every package status comes back as one of `configured | already | not_published | auth_failed | error`, so an agent can branch on the result without parsing prose.

## The problem

npm OIDC Trusted Publishing lets GitHub Actions publish packages without secrets or expiring tokens. But it requires **per-package configuration** on npmjs.com. If you maintain an npm org with 10, 50, or 100+ packages, setting up each one manually through the web UI is tedious and error-prone.

## The solution

`npm-trust-cli` bulk-configures OIDC Trusted Publishing for every package in your npm scope from a single command. It auto-discovers all published packages in your org, handles npm 2FA authentication once, and configures the rest automatically.

## Use cases

Pick the section that matches your situation. Each one shows the command to run and what to expect.

### 1. First-time setup for an org

You've published a batch of packages under your npm scope and need to enable OIDC trust for all of them in one go.

```bash
npx npm-trust-cli --scope @myorg --repo myorg/release-pipeline --workflow release.yml
```

The CLI auto-discovers every published package in the scope, configures each one, and reports a summary at the end. The first package triggers a browser auth flow; on the npm site, choose "skip 2FA for the next 5 minutes" so the rest finish without further prompts.

### 2. Adding new packages to an existing trusted setup

You already configured OIDC for your org's packages and just published one or more new ones. Combine `--scope` with `--only-new` to filter automatically — the CLI runs `npm trust list` and `npm view` per package and configures only the ones missing trust or not yet published.

```bash
npx npm-trust-cli --scope @myorg --repo myorg/release-pipeline --workflow release.yml --only-new
```

`--only-new` works with any source (`--scope`, `--packages`, or `--auto`).

### 3. A single-package project

You maintain a standalone npm package (no monorepo, no scope-wide setup). Run from the repo root and let `--auto` read `./package.json`:

```bash
cd ~/projects/my-package
npx npm-trust-cli --auto --repo me/my-repo --workflow release.yml
```

If you'd rather be explicit:

```bash
npx npm-trust-cli --packages my-package --repo me/my-repo --workflow release.yml
```

### 4. A monorepo (pnpm / npm / yarn workspaces, with or without NX)

You maintain a monorepo with multiple publishable packages — for example `packages/foo`, `packages/bar`, `apps/something`. Run from the repo root with `--auto`:

```bash
cd ~/projects/my-monorepo
npx npm-trust-cli --auto --repo myorg/repo --workflow release.yml
```

Detection priority: `pnpm-workspace.yaml` → `package.json#workspaces` → single `./package.json`. Packages marked `private: true` are skipped.

If every published package shares the same scope, `--scope @myorg` is also a one-liner. For ad-hoc lists, `--packages` still works.

### 5. Auditing — checking what's already trusted

To inspect current trust status without making changes:

```bash
npx npm-trust-cli --scope @myorg --list
```

To preview what `configure` would do:

```bash
npx npm-trust-cli --scope @myorg --repo myorg/repo --workflow release.yml --dry-run
```

## What happens during execution

1. The CLI discovers all packages in your npm scope (or uses the list you provide).
2. For each package, it runs `npm trust github` to configure OIDC trust.
3. If npm requires 2FA, the CLI pauses and opens a browser-based authentication prompt. You authenticate once — npm caches the session for ~5 minutes, long enough to configure the remaining packages.
4. Packages already configured are silently skipped. Unpublished packages are reported so you know to publish them first.
5. At the end, a summary shows how many were configured, already set, or failed.

## Requirements

- Node.js >= 24.0.0
- npm >= 11.5.1 (for `npm trust` support)
- 2FA enabled on your npm account
- Write access to the packages you're configuring

## Options

| Flag                  | Description                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `--scope <scope>`     | npm org scope (e.g. `@myorg`) — auto-discovers all published packages                      |
| `--packages <pkg...>` | explicit package names (alternative to `--scope`)                                          |
| `--auto`              | detect packages from the current directory (workspaces or single `package.json`)           |
| `--repo <owner/repo>` | GitHub repository                                                                          |
| `--workflow <file>`   | GitHub Actions workflow filename (e.g. `release.yml`)                                      |
| `--list`              | list current trust status instead of configuring                                           |
| `--only-new`          | filter the resolved package list to those without OIDC trust yet, or not yet published     |
| `--dry-run`           | show what would be done without making changes                                             |
| `--help`              | show help message                                                                          |

## Example output

```
Discovering packages in scope @myorg...
Found 12 packages

Configuring OIDC trusted publishing for 12 packages in @myorg
Repo: owner/repo | Workflow: release.yml

@myorg/core                    ✓ configured
@myorg/cli                     ✓ configured
@myorg/utils                   ✓ already configured
@myorg/new-pkg                 ✗ not published yet

Done: 2 configured, 9 already set, 1 failed

Failed packages (publish first, then re-run):
  - @myorg/new-pkg
```

## Programmatic usage

`npm-trust-cli` is published as a dual CLI + library. The same package exposes a typed public API for use inside other tools, scripts, or CIs.

```ts
import {
  checkPackageStatuses,
  configureTrust,
  discoverFromCwd,
  discoverPackages,
  findUnconfiguredPackages,
  listTrust,
  runCli,
} from "npm-trust-cli";
```

### `discoverPackages(scope)`

Discovers all published packages in an npm scope by paginating the public registry search API.

| Parameter | Type     | Description                                                            |
| --------- | -------- | ---------------------------------------------------------------------- |
| `scope`   | `string` | The npm scope (with or without leading `@`, e.g. `@myorg` or `myorg`). |

**Returns:** `Promise<Array<string>>` — sorted package names in the scope.

**Throws** if the registry response is malformed, the registry URL is invalid, or the request times out (15 s).

```ts
const packages = await discoverPackages("@myorg");
```

### `discoverFromCwd(cwd)`

Detects packages from a directory's filesystem layout: `pnpm-workspace.yaml` → `package.json#workspaces` → single `./package.json`. Packages marked `private: true` are skipped.

| Parameter | Type     | Description                                              |
| --------- | -------- | -------------------------------------------------------- |
| `cwd`     | `string` | Absolute path to the directory to inspect (often `process.cwd()`). |

**Returns:** `Promise<DiscoveredWorkspace | null>`

```ts
interface DiscoveredWorkspace {
  readonly source: "pnpm-workspace" | "npm-workspace" | "single-package";
  readonly packages: ReadonlyArray<string>;
}
```

```ts
const detected = await discoverFromCwd(process.cwd());
if (detected !== null) {
  console.log(`Found ${detected.packages.length} packages in ${detected.source}`);
}
```

### `checkPackageStatuses(packages)` and `findUnconfiguredPackages(packages)`

Both call `npm trust list <pkg>` (to detect existing OIDC trust) and `npm view <pkg>` (to detect publication) for each package.

`checkPackageStatuses` returns the full status of every package — useful for orchestration code (e.g. a wizard) that needs to differentiate "unpublished" from "missing trust":

```ts
interface PackageStatus {
  readonly pkg: string;
  readonly trustConfigured: boolean;
  readonly published: boolean;
}
```

`findUnconfiguredPackages` is a convenience filter over the same data — keeps any package that lacks trust **or** isn't yet published.

```ts
const statuses = checkPackageStatuses(["@myorg/foo", "@myorg/new"]);
const unconfigured = findUnconfiguredPackages(["@myorg/foo", "@myorg/new"]);
```

### `configureTrust(options)`

Runs `npm trust github <pkg> --repo <r> --file <w> --yes` for every package and aggregates the results.

| Option         | Type                       | Default            | Description                                                              |
| -------------- | -------------------------- | ------------------ | ------------------------------------------------------------------------ |
| `packages`     | `ReadonlyArray<string>`    | (required)         | Package names to configure.                                              |
| `repo`         | `string`                   | (required)         | GitHub `owner/repo`.                                                     |
| `workflow`     | `string`                   | (required)         | GitHub Actions workflow file (`*.yml` / `*.yaml`).                       |
| `dryRun`       | `boolean`                  | `false`            | Print what would happen without invoking npm.                            |
| `logger`       | `Logger`                   | `console`          | `{ log, error }` — supply a capturing logger to suppress stdout.         |

> **2FA:** `npm trust` uses **web-based 2FA only** — there is no OTP/TOTP flag
> to pass programmatically. The first call opens a browser auth flow; on the
> npm site, enable the "skip 2FA for the next 5 minutes" option to let bulk
> calls proceed without re-authenticating. `configureTrust` falls back to an
> interactive prompt automatically when run from a TTY; in non-TTY contexts
> (CI without an OIDC issuer) it returns `auth_failed` immediately.

**Returns:** `TrustSummary`

```ts
interface TrustSummary {
  readonly configured: number;
  readonly already: number;
  readonly failed: number;
  readonly failedPackages: ReadonlyArray<string>;
}
```

```ts
const summary = configureTrust({
  packages: ["@myorg/foo", "@myorg/bar"],
  repo: "owner/repo",
  workflow: "release.yml",
});

if (summary.failed > 0) {
  console.error("Failed:", summary.failedPackages);
  process.exit(1);
}
```

### `listTrust(options)`

Runs `npm trust list <pkg>` for each package and prints the current trust configuration.

| Option     | Type                    | Default    | Description                                |
| ---------- | ----------------------- | ---------- | ------------------------------------------ |
| `packages` | `ReadonlyArray<string>` | (required) | Package names to query.                    |
| `logger`   | `Logger`                | `console`  | `{ log, error }` — destination for output. |

**Returns:** `void`.

```ts
listTrust({ packages: await discoverPackages("@myorg") });
```

### `runCli(argv, logger?)`

The same entry point used by the `bin` script. Useful for embedding the full CLI behaviour inside larger tools without spawning a child process. Returns the exit code instead of calling `process.exit`.

| Parameter | Type                         | Default   | Description                                                       |
| --------- | ---------------------------- | --------- | ----------------------------------------------------------------- |
| `argv`    | `ReadonlyArray<string>`      | (required) | The argument list, equivalent to `process.argv.slice(2)`.        |
| `logger`  | `Logger`                     | `console` | `{ log, error }` — supply a capturing logger to suppress output. |

**Returns:** `Promise<number>` — process exit code.

```ts
const code = await runCli(["--scope", "@myorg", "--list"]);
process.exit(code);
```

## Use from a Claude Code agent

`npm-trust-cli` ships with a Claude Code skill that wraps the wizard flow:
detect packages → diff → walk the user through `npm login` and any required
publishes → configure → verify. The skill is a single Markdown file with
plain bash steps; any agent that loads `.claude/skills/` can use it.

The CLI installs it for you:

```bash
npx npm-trust-cli --init-skill
```

This copies the bundled `skills/setup-npm-trust/SKILL.md` to
`./.claude/skills/setup-npm-trust/SKILL.md`. Refuses to overwrite an existing
file — delete it first if you want to refresh.

If you'd rather copy by hand:

```bash
mkdir -p .claude/skills
cp -r node_modules/npm-trust-cli/skills/setup-npm-trust .claude/skills/
```

In Claude Code, invoke `/setup-npm-trust` (or just describe the task — the
agent will pick the skill up automatically).

The source lives at [`skills/setup-npm-trust/SKILL.md`](skills/setup-npm-trust/SKILL.md)
in this repo if you want to read it without installing first.

## Environment variables

| Variable                  | Default                       | Description                                                                                                                                       |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TRUST_CLI_NPM`       | `<dirname(process.execPath)>/npm` | Override the path to the `npm` binary. Used in tests; rarely needed in production.                                                            |
| `NPM_TRUST_CLI_REGISTRY`  | `https://registry.npmjs.org`  | Override the registry used for package discovery. Must be `https://...`, or `http://localhost` / `http://127.0.0.1` for local mirrors and tests. |
