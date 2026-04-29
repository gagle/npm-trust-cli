import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type {
  ConfigureTrustOptions,
  ListTrustOptions,
  Logger,
  TrustResult,
  TrustSummary,
} from "./interfaces/cli.interface.js";

function resolveNpmBin(): string {
  return process.env.NPM_TRUST_CLI_NPM ?? join(dirname(process.execPath), "npm");
}

const CONSOLE_LOGGER: Logger = {
  log: (message: string): void => {
    console.log(message);
  },
};

type OutputKind = "already" | "not_published" | "needs_auth" | "error";

function classifyOutput(output: string): OutputKind {
  const lower = output.toLowerCase();
  if (lower.includes("409") || lower.includes("conflict")) {
    return "already";
  }
  if (lower.includes("404") || lower.includes("not found")) {
    return "not_published";
  }
  if (lower.includes("eotp") || lower.includes("one-time password")) {
    return "needs_auth";
  }
  return "error";
}

function buildTrustArgs(pkg: string, repo: string, workflow: string): Array<string> {
  return ["trust", "github", pkg, "--repo", repo, "--file", workflow, "--yes"];
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_loglevel: "error" };
}

interface CapturedRun {
  readonly output: string;
  readonly exitCode: number;
}

function runCaptured(pkg: string, repo: string, workflow: string): CapturedRun {
  const result = spawnSync(resolveNpmBin(), buildTrustArgs(pkg, repo, workflow), {
    encoding: "utf-8",
    env: buildSpawnEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { output, exitCode: result.status ?? 1 };
}

function runInteractive(pkg: string, repo: string, workflow: string): number {
  const result = spawnSync(resolveNpmBin(), buildTrustArgs(pkg, repo, workflow), {
    env: buildSpawnEnv(),
    stdio: ["inherit", "inherit", "ignore"],
  });
  return result.status ?? 1;
}

function classifyCaptured(captured: CapturedRun): TrustResult | "needs_auth" {
  if (captured.exitCode === 0) {
    return "configured";
  }
  const kind = classifyOutput(captured.output);
  if (kind === "already") {
    return "already";
  }
  if (kind === "not_published") {
    return "not_published";
  }
  if (kind === "needs_auth") {
    return "needs_auth";
  }
  return "error";
}

function handleAuthRetry(pkg: string, repo: string, workflow: string): TrustResult {
  if (process.env.NPM_CONFIG_OTP) {
    return "auth_failed";
  }
  if (!process.stdout.isTTY) {
    return "auth_failed";
  }

  process.stdout.write(
    "\n2FA required. Complete the browser-based authentication when prompted.\n\n",
  );

  const interactiveExitCode = runInteractive(pkg, repo, workflow);
  if (interactiveExitCode === 0) {
    return "configured";
  }

  const retry = runCaptured(pkg, repo, workflow);
  const retryKind = classifyCaptured(retry);
  if (retryKind === "needs_auth") {
    return "auth_failed";
  }
  return retryKind;
}

function trustPackage(pkg: string, repo: string, workflow: string): TrustResult {
  const captured = runCaptured(pkg, repo, workflow);
  const kind = classifyCaptured(captured);
  if (kind === "needs_auth") {
    return handleAuthRetry(pkg, repo, workflow);
  }
  return kind;
}

function formatResult(pkg: string, result: TrustResult): string {
  const label = pkg.padEnd(30);
  switch (result) {
    case "configured":
      return `${label} ✓ configured`;
    case "already":
      return `${label} ✓ already configured`;
    case "not_published":
      return `${label} ✗ not published yet`;
    case "auth_failed":
      return `${label} ✗ authentication failed (re-run to retry)`;
    case "error":
      return `${label} ✗ unknown error`;
  }
}

export function configureTrust(options: ConfigureTrustOptions): TrustSummary {
  const { packages, repo, workflow, dryRun = false, logger = CONSOLE_LOGGER } = options;

  logger.log(`Configuring OIDC trusted publishing for ${packages.length} packages`);
  logger.log(`Repo: ${repo} | Workflow: ${workflow}`);
  if (dryRun) {
    logger.log("(dry run — no changes will be made)");
  }
  logger.log("");

  let configured = 0;
  let already = 0;
  let failed = 0;
  const failedPackages: Array<string> = [];

  for (const pkg of packages) {
    if (dryRun) {
      logger.log(`${pkg.padEnd(30)} (dry run)`);
      continue;
    }

    const result = trustPackage(pkg, repo, workflow);

    logger.log(formatResult(pkg, result));

    if (result === "configured") {
      configured++;
    } else if (result === "already") {
      already++;
    } else if (result === "auth_failed") {
      failed++;
      failedPackages.push(pkg);
      logger.log("");
      logger.log("Authentication failed. Re-run after authenticating.");
      break;
    } else {
      failed++;
      failedPackages.push(pkg);
    }
  }

  logger.log("");
  logger.log(`Done: ${configured} configured, ${already} already set, ${failed} failed`);

  if (failedPackages.length > 0) {
    logger.log("");
    logger.log("Failed packages (publish first, then re-run):");
    for (const pkg of failedPackages) {
      logger.log(`  - ${pkg}`);
    }
  }

  return { configured, already, failed, failedPackages };
}

export function listTrust(options: ListTrustOptions): void {
  const { packages, logger = CONSOLE_LOGGER } = options;

  logger.log(`Checking trust status for ${packages.length} packages`);
  logger.log("");

  for (const pkg of packages) {
    const result = spawnSync(resolveNpmBin(), ["trust", "list", pkg], {
      encoding: "utf-8",
      env: { ...process.env, npm_config_loglevel: "error" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (result.status === 0) {
      const output = result.stdout.trim();
      logger.log(`${pkg.padEnd(30)} ${output || "(no trust configured)"}`);
    } else {
      logger.log(`${pkg.padEnd(30)} (no trust configured)`);
    }
  }
}
