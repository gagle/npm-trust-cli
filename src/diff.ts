import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { PackageStatus } from "./interfaces/cli.interface.js";

const DEFAULT_CONCURRENCY = 8;

function resolveNpmBin(): string {
  return process.env.NPM_TRUST_CLI_NPM ?? join(dirname(process.execPath), "npm");
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_loglevel: "error" };
}

interface CapturedRun {
  readonly stdout: string;
  readonly status: number;
}

function runNpmSync(args: ReadonlyArray<string>): CapturedRun {
  const result = spawnSync(resolveNpmBin(), [...args], {
    encoding: "utf-8",
    env: buildSpawnEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: result.stdout ?? "", status: result.status ?? 1 };
}

async function runNpmAsync(args: ReadonlyArray<string>): Promise<CapturedRun> {
  return new Promise((resolve) => {
    const child = spawn(resolveNpmBin(), [...args], {
      env: buildSpawnEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (child.stdout === null || child.stderr === null) {
      resolve({ stdout: "", status: 1 });
      return;
    }
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", () => {});
    child.on("error", () => {
      resolve({ stdout: "", status: 1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, status: code ?? 1 });
    });
  });
}

function isTrustConfigured(captured: CapturedRun): boolean {
  if (captured.status !== 0) {
    return false;
  }
  return captured.stdout.trim() !== "";
}

interface RegistryState {
  readonly published: boolean;
  readonly hasProvenance: boolean;
}

function parseRegistryDistOutput(captured: CapturedRun): RegistryState {
  if (captured.status !== 0) {
    return { published: false, hasProvenance: false };
  }
  const trimmed = captured.stdout.trim();
  if (trimmed === "") {
    return { published: false, hasProvenance: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { published: true, hasProvenance: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { published: true, hasProvenance: false };
  }
  const hasAttestations =
    "attestations" in parsed && parsed.attestations !== null && parsed.attestations !== undefined;
  return { published: true, hasProvenance: hasAttestations };
}

export function checkPackageStatuses(
  packages: ReadonlyArray<string>,
): ReadonlyArray<PackageStatus> {
  return packages.map((pkg) => {
    const trustList = runNpmSync(["trust", "list", pkg]);
    const dist = parseRegistryDistOutput(runNpmSync(["view", pkg, "dist", "--json"]));
    return {
      pkg,
      trustConfigured: isTrustConfigured(trustList),
      published: dist.published,
      hasProvenance: dist.hasProvenance,
    };
  });
}

export interface CheckPackageStatusesAsyncOptions {
  readonly concurrency?: number;
}

export async function checkPackageStatusesAsync(
  packages: ReadonlyArray<string>,
  options: CheckPackageStatusesAsyncOptions = {},
): Promise<ReadonlyArray<PackageStatus>> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const result: Array<PackageStatus> = [];
  for (let i = 0; i < packages.length; i += concurrency) {
    const chunk = packages.slice(i, i + concurrency);
    const statuses = await Promise.all(chunk.map(checkOnePackageAsync));
    result.push(...statuses);
  }
  return result;
}

async function checkOnePackageAsync(pkg: string): Promise<PackageStatus> {
  const [trustList, distOutput] = await Promise.all([
    runNpmAsync(["trust", "list", pkg]),
    runNpmAsync(["view", pkg, "dist", "--json"]),
  ]);
  const dist = parseRegistryDistOutput(distOutput);
  return {
    pkg,
    trustConfigured: isTrustConfigured(trustList),
    published: dist.published,
    hasProvenance: dist.hasProvenance,
  };
}

export function findUnconfiguredPackages(packages: ReadonlyArray<string>): ReadonlyArray<string> {
  return checkPackageStatuses(packages)
    .filter((status) => !((status.trustConfigured || status.hasProvenance) && status.published))
    .map((status) => status.pkg);
}
