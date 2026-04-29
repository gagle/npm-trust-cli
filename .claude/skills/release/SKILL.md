---
name: release
description: >
  Pre-flight readiness checklist + version bump + changelog + tag + publish.
  Single-package CLI release: local verification → bump version → commit → push →
  tag → npm publish. First publish is classic from local; subsequent publishes
  use --provenance from CI once OIDC trust is bootstrapped.
---

# Release

Single-phase release: local verification → push commit → tag → publish to npm.

The first publish is **classic 2FA from local** (OIDC trust can't be configured
on a package that doesn't exist yet, and `--provenance` needs an OIDC issuer).
Once published once, bootstrap OIDC trust and switch subsequent publishes to
`--provenance` from CI. See step 14 for the full flow.

## Phase 0 — v0.0.0 readiness checklist (first publish only)

Before the first `npm publish`, every item below must be ticked. If any fails,
stop and fix before proceeding.

- [ ] `package.json` `version` set to the target (`0.0.0` for the first release).
- [ ] `package.json` `engines.node` is `>=24.0.0`.
- [ ] `src/index.ts` calls `checkNodeVersion()` first in `main()` and exits with a clear error on Node `<24`.
- [ ] `pnpm lint` passes.
- [ ] `pnpm typecheck` passes.
- [ ] `pnpm build` produces `dist/index.js`, `dist/index.d.ts`, source maps.
- [ ] `pnpm test` passes with 100% coverage thresholds.
- [ ] `pnpm test:e2e` passes against the freshly built `dist/`.
- [ ] Every CLI flag/path has at least one unit test.
- [ ] Every CLI flag/path has at least one e2e test driving the built binary.
- [ ] `bin/npm-trust-cli.js` is executable; `node bin/npm-trust-cli.js --help` prints usage.
- [ ] Smoke test: `--list` against a known scope succeeds.
- [ ] `README.md` reflects current flags and the Node 24 requirement.
- [ ] `LICENSE` file exists and matches `package.json` license field.
- [ ] `package.json` `files` only ships `dist/` and `bin/`.
- [ ] `npm publish --dry-run` tarball contents look correct (no test files, no source).
- [ ] `npm whoami` confirms you're logged in to the publishing account.

## Phase 1 — Local

### 1. Guard

Verify clean working tree:

```bash
git status --porcelain
```

If non-empty, **stop** and tell the user to commit or stash first.

### 2. Fast verification

Run all local checks. Abort on first failure:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e
```

### 3. Find latest version

```bash
git tag --list 'v*' --sort=-v:refname | head -1
```

If no tags exist, this is the first release — use `v0.0.0` as the target.

### 4. Collect commits

```bash
git log <tag>..HEAD --format='%H %s'
```

Parse each as a conventional commit: `type(scope)?: subject`.

Ignore commits that don't match the conventional format (e.g., merge commits).

### 5. Determine version bump

| Condition                                                         | Bump                  |
| ----------------------------------------------------------------- | --------------------- |
| Any commit has `!` after type OR body contains `BREAKING CHANGE:` | **major**             |
| Any `feat` commit                                                 | **minor**             |
| Any `fix`, `perf`, or `revert` commit                             | **patch**             |
| None of the above                                                 | **no release** — stop |

The highest applicable bump wins.

### 6. Confirm with user

Print a summary:

```
Release: v{current} → v{next}

Breaking Changes:
  - subject (hash)

Features:
  - subject (hash)

Bug Fixes:
  - subject (hash)

N commits, M releasable
```

Ask the user to confirm before proceeding.

### 7. Generate changelog

Prepend a new section to `CHANGELOG.md` (create the file if it doesn't exist).

```markdown
## [X.Y.Z](https://github.com/gagle/npm-trust-cli/compare/vPREV...vX.Y.Z) (YYYY-MM-DD)

### Breaking Changes

- subject ([hash](https://github.com/gagle/npm-trust-cli/commit/hash))

### Features

- subject ([hash](https://github.com/gagle/npm-trust-cli/commit/hash))

### Bug Fixes

- subject ([hash](https://github.com/gagle/npm-trust-cli/commit/hash))

### Performance

- subject ([hash](https://github.com/gagle/npm-trust-cli/commit/hash))
```

Only include sections that have entries. If the file is new, add a `# Changelog` header at the top.

For the first release (`v0.0.0`), use a single "Initial release" entry instead of
the conventional-commit grouping.

### 8. Bump version

Update the `"version"` field in `package.json` only (single-package repo, no
`packages/*` to walk).

### 9. Commit

```bash
git add CHANGELOG.md package.json
git commit -m "chore: release v{version}"
```

### 10. Push commit

```bash
git push
```

### 11. Final pre-publish verification

Re-run all gates against the bumped version. Abort on any failure:

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e
```

### 12. Tag

```bash
git tag v{version}
```

### 13. Push the tag

```bash
git push --tags
```

### 14. Publish to npm

There are **two** publish flows depending on whether this is the first publish.
Determine which by running:

```bash
npm view npm-trust-cli version 2>/dev/null || echo "FIRST_PUBLISH"
```

- If output is `FIRST_PUBLISH` → use **14a** (classic).
- Otherwise → use **14b** (provenance from CI).

#### 14a — First publish (classic, from an interactive terminal)

OIDC Trusted Publishing requires the package to **already exist** on the
registry, and `--provenance` requires an OIDC issuer (i.e. CI). Neither is
available for the first publish, so it must be a classic publish from the local
machine.

> **`npm publish` must run in an interactive terminal** (not from this skill,
> not from a non-TTY shell). npm 11+ defaults to **web-based 2FA**: it prints
> an `https://www.npmjs.com/auth/cli/<authId>` URL that you have to open in a
> browser to authenticate. The URL is masked when stdout isn't a TTY, and
> `--otp <code>` is rejected on accounts configured for web-only 2FA — so do
> not try to pipe an OTP through the agent. **Open your terminal and run:**
>
> ```bash
> npm whoami                    # confirm logged in (run npm login if not)
> npm publish --access public   # follow the printed URL to complete 2FA
> ```
>
> Once the registry shows the new version (`npm view <pkg> version`), come back
> and continue the skill from step 15.

After it succeeds, **bootstrap OIDC trust** so future releases can use
provenance from CI:

```bash
node bin/npm-trust-cli.js \
  --packages npm-trust-cli \
  --repo gagle/npm-trust-cli \
  --workflow release.yml
```

(The package eats its own dogfood here — `npm-trust-cli` configuring trust for
itself.) This requires a `release.yml` workflow to exist in the repo, even if
empty — npm validates the `--workflow` argument shape but the runtime check is
done at publish time.

#### 14b — Subsequent publishes (from CI, with provenance)

Once OIDC trust is configured for the package, future publishes happen from a
GitHub Actions workflow with `id-token: write` permission:

```yaml
- run: npm publish --access public --provenance
```

`--provenance` produces a signed SLSA attestation tied to the source commit.
This is the payoff of having OIDC Trusted Publishing configured — it proves the
tarball came from this repo at this commit.

If the publish job fails after the tag is pushed: keep the tag (it documents
intent), fix the publish-side issue, and re-run the workflow. Do not bump the
version unless the failure was caused by tarball content that needs another
commit.

### 15. Verify

```bash
npm view npm-trust-cli@{version} version
```

Notify the user:

> Released `v{version}` to npm. Tarball: https://www.npmjs.com/package/npm-trust-cli/v/{version}

## Failure recovery

If any local gate (steps 1–2 or 11) fails: fix and restart from step 1.

If step 14a fails after the tag is pushed: re-run `npm publish` for the same
version once the cause is fixed (auth, network, registry). Do not bump version.

If step 14b fails after the tag is pushed: re-run the CI workflow once the
cause is fixed. Do not bump version unless the tarball needs new content.
