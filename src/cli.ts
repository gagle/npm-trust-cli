import { spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { findUnconfiguredPackages } from "./diff.js";
import { discoverPackages } from "./discover.js";
import { discoverFromCwd } from "./discover-workspace.js";
import { runDoctor } from "./doctor.js";
import type {
  CliOptions,
  Logger,
  RuntimeLogger,
  WorkspaceSource,
} from "./interfaces/cli.interface.js";
import { configureTrust, listTrust } from "./trust.js";

const MIN_NODE_MAJOR = 24;
const MIN_NPM_MAJOR = 11;
const MIN_NPM_VERSION = "11.5.1";

const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW_PATTERN = /^[A-Za-z0-9._/-]+\.ya?ml$/;
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

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
  if (typeof version !== "string") {
    throw new CliError(
      `Error: Node.js >= ${MIN_NODE_MAJOR} required (process.versions.node is unavailable).`,
      1,
    );
  }
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
      `Error: could not determine npm version. Ensure npm >= ${MIN_NPM_VERSION} is installed.`,
      1,
    );
  }
  const version = result.stdout.trim();
  const major = Number(version.split(".")[0]);
  if (Number.isNaN(major) || major < MIN_NPM_MAJOR) {
    throw new CliError(
      `Error: npm >= ${MIN_NPM_MAJOR} required (found ${version}). The "npm trust" command was added in npm ${MIN_NPM_VERSION}.`,
      1,
    );
  }
}

export function printUsage(logger: Logger = console): void {
  logger.log(`npm-trust-cli — Bulk-configure npm OIDC Trusted Publishing

Usage:
  npm-trust-cli --scope <scope> --repo <owner/repo> --workflow <file>
  npm-trust-cli --packages <pkg1> <pkg2> --repo <owner/repo> --workflow <file>
  npm-trust-cli --auto --repo <owner/repo> --workflow <file>
  npm-trust-cli --scope <scope> --list

Options:
  --scope <scope>        npm org scope (e.g. @ncbijs) — discovers all packages
  --packages <pkg...>    explicit package names
  --auto                 detect packages from the current directory
                         (pnpm-workspace.yaml, package.json#workspaces, or single package.json)
  --repo <owner/repo>    GitHub repository (e.g. gagle/ncbijs)
  --workflow <file>      GitHub Actions workflow file (e.g. release.yml)
  --list                 list current trust status instead of configuring
  --only-new             filter to packages that have no OIDC trust yet or are unpublished
  --dry-run              show what would be done without making changes
  --init-skill           install the bundled Claude Code skill into ./.claude/skills
  --doctor               print a structured environment + per-package health report
  --json                 emit machine-readable JSON (only meaningful with --doctor)
  --help                 show this help message

Note: 'npm trust' uses web-based 2FA only. The first call opens a browser
authentication flow; on the npm site there's a "skip 2FA for the next 5
minutes" option that lets bulk operations proceed without re-authenticating.`);
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
      auto: { type: "boolean", default: false },
      "only-new": { type: "boolean", default: false },
      "init-skill": { type: "boolean", default: false },
      doctor: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
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
      auto: Boolean(values.auto),
      onlyNew: Boolean(values["only-new"]),
      initSkill: Boolean(values["init-skill"]),
      doctor: Boolean(values.doctor),
      json: Boolean(values.json),
    },
  };
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

function validatePackages(packages: ReadonlyArray<string>): void {
  for (const pkg of packages) {
    if (!PACKAGE_NAME_PATTERN.test(pkg)) {
      throw new CliError(
        `Error: invalid package name "${pkg}". Names must match npm's published-package format (optionally @scope/name, lowercase, no leading dash).`,
        1,
      );
    }
  }
}

function collectDoctorConflicts(options: CliOptions): ReadonlyArray<string> {
  const conflicts: Array<string> = [];
  if (options.auto) {
    conflicts.push("--auto");
  }
  if (typeof options.scope === "string" && options.scope !== "") {
    conflicts.push("--scope");
  }
  if (options.packages !== undefined && options.packages.length > 0) {
    conflicts.push("--packages");
  }
  return conflicts;
}

function describeWorkspaceSource(source: WorkspaceSource): string {
  switch (source) {
    case "pnpm-workspace":
      return "pnpm workspace";
    case "npm-workspace":
      return "npm/yarn workspace";
    case "single-package":
      return "single package";
  }
}

function resolveBundledSkillPath(): string {
  return fileURLToPath(new URL("../skills/setup-npm-trust/SKILL.md", import.meta.url));
}

async function initSkill(cwd: string, logger: RuntimeLogger): Promise<number> {
  const sourceFile = resolveBundledSkillPath();
  const targetDir = join(cwd, ".claude", "skills", "setup-npm-trust");
  const targetFile = join(targetDir, "SKILL.md");

  await mkdir(targetDir, { recursive: true });

  try {
    await copyFile(sourceFile, targetFile, fsConstants.COPYFILE_EXCL);
  } catch (err) {
    if (isFsErrorWithCode(err, "EEXIST")) {
      logger.error(`Error: ${targetFile} already exists. Remove it first to refresh.`);
      return 1;
    }
    if (isFsErrorWithCode(err, "ENOENT")) {
      logger.error(`Error: bundled skill not found at ${sourceFile}.`);
      return 1;
    }
    throw err;
  }

  logger.log(`Installed setup-npm-trust skill to ${targetFile}`);
  return 0;
}

function isFsErrorWithCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && err.code === code;
}

export async function runCli(
  argv: ReadonlyArray<string>,
  logger: RuntimeLogger = console,
): Promise<number> {
  try {
    const { options, helpRequested } = parseCliArgs(argv);

    if (helpRequested) {
      printUsage(logger);
      return 0;
    }

    if (options.initSkill) {
      return await initSkill(process.cwd(), logger);
    }

    if (options.doctor) {
      return await runDoctor({
        cwd: process.cwd(),
        repo: options.repo,
        workflow: options.workflow,
        json: Boolean(options.json),
        logger,
        conflictingFlags: collectDoctorConflicts(options),
      });
    }

    checkNodeVersion();
    checkNpmVersion();

    let packages: ReadonlyArray<string>;
    if (options.packages && options.packages.length > 0) {
      packages = options.packages;
    } else if (options.scope) {
      logger.log(`Discovering packages in scope ${options.scope}...`);
      packages = await discoverPackages(options.scope);
      logger.log(`Found ${packages.length} packages`);
      logger.log("");
    } else if (options.auto) {
      const discovered = await discoverFromCwd(process.cwd());
      if (discovered === null) {
        logger.error("Error: --auto could not detect any packages from the current directory.");
        logger.error(
          "Looked for: pnpm-workspace.yaml, package.json#workspaces, ./package.json with name.",
        );
        return 1;
      }
      packages = discovered.packages;
      logger.log(
        `Detected ${describeWorkspaceSource(discovered.source)} — found ${packages.length} packages`,
      );
      logger.log("");
    } else {
      logger.error("Error: --auto, --scope, or --packages is required");
      logger.error("Run with --help for usage");
      return 1;
    }

    if (packages.length === 0) {
      logger.error("No packages found");
      return 1;
    }

    validatePackages(packages);

    let workingPackages = packages;
    if (options.onlyNew) {
      logger.log(`Checking which of ${packages.length} packages need OIDC trust...`);
      const filtered = findUnconfiguredPackages(packages);
      logger.log(`Filtered: ${packages.length} → ${filtered.length} packages need configuration`);
      logger.log("");
      if (filtered.length === 0) {
        logger.log("All packages already have OIDC trust configured.");
        return 0;
      }
      workingPackages = filtered;
    }

    if (options.list) {
      listTrust({ packages: workingPackages, logger });
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
      packages: workingPackages,
      repo: options.repo,
      workflow: options.workflow,
      dryRun: Boolean(options.dryRun),
      logger,
    });

    return summary.failed > 0 ? 1 : 0;
  } catch (error) {
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
