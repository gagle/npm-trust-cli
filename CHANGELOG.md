# Changelog

## [0.2.0](https://github.com/gagle/npm-trust-cli/compare/v0.1.0...v0.2.0) (2026-04-30)

### Features

- infer common scope from package names and rewrite README around five concrete use cases (first-time org setup, incremental new packages, single package, monorepo, audit) ([ac4a8ba](https://github.com/gagle/npm-trust-cli/commit/ac4a8ba))
- add `--auto` flag with filesystem detection: `pnpm-workspace.yaml` → `package.json#workspaces` → single root `package.json`. Hand-rolled YAML reader keeps zero runtime dependencies. New exports `discoverFromCwd`, `parsePnpmWorkspacePackages`, and `DiscoveredWorkspace` / `WorkspaceSource` types ([53603fb](https://github.com/gagle/npm-trust-cli/commit/53603fb))
- add `--only-new` filter for incremental setup. New `src/diff.ts` module exposes `checkPackageStatuses` (rich per-package status: `trustConfigured`, `published`) and `findUnconfiguredPackages` (CLI-side filter). Both calls run `npm trust list` and `npm view` per package ([f9fcfdf](https://github.com/gagle/npm-trust-cli/commit/f9fcfdf))
- bundle the `setup-npm-trust` Claude Code skill at `skills/setup-npm-trust/SKILL.md` and add the `--init-skill` flag, which scaffolds the skill into the consumer's `./.claude/skills/`. `runCli` reorders so `--help` and `--init-skill` short-circuit before the Node/npm version checks. README adds a "Use from a Claude Code agent" section. The `skills/` folder is included in the npm tarball via `package.json#files` ([abe98d5](https://github.com/gagle/npm-trust-cli/commit/abe98d5))

### Refactor

- harden `--auto` and `--only-new` against round-1 review feedback: pnpm-workspace negation patterns are honored as literal-path exclusions, the YAML reader handles inline-flow form (`packages: [a, b]`), `expandWorkspaceGlobs` consolidates dedup into a single ordered `Set`, and `findUnconfiguredPackages` collapses to `filter().map()` ([30013f6](https://github.com/gagle/npm-trust-cli/commit/30013f6))
- rework `--init-skill` around `copyFile(..., COPYFILE_EXCL)` for atomic existence checking. Eliminates the TOCTOU window in the previous `access()` precheck and surfaces real errnos (EACCES/EPERM/EROFS) instead of silently treating them as "target already exists". Adds `isFsErrorWithCode` helper; tests cover EEXIST, ENOENT, the unexpected-errno rethrow, and the non-Error rejection branch ([360ce2e](https://github.com/gagle/npm-trust-cli/commit/360ce2e))

## [0.1.0](https://github.com/gagle/npm-trust-cli/compare/v0.0.0...v0.1.0) (2026-04-29)

### Breaking Changes

- trim public API: drop `CliError`, `checkNodeVersion`, `checkNpmVersion`, `parseCliArgs`, `printUsage`, and `ParseCliArgsResult` from `src/index.ts` — only `discoverPackages`, `configureTrust`, `listTrust`, `runCli` (plus their input/output types) remain on the library surface ([0e3b56e](https://github.com/gagle/npm-trust-cli/commit/0e3b56e))
- remove the `--otp` CLI flag and all OTP routing — `npm trust` uses web-based 2FA only and never consumed `--otp` or `NPM_CONFIG_OTP`. Rely on the npm UI's "skip 2FA for 5 minutes" toggle for bulk runs ([fc5b0fe](https://github.com/gagle/npm-trust-cli/commit/fc5b0fe))
- drop `otp` from `ConfigureTrustOptions` (programmatic API). Earlier route via `process.env.NPM_CONFIG_OTP`; now there's no OTP path at all ([b171c9a](https://github.com/gagle/npm-trust-cli/commit/b171c9a))

### Features

- ci: tag-triggered release workflow (`.github/workflows/release.yml`) publishes with `--provenance` from GitHub Actions OIDC ([9b83674](https://github.com/gagle/npm-trust-cli/commit/9b83674))

### Refactor

- introduce `RuntimeLogger` (Logger + error) so the library and CLI vocabularies don't carry an inline anonymous shape; promote `MIN_NPM_VERSION` constant; collapse `classifyCaptured` to one line; name the internal `ClassifiedRun` / `FailureKind` types ([0e3b56e](https://github.com/gagle/npm-trust-cli/commit/0e3b56e))
- `validatePackages` rejects names that don't match npm's published-package format before they're spawned (defense in depth — argv-mode spawn is already shell-safe, but a leading-dash name could be interpreted as an npm flag) ([5c3b9d2](https://github.com/gagle/npm-trust-cli/commit/5c3b9d2))
- document the `trustPackage → handleAuthRetry` recursion-stop guard; drop redundant `: unknown` on catch ([d637d41](https://github.com/gagle/npm-trust-cli/commit/d637d41))

### Chores

- cover root config files (`vitest.config.ts`, `vitest.e2e.config.ts`, `eslint.config.js`, `bin/*.js`) in tsconfig + eslint so the IDE's project service stops flagging them ([255f12c](https://github.com/gagle/npm-trust-cli/commit/255f12c))
- remove obsolete `.claude/hooks/graph-update-check.sh` ([ce32d8c](https://github.com/gagle/npm-trust-cli/commit/ce32d8c))

## [0.0.0](https://github.com/gagle/npm-trust-cli/releases/tag/v0.0.0) (2026-04-29)

Initial release.
