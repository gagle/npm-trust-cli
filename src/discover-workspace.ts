import { glob, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DiscoveredWorkspace } from "./interfaces/cli.interface.js";

interface RootPackageJson {
  readonly name?: string;
  readonly private?: boolean;
  readonly workspaces?: unknown;
}

interface DiscoveredPackageJson {
  readonly name: string;
  readonly private?: boolean;
}

export async function discoverFromCwd(cwd: string): Promise<DiscoveredWorkspace | null> {
  const pnpmGlobs = await readPnpmWorkspaceGlobs(cwd);
  if (pnpmGlobs !== null) {
    const packages = await expandWorkspaceGlobs(cwd, pnpmGlobs);
    return { source: "pnpm-workspace", packages };
  }

  const rootPkg = await readRootPackageJson(cwd);
  if (rootPkg === null) {
    return null;
  }

  const npmGlobs = extractNpmWorkspaceGlobs(rootPkg.workspaces);
  if (npmGlobs !== null) {
    const packages = await expandWorkspaceGlobs(cwd, npmGlobs);
    return { source: "npm-workspace", packages };
  }

  if (typeof rootPkg.name === "string" && rootPkg.private !== true) {
    return { source: "single-package", packages: [rootPkg.name] };
  }

  return null;
}

export function parsePnpmWorkspacePackages(content: string): Array<string> {
  const lines = content.split("\n");
  const result: Array<string> = [];
  let inPackagesBlock = false;
  let blockIndent: number | null = null;

  for (const rawLine of lines) {
    const line = stripComment(rawLine);
    const trimmed = line.trim();

    if (!inPackagesBlock) {
      if (trimmed === "packages:") {
        inPackagesBlock = true;
      }
      continue;
    }

    if (trimmed === "") {
      continue;
    }

    const indent = leadingSpaces(line);
    if (indent === 0) {
      break;
    }
    if (blockIndent === null) {
      blockIndent = indent;
    } else if (indent < blockIndent) {
      break;
    }

    const match = trimmed.match(/^-\s+(.+)$/);
    const captured = match?.[1];
    if (captured === undefined) {
      continue;
    }

    const value = stripQuotes(captured.trim());
    if (value !== "") {
      result.push(value);
    }
  }

  return result;
}

async function readPnpmWorkspaceGlobs(cwd: string): Promise<ReadonlyArray<string> | null> {
  const path = join(cwd, "pnpm-workspace.yaml");
  const content = await readTextFile(path);
  if (content === null) {
    return null;
  }
  return parsePnpmWorkspacePackages(content);
}

async function readRootPackageJson(cwd: string): Promise<RootPackageJson | null> {
  const content = await readTextFile(join(cwd, "package.json"));
  if (content === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return parsed;
}

function extractNpmWorkspaceGlobs(workspaces: unknown): ReadonlyArray<string> | null {
  if (Array.isArray(workspaces)) {
    return filterStrings(workspaces);
  }
  if (typeof workspaces === "object" && workspaces !== null && "packages" in workspaces) {
    const nested = workspaces.packages;
    if (Array.isArray(nested)) {
      return filterStrings(nested);
    }
  }
  return null;
}

async function expandWorkspaceGlobs(
  cwd: string,
  patterns: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> {
  const seen = new Set<string>();
  const collected: Array<string> = [];

  for (const pattern of patterns) {
    if (pattern.startsWith("!") || pattern.trim() === "") {
      continue;
    }
    for await (const relPath of glob(pattern, { cwd })) {
      const pkg = await readPackageJsonName(join(cwd, relPath));
      if (pkg === null) {
        continue;
      }
      if (pkg.private === true) {
        continue;
      }
      if (!seen.has(pkg.name)) {
        seen.add(pkg.name);
        collected.push(pkg.name);
      }
    }
  }

  return collected.sort();
}

async function readPackageJsonName(dir: string): Promise<DiscoveredPackageJson | null> {
  const content = await readTextFile(join(dir, "package.json"));
  if (content === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  if (!("name" in parsed) || typeof parsed.name !== "string" || parsed.name === "") {
    return null;
  }
  const isPrivate = "private" in parsed && parsed.private === true;
  return { name: parsed.name, private: isPrivate };
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function filterStrings(values: ReadonlyArray<unknown>): Array<string> {
  return values.filter((value): value is string => typeof value === "string");
}

function stripComment(line: string): string {
  const hashIndex = line.indexOf("#");
  if (hashIndex === -1) {
    return line;
  }
  return line.slice(0, hashIndex);
}

function leadingSpaces(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") {
      count++;
      continue;
    }
    if (ch === "\t") {
      count += 2;
      continue;
    }
    break;
  }
  return count;
}

function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
