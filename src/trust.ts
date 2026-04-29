import { execSync, spawnSync } from "node:child_process";
import type { TrustResult, TrustSummary } from "./interfaces/cli.interface.js";

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

function runCaptured(
  pkg: string,
  repo: string,
  workflow: string,
): { readonly output: string; readonly exitCode: number } {
  try {
    const output = execSync(
      `npm trust github "${pkg}" --repo "${repo}" --file "${workflow}" --yes`,
      {
        encoding: "utf-8",
        env: { ...process.env, npm_config_loglevel: "error" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    return { output, exitCode: 0 };
  } catch (error: unknown) {
    const execError = error as {
      stdout?: string;
      stderr?: string;
      status?: number;
    };
    const output = `${execError.stdout ?? ""}${execError.stderr ?? ""}`;
    return { output, exitCode: execError.status ?? 1 };
  }
}

function runInteractive(pkg: string, repo: string, workflow: string): number {
  const result = spawnSync(
    "npm",
    ["trust", "github", pkg, "--repo", repo, "--file", workflow, "--yes"],
    {
      env: { ...process.env, npm_config_loglevel: "error" },
      stdio: ["inherit", "inherit", "ignore"],
    },
  );
  return result.status ?? 1;
}

function trustPackage(
  pkg: string,
  repo: string,
  workflow: string,
): TrustResult {
  const { output, exitCode } = runCaptured(pkg, repo, workflow);

  if (exitCode === 0) {
    return "configured";
  }

  const kind = classifyOutput(output);

  if (kind === "already") {
    return "already";
  }

  if (kind === "not_published") {
    return "not_published";
  }

  if (kind === "needs_auth") {
    process.stdout.write(
      "\n2FA required. Complete the browser-based authentication when prompted.\n\n",
    );

    const interactiveExitCode = runInteractive(pkg, repo, workflow);
    if (interactiveExitCode === 0) {
      return "configured";
    }

    const retry = runCaptured(pkg, repo, workflow);
    if (retry.exitCode === 0) {
      return "configured";
    }

    const retryKind = classifyOutput(retry.output);
    if (retryKind === "already") {
      return "already";
    }
    if (retryKind === "not_published") {
      return "not_published";
    }

    return "auth_failed";
  }

  return "error";
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

export function configureTrust(
  packages: ReadonlyArray<string>,
  repo: string,
  workflow: string,
  dryRun: boolean,
): TrustSummary {
  console.log(
    `Configuring OIDC trusted publishing for ${packages.length} packages`,
  );
  console.log(`Repo: ${repo} | Workflow: ${workflow}`);
  if (dryRun) {
    console.log("(dry run — no changes will be made)");
  }
  console.log("");

  let configured = 0;
  let already = 0;
  let failed = 0;
  const failedPackages: Array<string> = [];

  for (const pkg of packages) {
    if (dryRun) {
      console.log(`${pkg.padEnd(30)} (dry run)`);
      continue;
    }

    const result = trustPackage(pkg, repo, workflow);

    console.log(formatResult(pkg, result));

    if (result === "configured") {
      configured++;
    } else if (result === "already") {
      already++;
    } else {
      failed++;
      failedPackages.push(pkg);
    }
  }

  console.log("");
  console.log(
    `Done: ${configured} configured, ${already} already set, ${failed} failed`,
  );

  if (failedPackages.length > 0) {
    console.log("");
    console.log("Failed packages (publish first, then re-run):");
    for (const pkg of failedPackages) {
      console.log(`  - ${pkg}`);
    }
  }

  return { configured, already, failed, failedPackages };
}

export function listTrust(packages: ReadonlyArray<string>): void {
  console.log(`Checking trust status for ${packages.length} packages`);
  console.log("");

  for (const pkg of packages) {
    try {
      const output = execSync(`npm trust list "${pkg}"`, {
        encoding: "utf-8",
        env: { ...process.env, npm_config_loglevel: "error" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      console.log(
        `${pkg.padEnd(30)} ${output.trim() || "(no trust configured)"}`,
      );
    } catch {
      console.log(`${pkg.padEnd(30)} (no trust configured)`);
    }
  }
}
