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

## When to use it

- **First-time setup** — You just enabled OIDC publishing in your CI workflow and need to register all existing packages.
- **After publishing a new package** — You published `v0.0.1` of a new package and need to add it to your OIDC trust configuration.
- **Auditing** — You want to check which packages in your org have OIDC trust configured.

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

## Usage

### Configure all packages in a scope

```bash
npx npm-trust-cli --scope @myorg --repo owner/repo --workflow release.yml
```

### Configure specific packages

```bash
npx npm-trust-cli --packages @myorg/foo @myorg/bar --repo owner/repo --workflow release.yml
```

### Check current trust status

```bash
npx npm-trust-cli --scope @myorg --list
```

### Preview without making changes

```bash
npx npm-trust-cli --scope @myorg --repo owner/repo --workflow release.yml --dry-run
```

## Options

| Flag                  | Description                                                           |
| --------------------- | --------------------------------------------------------------------- |
| `--scope <scope>`     | npm org scope (e.g. `@myorg`) — auto-discovers all published packages |
| `--packages <pkg...>` | explicit package names (alternative to `--scope`)                     |
| `--repo <owner/repo>` | GitHub repository                                                     |
| `--workflow <file>`   | GitHub Actions workflow filename (e.g. `release.yml`)                 |
| `--list`              | list current trust status instead of configuring                      |
| `--dry-run`           | show what would be done without making changes                        |
| `--otp <code>`        | one-time password for non-interactive 2FA (CI use)                    |
| `--help`              | show help message                                                     |

## Example output

```
Discovering packages in scope @myorg...
Found 12 packages

Configuring OIDC trusted publishing for 12 packages
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

> **OTP for non-interactive use:** if you need to supply a one-time password
> programmatically (e.g. when 2FA is required), set `process.env.NPM_CONFIG_OTP`
> before calling `configureTrust`. The spawned `npm trust` process inherits it.
> The library does not accept an `otp` option directly because npm's web-based
> 2FA flow has rendered TOTP codes unreliable; for interactive 2FA, run from a
> TTY and the CLI will fall back to a browser auth prompt automatically.

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
