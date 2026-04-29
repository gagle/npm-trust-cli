import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import type { CliOptions } from "./interfaces/cli.interface.js";
import { discoverPackages } from "./discover.js";
import { configureTrust, listTrust } from "./trust.js";

const MIN_NPM_MAJOR = 11;

function checkNpmVersion(): void {
  const npmBin = join(dirname(process.execPath), "npm");
  try {
    const version = execSync(`"${npmBin}" --version`, {
      encoding: "utf-8",
    }).trim();
    const major = Number(version.split(".")[0]);
    if (major < MIN_NPM_MAJOR) {
      console.error(
        `Error: npm >= ${MIN_NPM_MAJOR} required (found ${version}). The "npm trust" command was added in npm 11.5.1.`,
      );
      process.exit(1);
    }
  } catch {
    console.error(
      "Error: could not determine npm version. Ensure npm >= 11.5.1 is installed.",
    );
    process.exit(1);
  }
}

function printUsage(): void {
  console.log(`npm-trust-cli — Bulk-configure npm OIDC Trusted Publishing

Usage:
  npm-trust-cli --scope <scope> --repo <owner/repo> --workflow <file>
  npm-trust-cli --packages <pkg1> <pkg2> --repo <owner/repo> --workflow <file>
  npm-trust-cli --scope <scope> --list

Options:
  --scope <scope>        npm org scope (e.g. @ncbijs) — discovers all packages
  --packages <pkg...>    explicit package names
  --repo <owner/repo>    GitHub repository (e.g. gagle/ncbijs)
  --workflow <file>      GitHub Actions workflow file (e.g. release.yml)
  --list                 list current trust status instead of configuring
  --dry-run              show what would be done without making changes
  --help                 show this help message`);
}

function parseCliArgs(argv: ReadonlyArray<string>): CliOptions {
  const { values, positionals } = parseArgs({
    args: argv as Array<string>,
    options: {
      scope: { type: "string" },
      packages: { type: "string", multiple: true },
      repo: { type: "string" },
      workflow: { type: "string" },
      list: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: false,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  const packages =
    values.packages ?? (positionals.length > 0 ? positionals : undefined);

  return {
    scope: values.scope as string | undefined,
    packages: packages as Array<string> | undefined,
    repo: values.repo as string | undefined,
    workflow: values.workflow as string | undefined,
    list: Boolean(values.list),
    dryRun: Boolean(values["dry-run"]),
  };
}

async function resolvePackages(options: CliOptions): Promise<Array<string>> {
  if (options.packages && options.packages.length > 0) {
    return [...options.packages];
  }

  if (options.scope) {
    console.log(`Discovering packages in scope ${options.scope}...`);
    const packages = await discoverPackages(options.scope);
    console.log(`Found ${packages.length} packages`);
    console.log("");
    return packages;
  }

  return [];
}

async function main(): Promise<void> {
  checkNpmVersion();
  const options = parseCliArgs(process.argv.slice(2));

  if (!options.scope && (!options.packages || options.packages.length === 0)) {
    console.error("Error: --scope or --packages is required");
    console.error("Run with --help for usage");
    process.exit(1);
  }

  const packages = await resolvePackages(options);

  if (packages.length === 0) {
    console.error("No packages found");
    process.exit(1);
  }

  if (options.list) {
    listTrust(packages);
    return;
  }

  if (!options.repo) {
    console.error("Error: --repo is required");
    process.exit(1);
  }

  if (!options.workflow) {
    console.error("Error: --workflow is required");
    process.exit(1);
  }

  const summary = configureTrust(
    packages,
    options.repo,
    options.workflow,
    options.dryRun ?? false,
  );

  process.exit(summary.failed > 0 ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
