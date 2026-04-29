import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { discoverPackages } from "./discover.js";
import type { CliOptions } from "./interfaces/cli.interface.js";
import { configureTrust, listTrust } from "./trust.js";

const MIN_NODE_MAJOR = 24;
const MIN_NPM_MAJOR = 11;

const OTP_PATTERN = /^\d{6,8}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_PATTERN = /^[A-Za-z0-9._/-]+\.ya?ml$/;

export class CliError extends Error {
  public readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function checkNodeVersion(): void {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NODE_MAJOR) {
    throw new CliError(
      `Error: Node.js >= ${MIN_NODE_MAJOR} required (found ${version}). Install via nvm: nvm install ${MIN_NODE_MAJOR}.`,
      1,
    );
  }
}

export function checkNpmVersion(): void {
  const npmBin = process.env.NPM_TRUST_CLI_NPM ?? join(dirname(process.execPath), "npm");
  const result = spawnSync(npmBin, ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    throw new CliError(
      `Error: could not determine npm version. Ensure npm >= ${MIN_NPM_MAJOR}.5.1 is installed.`,
      1,
    );
  }
  const version = result.stdout.trim();
  const major = Number(version.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NPM_MAJOR) {
    throw new CliError(
      `Error: npm >= ${MIN_NPM_MAJOR} required (found ${version}). The "npm trust" command was added in npm 11.5.1.`,
      1,
    );
  }
}

export function printUsage(logger: { readonly log: (message: string) => void } = console): void {
  logger.log(`npm-trust-cli — Bulk-configure npm OIDC Trusted Publishing

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
  --otp <code>           one-time password for non-interactive 2FA (CI use)
  --help                 show this help message`);
}

export interface ParseCliArgsResult {
  readonly options: CliOptions;
  readonly helpRequested: boolean;
}

export function parseCliArgs(argv: ReadonlyArray<string>): ParseCliArgsResult {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      scope: { type: "string" },
      packages: { type: "string", multiple: true },
      repo: { type: "string" },
      workflow: { type: "string" },
      list: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      otp: { type: "string" },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const helpRequested = Boolean(values.help);

  const explicitPackages = values.packages;
  const positionalPackages = positionals.length > 0 ? positionals : undefined;
  const packages =
    explicitPackages && explicitPackages.length > 0 ? explicitPackages : positionalPackages;

  return {
    helpRequested,
    options: {
      scope: values.scope,
      packages,
      repo: values.repo,
      workflow: values.workflow,
      list: Boolean(values.list),
      dryRun: Boolean(values["dry-run"]),
      otp: values.otp,
    },
  };
}

function validateOtp(otp: string | undefined): void {
  if (otp === undefined) {
    return;
  }
  if (!OTP_PATTERN.test(otp)) {
    throw new CliError("Error: --otp must be a 6-8 digit numeric code", 1);
  }
}

function validateRepo(repo: string): void {
  if (!REPO_PATTERN.test(repo)) {
    throw new CliError(
      "Error: --repo must match <owner>/<repo> using letters, digits, '.', '_', or '-'",
      1,
    );
  }
}

function validateWorkflow(workflow: string): void {
  if (!WORKFLOW_PATTERN.test(workflow)) {
    throw new CliError(
      "Error: --workflow must be a .yml or .yaml filename using letters, digits, '.', '_', '-', or '/'",
      1,
    );
  }
}

export async function runCli(
  argv: ReadonlyArray<string>,
  logger: {
    readonly log: (message: string) => void;
    readonly error: (message: string) => void;
  } = console,
): Promise<number> {
  try {
    checkNodeVersion();
    checkNpmVersion();

    const { options, helpRequested } = parseCliArgs(argv);

    if (helpRequested) {
      printUsage(logger);
      return 0;
    }

    validateOtp(options.otp);

    let packages: ReadonlyArray<string>;
    if (options.packages && options.packages.length > 0) {
      packages = [...options.packages];
    } else if (options.scope) {
      logger.log(`Discovering packages in scope ${options.scope}...`);
      packages = await discoverPackages(options.scope);
      logger.log(`Found ${packages.length} packages`);
      logger.log("");
    } else {
      logger.error("Error: --scope or --packages is required");
      logger.error("Run with --help for usage");
      return 1;
    }

    if (packages.length === 0) {
      logger.error("No packages found");
      return 1;
    }

    if (options.list) {
      listTrust({ packages, logger });
      return 0;
    }

    if (!options.repo) {
      logger.error("Error: --repo is required");
      return 1;
    }

    if (!options.workflow) {
      logger.error("Error: --workflow is required");
      return 1;
    }

    validateRepo(options.repo);
    validateWorkflow(options.workflow);

    const summary = configureTrust({
      packages,
      repo: options.repo,
      workflow: options.workflow,
      dryRun: Boolean(options.dryRun),
      otp: options.otp,
      logger,
    });

    return summary.failed > 0 ? 1 : 0;
  } catch (error: unknown) {
    if (error instanceof CliError) {
      logger.error(error.message);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Error: ${message}`);
    logger.error("Run with --help for usage");
    return 1;
  }
}
