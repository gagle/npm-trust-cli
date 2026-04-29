---
name: verify
description: >
  Run all quality gates: lint, typecheck, build, unit tests, e2e tests. Use
  after any code change to ensure nothing is broken before marking work complete.
---

# Verify

Run each step sequentially. On failure, stop and report which step failed with
the error output. Do not proceed to the next step until the current one passes.

## Steps

### 1. Lint

```bash
pnpm lint
```

### 2. Typecheck

```bash
pnpm typecheck
```

### 3. Build

```bash
pnpm build
```

### 4. Unit tests

```bash
pnpm test
```

Must pass with the 100% coverage thresholds enforced in `vitest.config.ts`.

### 5. E2E tests

E2E tests spawn the built CLI as a child process. They require step 3 (build) to
have produced `dist/`.

```bash
pnpm test:e2e
```

Every CLI flag/path must have an e2e test. The harness lives in `test/e2e/` and
uses a fake `npm` binary on `PATH` plus `msw` to mock the registry — no network
calls hit the real internet.

### 6. CLI smoke

Final sanity check that the published artifact is wired correctly:

```bash
node bin/npm-trust-cli.js --help
```

Should print usage and exit 0.

## On failure

1. Read the error output and diagnose the root cause.
2. Fix the issue.
3. Re-run from the failed step (not from the beginning — earlier steps already passed).
4. Repeat until all steps pass.

## Report

After all steps pass, print a summary:

```
Verification complete:
  ✓ Lint
  ✓ Typecheck
  ✓ Build
  ✓ Unit tests (100% coverage)
  ✓ E2E tests
  ✓ CLI smoke
```
