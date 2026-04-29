# npm-trust-cli

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

- Node.js >= 18.3.0
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

| Flag | Description |
|------|-------------|
| `--scope <scope>` | npm org scope (e.g. `@myorg`) — auto-discovers all published packages |
| `--packages <pkg...>` | explicit package names (alternative to `--scope`) |
| `--repo <owner/repo>` | GitHub repository |
| `--workflow <file>` | GitHub Actions workflow filename (e.g. `release.yml`) |
| `--list` | list current trust status instead of configuring |
| `--dry-run` | show what would be done without making changes |
| `--help` | show help message |

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

## License

MIT
