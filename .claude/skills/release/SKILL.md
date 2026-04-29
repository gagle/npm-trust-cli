---
name: release
description: >
  Pre-flight readiness checklist + version bump + changelog + tag for npm publish.
  Single-package CLI release: local verification → bump version → push → monitor
  CI → tag on success. The publish workflow is triggered by the tag.
---

# Release

Two-phase release: local verification → push commit → monitor CI → tag on success.

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
- [ ] `.github/workflows/ci.yml` exists and the README CI badge resolves to "passing".

## Phase 1 — Local (interactive)

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

### 10. Push (commit only, NO tag)

```bash
git push
```

## Phase 2 — Background (agent monitors CI)

After pushing, tell the user:

> Release commit pushed. Monitoring CI in the background — I'll tag and push when CI is green.

### 11. Find the CI run

```bash
COMMIT_SHA=$(git rev-parse HEAD)
gh run list --commit "$COMMIT_SHA" --json databaseId,name,status --jq '.[] | select(.name == "CI")'
```

If no run found, wait 15 seconds and retry (up to 3 attempts).

### 12. Monitor CI

```bash
gh run watch <run-id> --exit-status
```

### 13. On CI success

Create and push the tag:

```bash
git tag v{version}
git push --tags
```

Notify the user:

> CI passed. Tagged `v{version}` and pushed — the publish workflow is running.
> Track it at: https://github.com/gagle/npm-trust-cli/actions

### 14. On CI failure

Do NOT create a tag. Notify the user:

> CI failed. Release commit is on main but NOT tagged (nothing will be published).
> Fix the issue, amend the release commit, force-push, and run `/release` again.
> Or revert the release commit with `git revert HEAD && git push`.

Provide the failing run URL and the specific job/step that failed.
