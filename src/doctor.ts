import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPackageStatusesAsync } from "./diff.js";
import { discoverFromCwd } from "./discover-workspace.js";
import type {
  DiscoveredWorkspace,
  DoctorIssue,
  DoctorReport,
  Logger,
  PackageDoctorEntry,
  PackageStatus,
  RepoHost,
  VersionCheck,
} from "./interfaces/cli.interface.js";

const NODE_REQUIRED_MAJOR = 24;
const NODE_REQUIRED = `>=${NODE_REQUIRED_MAJOR}`;
const NPM_REQUIRED_MAJOR = 11;
const NPM_REQUIRED_MINOR = 5;
const NPM_REQUIRED_PATCH = 1;
const NPM_REQUIRED = `>=${NPM_REQUIRED_MAJOR}.${NPM_REQUIRED_MINOR}.${NPM_REQUIRED_PATCH}`;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export interface RunDoctorOptions {
  readonly cwd: string;
  readonly repo?: string;
  readonly workflow?: string;
  readonly json?: boolean;
  readonly logger: Logger;
  readonly conflictingFlags?: ReadonlyArray<string>;
}

export async function runDoctor(options: RunDoctorOptions): Promise<number> {
  const report = await collectReport(options);
  const output = options.json ? formatDoctorReportJson(report) : formatDoctorReportHuman(report);
  options.logger.log(output);
  return report.summary.fail > 0 ? 1 : 0;
}

export async function collectReport(options: RunDoctorOptions): Promise<DoctorReport> {
  const cli = inspectSelf();
  const runtime = inspectRuntime();
  const auth = inspectAuth();
  const workspace = await discoverFromCwd(options.cwd);
  const repo = inspectRepo(options.cwd);
  const workflows = await listWorkflows(options.cwd);
  const packages = await buildPackageEntries(workspace);
  const issues = collectIssues({ runtime, auth, workspace, repo, workflows, packages, options });
  const summary = summarizeReport(packages, issues);
  return {
    schemaVersion: 1,
    cli,
    runtime,
    auth,
    workspace,
    repo,
    workflows,
    packages,
    issues,
    summary,
  };
}

export function formatDoctorReportJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2);
}

export function formatDoctorReportHuman(report: DoctorReport): string {
  const lines: Array<string> = [];
  lines.push(`npm-trust-cli doctor — ${report.cli.version}`);
  lines.push("");
  lines.push("Runtime");
  lines.push(
    `  ${marker(report.runtime.node.satisfies)} Node      ${report.runtime.node.version ?? "unknown"}   (required ${report.runtime.node.required})`,
  );
  lines.push(
    `  ${marker(report.runtime.npm.satisfies)} npm       ${report.runtime.npm.version ?? "unknown"}   (required ${report.runtime.npm.required})`,
  );
  lines.push(`    Platform  ${report.runtime.platform}`);
  lines.push("");
  lines.push("Authentication");
  if (report.auth.loggedIn) {
    lines.push(`  ✓ Logged in as ${report.auth.username ?? "(unknown user)"}`);
  } else {
    lines.push(`  ⚠ Not logged in to npm`);
  }
  lines.push(`    Registry  ${report.auth.registry}`);
  lines.push("");
  lines.push("Workspace");
  if (report.workspace !== null) {
    lines.push(`  ✓ ${report.workspace.source} — ${report.workspace.packages.length} package(s)`);
    for (const pkg of report.workspace.packages) {
      lines.push(`    └ ${pkg}`);
    }
  } else {
    lines.push(`  ⚠ Not detected`);
  }
  lines.push("");
  lines.push("Repo");
  if (report.repo.url !== null) {
    lines.push(`  ${marker(report.repo.host === "github")} Origin    ${report.repo.url}`);
    if (report.repo.inferredSlug !== null) {
      lines.push(`    Inferred  ${report.repo.inferredSlug} (github)`);
    }
  } else {
    lines.push(`  ⚠ No origin remote`);
  }
  lines.push("");
  lines.push("Workflows");
  if (report.workflows.length === 0) {
    lines.push(`  ⚠ No .github/workflows/*.yml files found`);
  } else {
    for (const wf of report.workflows) {
      lines.push(`  ✓ ${wf}`);
    }
  }
  lines.push("");
  if (report.packages.length > 0) {
    lines.push("Packages");
    for (const pkg of report.packages) {
      const trustText = pkg.trustConfigured ? "yes" : "(none)";
      const publishedText = pkg.published ? "yes" : "no";
      const provenanceText = pkg.hasProvenance ? "yes" : "no";
      lines.push(
        `  ${markerForPackage(pkg)} ${pkg.pkg}   trust-list: ${trustText}  published: ${publishedText}  provenance: ${provenanceText}`,
      );
      for (const note of pkg.discrepancies) {
        lines.push(`    ⚠ ${note}`);
      }
    }
    lines.push("");
  }
  if (report.issues.length > 0) {
    lines.push("Issues");
    for (const issue of report.issues) {
      lines.push(`  ${severityMarker(issue.severity)} ${issue.code}: ${issue.message}`);
      if (issue.remedy !== undefined) {
        lines.push(`    → ${issue.remedy}`);
      }
    }
    lines.push("");
  }
  lines.push(
    `Summary: ${report.summary.ok} ok, ${report.summary.warn} warn, ${report.summary.fail} fail.`,
  );
  return lines.join("\n");
}

function inspectSelf(): { version: string; path: string } {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageJsonPath = join(moduleDir, "..", "package.json");
  const content = readFileSync(packageJsonPath, "utf-8");
  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "version" in parsed &&
    typeof parsed.version === "string"
  ) {
    return { version: parsed.version, path: moduleDir };
  }
  return { version: "0.0.0", path: moduleDir };
}

function inspectRuntime(): { node: VersionCheck; npm: VersionCheck; platform: string } {
  return {
    node: inspectNodeVersion(),
    npm: inspectNpmVersion(),
    platform: `${process.platform}/${process.arch}`,
  };
}

function inspectNodeVersion(): VersionCheck {
  const version = typeof process.versions.node === "string" ? `v${process.versions.node}` : null;
  if (version === null) {
    return { version: null, required: NODE_REQUIRED, satisfies: false };
  }
  const major = Number(version.replace(/^v/, "").split(".")[0]);
  return {
    version,
    required: NODE_REQUIRED,
    satisfies: !Number.isNaN(major) && major >= NODE_REQUIRED_MAJOR,
  };
}

function inspectNpmVersion(): VersionCheck {
  const result = spawnSync(resolveNpmBin(), ["--version"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return { version: null, required: NPM_REQUIRED, satisfies: false };
  }
  const version = (result.stdout ?? "").trim();
  return { version, required: NPM_REQUIRED, satisfies: satisfiesNpmVersion(version) };
}

function satisfiesNpmVersion(version: string): boolean {
  const parts = version.split(".").map((part) => Number(part));
  const major = parts[0];
  const minor = parts[1];
  const patch = parts[2];
  if (major === undefined || Number.isNaN(major)) {
    return false;
  }
  if (major > NPM_REQUIRED_MAJOR) {
    return true;
  }
  if (major < NPM_REQUIRED_MAJOR) {
    return false;
  }
  if (minor === undefined || Number.isNaN(minor)) {
    return false;
  }
  if (minor > NPM_REQUIRED_MINOR) {
    return true;
  }
  if (minor < NPM_REQUIRED_MINOR) {
    return false;
  }
  if (patch === undefined || Number.isNaN(patch)) {
    return false;
  }
  return patch >= NPM_REQUIRED_PATCH;
}

function inspectAuth(): { loggedIn: boolean; username: string | null; registry: string } {
  const whoami = spawnSync(resolveNpmBin(), ["whoami"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const loggedIn = whoami.status === 0;
  const username = loggedIn ? (whoami.stdout ?? "").trim() || null : null;
  const registryResult = spawnSync(resolveNpmBin(), ["config", "get", "registry"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const trimmedRegistry = (registryResult.stdout ?? "").trim();
  const registry =
    registryResult.status === 0 && trimmedRegistry !== "" ? trimmedRegistry : DEFAULT_REGISTRY;
  return { loggedIn, username, registry };
}

function inspectRepo(cwd: string): {
  url: string | null;
  inferredSlug: string | null;
  host: RepoHost;
} {
  const result = spawnSync("git", ["-C", cwd, "remote", "get-url", "origin"], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return { url: null, inferredSlug: null, host: null };
  }
  const url = (result.stdout ?? "").trim();
  if (url === "") {
    return { url: null, inferredSlug: null, host: null };
  }
  const slug = parseGitHubSlug(url);
  if (slug !== null) {
    return { url, inferredSlug: slug, host: "github" };
  }
  return { url, inferredSlug: null, host: "other" };
}

function parseGitHubSlug(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (match === null) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

async function listWorkflows(cwd: string): Promise<ReadonlyArray<string>> {
  const result: Array<string> = [];
  for (const pattern of [".github/workflows/*.yml", ".github/workflows/*.yaml"]) {
    for await (const relPath of glob(pattern, { cwd })) {
      const basename = relPath.split("/").at(-1);
      if (basename !== undefined && basename !== "") {
        result.push(basename);
      }
    }
  }
  return result.sort();
}

async function buildPackageEntries(
  workspace: DiscoveredWorkspace | null,
): Promise<ReadonlyArray<PackageDoctorEntry>> {
  if (workspace === null) {
    return [];
  }
  const statuses = await checkPackageStatusesAsync(workspace.packages);
  return statuses.map(toDoctorEntry);
}

function toDoctorEntry(status: PackageStatus): PackageDoctorEntry {
  const discrepancies: Array<string> = [];
  if (!status.trustConfigured && status.hasProvenance) {
    discrepancies.push(
      "trust-list empty but provenance attestation present (Trusted Publishing likely set up via npm web UI)",
    );
  }
  return { ...status, discrepancies };
}

interface IssueCollectionInput {
  readonly runtime: { node: VersionCheck; npm: VersionCheck; platform: string };
  readonly auth: { loggedIn: boolean; username: string | null; registry: string };
  readonly workspace: DiscoveredWorkspace | null;
  readonly repo: { url: string | null; inferredSlug: string | null; host: RepoHost };
  readonly workflows: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<PackageDoctorEntry>;
  readonly options: RunDoctorOptions;
}

function collectIssues(input: IssueCollectionInput): ReadonlyArray<DoctorIssue> {
  const issues: Array<DoctorIssue> = [];

  if (!input.runtime.node.satisfies) {
    issues.push({
      severity: "fail",
      code: "NODE_TOO_OLD",
      message: `Node ${input.runtime.node.version ?? "unknown"} does not satisfy ${input.runtime.node.required}`,
      remedy: `Install Node.js ${NODE_REQUIRED_MAJOR}+ via nvm: nvm install ${NODE_REQUIRED_MAJOR}`,
      relatedField: "runtime.node",
    });
  }
  if (input.runtime.npm.version === null) {
    issues.push({
      severity: "warn",
      code: "NPM_UNREACHABLE",
      message: "Could not determine npm version",
      remedy: "Ensure `npm` is on PATH",
      relatedField: "runtime.npm",
    });
  } else if (!input.runtime.npm.satisfies) {
    issues.push({
      severity: "warn",
      code: "NPM_TOO_OLD",
      message: `npm ${input.runtime.npm.version} does not satisfy ${input.runtime.npm.required}`,
      remedy: "npm i -g npm@latest",
      relatedField: "runtime.npm",
    });
  }
  if (!input.auth.loggedIn) {
    issues.push({
      severity: "warn",
      code: "AUTH_NOT_LOGGED_IN",
      message: "Not logged in to npm",
      remedy: "Run `npm login` in your terminal (web 2FA)",
      relatedField: "auth.loggedIn",
    });
  } else if (!isUsualRegistry(input.auth.registry)) {
    issues.push({
      severity: "warn",
      code: "AUTH_REGISTRY_UNUSUAL",
      message: `Registry is ${input.auth.registry} (not the public npm registry)`,
      remedy: "Confirm `npm config get registry` points where you intend",
      relatedField: "auth.registry",
    });
  }
  if (input.workspace === null) {
    issues.push({
      severity: "warn",
      code: "WORKSPACE_NOT_DETECTED",
      message: "No workspace or single-package signals in the current directory",
      remedy: "Pass --scope <s> or --packages <names…> instead of relying on auto-detection",
      relatedField: "workspace",
    });
  } else if (input.workspace.packages.length === 0) {
    issues.push({
      severity: "warn",
      code: "WORKSPACE_EMPTY",
      message: `Detected ${input.workspace.source} but found no publishable packages (all marked private?)`,
      remedy: "Mark a package.json as publishable, or pass --packages explicitly",
      relatedField: "workspace.packages",
    });
  }
  if (input.repo.url === null) {
    issues.push({
      severity: "warn",
      code: "REPO_NO_REMOTE",
      message: "No `origin` remote configured",
      remedy: "Add a remote: git remote add origin <url>",
      relatedField: "repo.url",
    });
  } else if (input.repo.host !== "github") {
    issues.push({
      severity: "warn",
      code: "REPO_REMOTE_NOT_GITHUB",
      message: "`npm trust github` only supports GitHub today; your remote is not on github.com",
      remedy: "Verify the remote URL or use a different trust mechanism",
      relatedField: "repo.host",
    });
  }
  if (input.workflows.length === 0) {
    issues.push({
      severity: "warn",
      code: "WORKFLOWS_NONE",
      message: "No .github/workflows/*.yml files found",
      remedy: "Create the publish workflow first; npm needs the filename to attest provenance",
      relatedField: "workflows",
    });
  } else if (input.workflows.length > 1 && input.options.workflow === undefined) {
    issues.push({
      severity: "warn",
      code: "WORKFLOWS_AMBIGUOUS",
      message: `${input.workflows.length} workflow files detected; pick one`,
      remedy: "Pass --workflow <file> so the agent does not have to guess",
      relatedField: "workflows",
    });
  }
  if (input.options.workflow !== undefined && !input.workflows.includes(input.options.workflow)) {
    issues.push({
      severity: "warn",
      code: "WORKFLOW_NOT_FOUND",
      message: `Specified workflow '${input.options.workflow}' is not in .github/workflows/`,
      remedy: "Verify the filename or create the workflow file",
      relatedField: "workflows",
    });
  }
  for (const [i, pkg] of input.packages.entries()) {
    if (!pkg.published) {
      issues.push({
        severity: "warn",
        code: "PACKAGE_NOT_PUBLISHED",
        message: `${pkg.pkg} is not yet on the registry`,
        remedy:
          "Publish first via `npm publish`; OIDC trust can't be configured for non-existent packages",
        relatedField: `packages[${i}]`,
      });
    }
    if (pkg.discrepancies.length > 0) {
      issues.push({
        severity: "warn",
        code: "PACKAGE_TRUST_DISCREPANCY",
        message: `${pkg.pkg}: ${pkg.discrepancies.join("; ")}`,
        remedy:
          "Trusted Publishing is configured via npm's web UI; the --only-new filter correctly skips this package via hasProvenance",
        relatedField: `packages[${i}]`,
      });
    }
  }
  if (input.options.conflictingFlags !== undefined && input.options.conflictingFlags.length > 0) {
    for (const flag of input.options.conflictingFlags) {
      issues.push({
        severity: "warn",
        code: "DOCTOR_FLAG_IGNORED",
        message: `${flag} is ignored when --doctor is set; doctor always uses workspace auto-detection`,
        relatedField: "options",
      });
    }
  }
  return issues;
}

function summarizeReport(
  packages: ReadonlyArray<PackageDoctorEntry>,
  issues: ReadonlyArray<DoctorIssue>,
): { ok: number; warn: number; fail: number } {
  const warn = issues.filter((issue) => issue.severity === "warn").length;
  const fail = issues.filter((issue) => issue.severity === "fail").length;
  const okPackages = packages.filter(
    (pkg) => pkg.published && (pkg.trustConfigured || pkg.hasProvenance),
  ).length;
  return { ok: okPackages, warn, fail };
}

function isUsualRegistry(url: string): boolean {
  return url.startsWith("https://registry.npmjs.org") || url === DEFAULT_REGISTRY;
}

function resolveNpmBin(): string {
  return process.env.NPM_TRUST_CLI_NPM ?? join(dirname(process.execPath), "npm");
}

function marker(ok: boolean): string {
  return ok ? "✓" : "⚠";
}

function severityMarker(severity: "warn" | "fail"): string {
  return severity === "fail" ? "✗" : "⚠";
}

function markerForPackage(pkg: PackageDoctorEntry): string {
  if (pkg.published && (pkg.trustConfigured || pkg.hasProvenance)) {
    return "✓";
  }
  return "⚠";
}
