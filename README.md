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

You already configured OIDC for your org's packages and just published one or more new ones. You want to enable trust only for the new ones — without re-touching the rest.

```bash
npx npm-trust-cli --packages @myorg/new-pkg --repo myorg/release-pipeline --workflow release.yml
```

For multiple new packages:

```bash
npx npm-trust-cli --packages @myorg/new-a @myorg/new-b --repo myorg/release-pipeline --workflow release.yml
```

> A `--only-new` flag is on the [roadmap](#roadmap) — it will diff against existing trust configurations so you don't have to track which packages are new.

### 3. A single-package project

You maintain a standalone npm package (no monorepo, no scope-wide setup). The package name comes from your repo's `package.json`.

```bash
npx npm-trust-cli --packages my-package --repo me/my-repo --workflow release.yml
```

> A `--auto` flag is on the [roadmap](#roadmap) — it will read `./package.json` and pick up the package name automatically.

### 4. A monorepo (pnpm / npm / yarn workspaces, with or without NX)

You maintain a monorepo with multiple publishable packages — for example `packages/foo`, `packages/bar`, `apps/something`. List the publishable package names explicitly:

```bash
npx npm-trust-cli --packages @myorg/foo @myorg/bar --repo myorg/repo --workflow release.yml
```

If every package shares the same scope, `--scope` is shorter. If scopes differ (or some are unscoped), stick with `--packages`.

> A `--auto` flag is on the [roadmap](#roadmap) — it will detect `pnpm-workspace.yaml` or `package.json#workspaces`, expand the globs, and skip packages marked `private: true`.

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

| Flag                  | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `--scope <scope>`     | npm org scope (e.g. `@myorg`) — auto-discovers all published packages |
| `--packages <pkg...>` | explicit package names (alternative to `--scope`)                     |
| `--repo <owner/repo>` | GitHub repository                                                     |
| `--workflow <file>`   | GitHub Actions workflow filename (e.g. `release.yml`)                 |
| `--list`              | list current trust status instead of configuring                      |
| `--dry-run`           | show what would be done without making changes                        |
| `--help`              | show help message                                                     |

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

## Roadmap

Upcoming releases will smooth out the manual steps shown in the use cases above:

- **`--auto`** — detect packages automatically from `pnpm-workspace.yaml`, `package.json#workspaces`, or a single root `package.json`. Removes the need to list packages by hand for monorepos and single-package projects.
- **`--only-new`** — filter to packages that don't yet have OIDC trust configured. Removes the need to track which packages are "new" after incremental publishes.
- **Guided wizard (Claude Code skill)** — a skill at `~/projects/ncbijs/.claude/skills/setup-npm-trust/` (separate plan) will orchestrate the full flow: detect → diff → prompt for `npm login` if interactive auth is required → configure → verify.

## Programmatic usage

`npm-trust-cli` is published as a dual CLI + library. The same package exposes a typed public API for use inside other tools, scripts, or CIs.

```ts
import {
  configureTrust,
  discoverPackages,
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

## Environment variables

| Variable                  | Default                       | Description                                                                                                                                       |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NPM_TRUST_CLI_NPM`       | `<dirname(process.execPath)>/npm` | Override the path to the `npm` binary. Used in tests; rarely needed in production.                                                            |
| `NPM_TRUST_CLI_REGISTRY`  | `https://registry.npmjs.org`  | Override the registry used for package discovery. Must be `https://...`, or `http://localhost` / `http://127.0.0.1` for local mirrors and tests. |
