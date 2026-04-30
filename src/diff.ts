import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import type { PackageStatus } from "./interfaces/cli.interface.js";

function resolveNpmBin(): string {
  return process.env.NPM_TRUST_CLI_NPM ?? join(dirname(process.execPath), "npm");
}

function buildSpawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env, npm_config_loglevel: "error" };
}

function isTrustConfigured(pkg: string): boolean {
  const result = spawnSync(resolveNpmBin(), ["trust", "list", pkg], {
    encoding: "utf-8",
    env: buildSpawnEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return false;
  }
  return (result.stdout ?? "").trim() !== "";
}

function isPublished(pkg: string): boolean {
  const result = spawnSync(resolveNpmBin(), ["view", pkg, "name"], {
    encoding: "utf-8",
    env: buildSpawnEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  return result.status === 0;
}

export function checkPackageStatuses(
  packages: ReadonlyArray<string>,
): ReadonlyArray<PackageStatus> {
  return packages.map((pkg) => ({
    pkg,
    trustConfigured: isTrustConfigured(pkg),
    published: isPublished(pkg),
  }));
}

export function findUnconfiguredPackages(packages: ReadonlyArray<string>): ReadonlyArray<string> {
  const statuses = checkPackageStatuses(packages);
  const unconfigured: Array<string> = [];
  for (const status of statuses) {
    if (status.trustConfigured && status.published) {
      continue;
    }
    unconfigured.push(status.pkg);
  }
  return unconfigured;
}
