import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DiscoveredWorkspace,
  DoctorIssueCode,
  DoctorReport,
  Logger,
  PackageStatus,
} from "./interfaces/cli.interface.js";

const spawnSyncMock = vi.fn();
const discoverFromCwdMock = vi.fn();
const checkPackageStatusesAsyncMock = vi.fn();
const globMock = vi.fn();
const readFileSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: ReadonlyArray<unknown>) => spawnSyncMock(...args),
}));

vi.mock("node:fs", () => ({
  readFileSync: (...args: ReadonlyArray<unknown>) => readFileSyncMock(...args),
}));

vi.mock("node:fs/promises", () => ({
  glob: (...args: ReadonlyArray<unknown>) => globMock(...args),
}));

vi.mock("./diff.js", () => ({
  checkPackageStatusesAsync: (...args: ReadonlyArray<unknown>) =>
    checkPackageStatusesAsyncMock(...args),
}));

vi.mock("./discover-workspace.js", () => ({
  discoverFromCwd: (...args: ReadonlyArray<unknown>) => discoverFromCwdMock(...args),
}));

const { collectReport, formatDoctorReportHuman, formatDoctorReportJson, runDoctor } =
  await import("./doctor.js");

const ORIGINAL_NODE_VERSION = process.versions.node;

function stubNodeVersion(version: string | undefined): void {
  Object.defineProperty(process.versions, "node", { value: version, configurable: true });
}

function restoreNodeVersion(): void {
  stubNodeVersion(ORIGINAL_NODE_VERSION);
}

interface CapturingLogger extends Logger {
  readonly logs: ReadonlyArray<string>;
}

function createLogger(): CapturingLogger {
  const logs: Array<string> = [];
  return { log: (message: string) => logs.push(message), logs };
}

function asyncIterable<T>(items: ReadonlyArray<T>): AsyncIterableIterator<T> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => {
      if (index < items.length) {
        const value = items[index];
        index += 1;
        return Promise.resolve({ value: value as T, done: false });
      }
      return Promise.resolve({ value: undefined as unknown as T, done: true });
    },
  };
}

interface SpawnReturn {
  readonly stdout?: string;
  readonly status?: number;
  readonly error?: Error;
}

interface SpawnRoutes {
  readonly npmVersion?: SpawnReturn;
  readonly npmWhoami?: SpawnReturn;
  readonly npmConfigRegistry?: SpawnReturn;
  readonly gitRemote?: SpawnReturn;
}

function setupSpawnRoutes(routes: SpawnRoutes): void {
  spawnSyncMock.mockImplementation((bin: string, args: ReadonlyArray<string>): SpawnReturn => {
    if (bin === "git") {
      return routes.gitRemote ?? { stdout: "", status: 1 };
    }
    if (args[0] === "--version") {
      return routes.npmVersion ?? { stdout: "11.11.0\n", status: 0 };
    }
    if (args[0] === "whoami") {
      return routes.npmWhoami ?? { stdout: "gllamas\n", status: 0 };
    }
    if (args[0] === "config") {
      return routes.npmConfigRegistry ?? { stdout: "https://registry.npmjs.org\n", status: 0 };
    }
    return { stdout: "", status: 1 };
  });
}

const HEALTHY_WORKSPACE: DiscoveredWorkspace = {
  source: "single-package",
  packages: ["npm-trust-cli"],
};

const HEALTHY_PACKAGE: PackageStatus = {
  pkg: "npm-trust-cli",
  trustConfigured: true,
  published: true,
  hasProvenance: true,
};

function setupHealthyEnvironment(): void {
  stubNodeVersion("24.14.1");
  setupSpawnRoutes({
    gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
  });
  discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
  globMock.mockImplementation((pattern: string) => {
    if (pattern.endsWith(".yml")) {
      return asyncIterable([".github/workflows/release.yml"]);
    }
    return asyncIterable([]);
  });
  checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
}

function issueCodes(report: DoctorReport): ReadonlyArray<DoctorIssueCode> {
  return report.issues.map((issue) => issue.code);
}

beforeEach(() => {
  readFileSyncMock.mockReturnValue(JSON.stringify({ version: "0.4.0" }));
});

afterEach(() => {
  restoreNodeVersion();
});

describe("collectReport", () => {
  describe("when the environment is fully healthy", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      setupHealthyEnvironment();
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should set schemaVersion to 1", () => {
      expect(report.schemaVersion).toBe(1);
    });

    it("should report Node and npm as satisfying", () => {
      expect(report.runtime.node.satisfies).toBe(true);
      expect(report.runtime.npm.satisfies).toBe(true);
    });

    it("should report the user as logged in", () => {
      expect(report.auth).toMatchObject({ loggedIn: true, username: "gllamas" });
    });

    it("should infer the GitHub slug", () => {
      expect(report.repo).toMatchObject({
        inferredSlug: "gagle/npm-trust-cli",
        host: "github",
      });
    });

    it("should produce no issues", () => {
      expect(report.issues).toStrictEqual([]);
    });

    it("should count one ok package", () => {
      expect(report.summary).toStrictEqual({ ok: 1, warn: 0, fail: 0 });
    });
  });

  describe("when Node is too old", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("22.0.0");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce a NODE_TOO_OLD fail issue", () => {
      expect(issueCodes(report)).toContain("NODE_TOO_OLD");
      expect(report.issues.find((i) => i.code === "NODE_TOO_OLD")?.severity).toBe("fail");
    });

    it("should mark the runtime.node check as not satisfying", () => {
      expect(report.runtime.node.satisfies).toBe(false);
    });
  });

  describe("when process.versions.node is missing", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion(undefined);
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should report node version as null and not satisfying", () => {
      expect(report.runtime.node.version).toBeNull();
      expect(report.runtime.node.satisfies).toBe(false);
    });
  });

  describe("when npm --version fails", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { error: new Error("ENOENT") },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce an NPM_UNREACHABLE warn issue", () => {
      expect(issueCodes(report)).toContain("NPM_UNREACHABLE");
    });
  });

  describe("when npm is too old", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "10.0.0\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce an NPM_TOO_OLD warn issue", () => {
      expect(issueCodes(report)).toContain("NPM_TOO_OLD");
    });
  });

  describe("when npm version meets the major requirement but a smaller minor is below the threshold", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "11.4.99\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce NPM_TOO_OLD", () => {
      expect(issueCodes(report)).toContain("NPM_TOO_OLD");
    });
  });

  describe("when npm version is at the minor threshold but patch is below required", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "11.5.0\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce NPM_TOO_OLD", () => {
      expect(issueCodes(report)).toContain("NPM_TOO_OLD");
    });
  });

  describe("when npm version is malformed", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "garbage\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should report npm as not satisfying", () => {
      expect(report.runtime.npm.satisfies).toBe(false);
    });
  });

  describe("when npm --version succeeds with no stdout field", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should record the npm version as an empty string and mark it not satisfying", () => {
      expect(report.runtime.npm.version).toBe("");
      expect(report.runtime.npm.satisfies).toBe(false);
    });
  });

  describe("when npm version equals the required major but has no minor", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "11\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should report npm as not satisfying", () => {
      expect(report.runtime.npm.satisfies).toBe(false);
    });
  });

  describe("when npm version equals required major and minor but has no patch", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "11.5\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should report npm as not satisfying", () => {
      expect(report.runtime.npm.satisfies).toBe(false);
    });
  });

  describe("when npm version has only the major", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmVersion: { stdout: "12\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should accept a major above the required when no minor is present", () => {
      expect(report.runtime.npm.satisfies).toBe(true);
    });
  });

  describe("when npm config registry returns empty", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmConfigRegistry: { stdout: "", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should fall back to the default registry URL", () => {
      expect(report.auth.registry).toBe("https://registry.npmjs.org");
    });
  });

  describe("when npm whoami fails", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmWhoami: { stdout: "", status: 1 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce an AUTH_NOT_LOGGED_IN warn", () => {
      expect(issueCodes(report)).toContain("AUTH_NOT_LOGGED_IN");
    });
  });

  describe("when whoami succeeds with empty stdout", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmWhoami: { stdout: "", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should report a null username", () => {
      expect(report.auth.username).toBeNull();
    });
  });

  describe("when the registry is unusual", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmConfigRegistry: { stdout: "https://npm.pkg.github.com/\n", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce AUTH_REGISTRY_UNUSUAL", () => {
      expect(issueCodes(report)).toContain("AUTH_REGISTRY_UNUSUAL");
    });
  });

  describe("when discoverFromCwd returns null", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce WORKSPACE_NOT_DETECTED", () => {
      expect(issueCodes(report)).toContain("WORKSPACE_NOT_DETECTED");
    });

    it("should not call checkPackageStatusesAsync", () => {
      expect(checkPackageStatusesAsyncMock).not.toHaveBeenCalled();
    });
  });

  describe("when a workspace is detected with zero packages", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce({ source: "pnpm-workspace", packages: [] });
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce WORKSPACE_EMPTY", () => {
      expect(issueCodes(report)).toContain("WORKSPACE_EMPTY");
    });
  });

  describe("when git remote get-url fails", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "", status: 1 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce REPO_NO_REMOTE", () => {
      expect(issueCodes(report)).toContain("REPO_NO_REMOTE");
    });

    it("should leave repo.url null", () => {
      expect(report.repo.url).toBeNull();
    });
  });

  describe("when git remote returns an empty URL", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should treat the empty URL as no remote", () => {
      expect(report.repo.url).toBeNull();
    });
  });

  describe("when the remote is not GitHub", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://gitlab.com/foo/bar.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce REPO_REMOTE_NOT_GITHUB", () => {
      expect(issueCodes(report)).toContain("REPO_REMOTE_NOT_GITHUB");
    });

    it("should set host to other", () => {
      expect(report.repo.host).toBe("other");
    });
  });

  describe("when the GitHub remote uses SSH form", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "git@github.com:gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should still infer the GitHub slug", () => {
      expect(report.repo.inferredSlug).toBe("gagle/npm-trust-cli");
    });
  });

  describe("when no workflow files exist", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation(() => asyncIterable([]));
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce WORKFLOWS_NONE", () => {
      expect(issueCodes(report)).toContain("WORKFLOWS_NONE");
    });
  });

  describe("when multiple workflow files are detected without --workflow specified", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) => {
        if (pattern.endsWith(".yml")) {
          return asyncIterable([".github/workflows/release.yml", ".github/workflows/ci.yml"]);
        }
        return asyncIterable([]);
      });
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce WORKFLOWS_AMBIGUOUS", () => {
      expect(issueCodes(report)).toContain("WORKFLOWS_AMBIGUOUS");
    });

    it("should sort workflow filenames", () => {
      expect(report.workflows).toStrictEqual(["ci.yml", "release.yml"]);
    });
  });

  describe("when a specified workflow is not in the .github/workflows folder", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({
        cwd: "/tmp/x",
        logger: createLogger(),
        workflow: "publish.yml",
      });
    });

    it("should produce WORKFLOW_NOT_FOUND", () => {
      expect(issueCodes(report)).toContain("WORKFLOW_NOT_FOUND");
    });
  });

  describe("when only a yaml workflow exists alongside a yml one", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) => {
        if (pattern.endsWith(".yml")) {
          return asyncIterable([".github/workflows/release.yml"]);
        }
        return asyncIterable([".github/workflows/legacy.yaml"]);
      });
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({
        cwd: "/tmp/x",
        logger: createLogger(),
        workflow: "release.yml",
      });
    });

    it("should accept a yml file specified explicitly", () => {
      expect(issueCodes(report)).not.toContain("WORKFLOW_NOT_FOUND");
    });

    it("should include the yaml workflow in the list", () => {
      expect(report.workflows).toContain("legacy.yaml");
    });
  });

  describe("when a glob result has no basename", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([""]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should drop empty entries from the workflows list", () => {
      expect(report.workflows).toStrictEqual([]);
    });
  });

  describe("when an unpublished package is detected", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce({
        source: "single-package",
        packages: ["@org/new-pkg"],
      });
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([
        { pkg: "@org/new-pkg", trustConfigured: false, published: false, hasProvenance: false },
      ]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce PACKAGE_NOT_PUBLISHED", () => {
      expect(issueCodes(report)).toContain("PACKAGE_NOT_PUBLISHED");
    });
  });

  describe("when a package shows the trust-list / provenance discrepancy", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce({
        source: "single-package",
        packages: ["@org/web-trusted"],
      });
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([
        { pkg: "@org/web-trusted", trustConfigured: false, published: true, hasProvenance: true },
      ]);
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should produce PACKAGE_TRUST_DISCREPANCY", () => {
      expect(issueCodes(report)).toContain("PACKAGE_TRUST_DISCREPANCY");
    });

    it("should expose discrepancies in the package entry", () => {
      expect(report.packages[0]?.discrepancies).toHaveLength(1);
    });
  });

  describe("when package.json has no version field", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      readFileSyncMock.mockReturnValueOnce(JSON.stringify({ name: "x" }));
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should fall back to '0.0.0' for the cli version", () => {
      expect(report.cli.version).toBe("0.0.0");
    });
  });

  describe("when whoami and registry config return no stdout fields", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmWhoami: { status: 0 },
        npmConfigRegistry: { status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should default the username to null", () => {
      expect(report.auth.username).toBeNull();
    });

    it("should fall back to the default registry", () => {
      expect(report.auth.registry).toBe("https://registry.npmjs.org");
    });
  });

  describe("when git remote get-url returns success but no stdout field", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should treat the missing URL as no remote", () => {
      expect(report.repo.url).toBeNull();
    });
  });

  describe("when conflicting flags are passed alongside --doctor", () => {
    let report: DoctorReport;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      report = await collectReport({
        cwd: "/tmp/x",
        logger: createLogger(),
        conflictingFlags: ["--auto", "--scope"],
      });
    });

    it("should emit one DOCTOR_FLAG_IGNORED issue per conflicting flag", () => {
      const codes = issueCodes(report);
      expect(codes.filter((code) => code === "DOCTOR_FLAG_IGNORED")).toHaveLength(2);
    });
  });
});

describe("formatDoctorReportJson", () => {
  describe("when called with a healthy report", () => {
    let json: string;
    let parsed: DoctorReport;

    beforeEach(async () => {
      setupHealthyEnvironment();
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      json = formatDoctorReportJson(report);
      parsed = JSON.parse(json);
    });

    it("should produce parseable JSON", () => {
      expect(parsed.schemaVersion).toBe(1);
    });

    it("should preserve the package list", () => {
      expect(parsed.packages.map((pkg) => pkg.pkg)).toStrictEqual(["npm-trust-cli"]);
    });
  });
});

describe("formatDoctorReportHuman", () => {
  describe("when called with a healthy report", () => {
    let output: string;

    beforeEach(async () => {
      setupHealthyEnvironment();
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should include the doctor banner", () => {
      expect(output).toContain("npm-trust-cli doctor");
    });

    it("should include the Runtime, Authentication, Workspace, Repo, Workflows headers", () => {
      expect(output).toContain("Runtime");
      expect(output).toContain("Authentication");
      expect(output).toContain("Workspace");
      expect(output).toContain("Repo");
      expect(output).toContain("Workflows");
    });

    it("should end with a Summary line", () => {
      expect(output).toMatch(/Summary: 1 ok, 0 warn, 0 fail\.$/);
    });
  });

  describe("when called with an unhealthy report", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("22.0.0");
      setupSpawnRoutes({
        npmWhoami: { stdout: "", status: 1 },
        gitRemote: { stdout: "", status: 1 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should mark the failed runtime line with a warn marker", () => {
      expect(output).toMatch(/⚠ Node/);
    });

    it("should print 'Not logged in' for the auth section", () => {
      expect(output).toContain("Not logged in");
    });

    it("should print 'No origin remote' for the repo section", () => {
      expect(output).toContain("No origin remote");
    });

    it("should include an Issues section", () => {
      expect(output).toContain("Issues");
    });
  });

  describe("when called with a report whose package shows discrepancies", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce({
        source: "single-package",
        packages: ["@org/web-trusted"],
      });
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([
        { pkg: "@org/web-trusted", trustConfigured: false, published: true, hasProvenance: true },
      ]);
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should include the discrepancy note under the package line", () => {
      expect(output).toContain("trust-list empty but provenance attestation present");
    });
  });

  describe("when called with a report from a logged-in user with empty username", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        npmWhoami: { stdout: "", status: 0 },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should fall back to '(unknown user)' for the username display", () => {
      expect(output).toContain("(unknown user)");
    });
  });

  describe("when called with a report where Node and npm versions are unknown", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion(undefined);
      setupSpawnRoutes({
        npmVersion: { error: new Error("ENOENT") },
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should render 'unknown' for both Node and npm version slots", () => {
      expect(output).toMatch(/Node\s+unknown/);
      expect(output).toMatch(/npm\s+unknown/);
    });
  });

  describe("when called with a non-GitHub repo URL", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://gitlab.com/foo/bar.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(null);
      globMock.mockImplementation(() => asyncIterable([]));
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should print the origin without an inferred slug line", () => {
      expect(output).not.toMatch(/Inferred\s+\(github\)/);
    });
  });

  describe("when called with a report whose issue has no remedy", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      const report = await collectReport({
        cwd: "/tmp/x",
        logger: createLogger(),
        conflictingFlags: ["--auto"],
      });
      output = formatDoctorReportHuman(report);
    });

    it("should still print the issue line even without a remedy bullet", () => {
      expect(output).toContain("DOCTOR_FLAG_IGNORED");
    });
  });

  describe("when called with a report whose package is unpublished", () => {
    let output: string;

    beforeEach(async () => {
      stubNodeVersion("24.14.1");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce({
        source: "single-package",
        packages: ["@org/new-pkg"],
      });
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([
        { pkg: "@org/new-pkg", trustConfigured: false, published: false, hasProvenance: false },
      ]);
      const report = await collectReport({ cwd: "/tmp/x", logger: createLogger() });
      output = formatDoctorReportHuman(report);
    });

    it("should mark the unpublished package with a warn marker", () => {
      expect(output).toMatch(/⚠ @org\/new-pkg/);
    });
  });
});

describe("runDoctor", () => {
  describe("when the environment is healthy", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      setupHealthyEnvironment();
      logger = createLogger();
      exitCode = await runDoctor({ cwd: "/tmp/x", logger });
    });

    it("should return 0", () => {
      expect(exitCode).toBe(0);
    });

    it("should write the human report to logger.log", () => {
      expect(logger.logs[0]).toContain("npm-trust-cli doctor");
    });
  });

  describe("when --json is set", () => {
    let logger: CapturingLogger;

    beforeEach(async () => {
      setupHealthyEnvironment();
      logger = createLogger();
      await runDoctor({ cwd: "/tmp/x", logger, json: true });
    });

    it("should emit JSON to logger.log", () => {
      expect(JSON.parse(logger.logs[0] ?? "")).toMatchObject({ schemaVersion: 1 });
    });
  });

  describe("when a fail-severity issue is present", () => {
    let exitCode: number;

    beforeEach(async () => {
      stubNodeVersion("22.0.0");
      setupSpawnRoutes({
        gitRemote: { stdout: "https://github.com/gagle/npm-trust-cli.git\n", status: 0 },
      });
      discoverFromCwdMock.mockResolvedValueOnce(HEALTHY_WORKSPACE);
      globMock.mockImplementation((pattern: string) =>
        pattern.endsWith(".yml")
          ? asyncIterable([".github/workflows/release.yml"])
          : asyncIterable([]),
      );
      checkPackageStatusesAsyncMock.mockResolvedValueOnce([HEALTHY_PACKAGE]);
      exitCode = await runDoctor({ cwd: "/tmp/x", logger: createLogger() });
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });
  });
});
