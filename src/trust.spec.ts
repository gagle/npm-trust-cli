import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger, TrustSummary } from "./interfaces/cli.interface.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: ReadonlyArray<unknown>) => spawnSyncMock(...args),
}));

const { configureTrust, listTrust } = await import("./trust.js");

interface CapturingLogger extends Logger {
  readonly lines: ReadonlyArray<string>;
}

function createLogger(): CapturingLogger {
  const lines: Array<string> = [];
  return {
    log: (message: string) => lines.push(message),
    lines,
  };
}

interface SpawnResult {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly status?: number;
}

function ok(): SpawnResult {
  return { stdout: "ok", stderr: "", status: 0 };
}

function fail(stderr: string, status = 1): SpawnResult {
  return { stdout: "", stderr, status };
}

const ORIGINAL_IS_TTY_DESCRIPTOR = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function stubIsTTY(value: boolean): void {
  Object.defineProperty(process.stdout, "isTTY", {
    value,
    configurable: true,
  });
}

function restoreIsTTY(): void {
  if (ORIGINAL_IS_TTY_DESCRIPTOR) {
    Object.defineProperty(process.stdout, "isTTY", ORIGINAL_IS_TTY_DESCRIPTOR);
    return;
  }
  Reflect.deleteProperty(process.stdout, "isTTY");
}

describe("configureTrust", () => {
  beforeEach(() => {
    restoreIsTTY();
  });

  describe("when dryRun is true", () => {
    let summary: TrustSummary;
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      summary = configureTrust({
        packages: ["@x/a", "@x/b"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should not invoke npm", () => {
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it("should report zero configured/already/failed and an empty failedPackages", () => {
      expect(summary).toStrictEqual({
        configured: 0,
        already: 0,
        failed: 0,
        failedPackages: [],
      });
    });

    it("should log a (dry run) line for each package", () => {
      expect(logger.lines.some((line) => line.includes("(dry run)"))).toBe(true);
    });
  });

  describe("when npm trust succeeds for a single package", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(ok());
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as configured", () => {
      expect(summary.configured).toBe(1);
    });

    it("should report zero failures", () => {
      expect(summary.failed).toBe(0);
    });

    it("should pass the npm trust argv", () => {
      expect(spawnSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        ["trust", "github", "@x/a", "--repo", "o/r", "--file", "w.yml", "--yes"],
        expect.anything(),
      );
    });
  });

  describe("when npm returns a 409 conflict", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(fail("npm error 409 Conflict"));
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as already configured", () => {
      expect(summary.already).toBe(1);
    });

    it("should report zero failures", () => {
      expect(summary.failed).toBe(0);
    });
  });

  describe("when npm returns a 404 not found", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(fail("npm error 404 Not Found"));
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as failed (not_published)", () => {
      expect(summary.failed).toBe(1);
    });

    it("should record the package in failedPackages", () => {
      expect(summary.failedPackages).toStrictEqual(["@x/a"]);
    });
  });

  describe("when npm reports an unknown error and a later package succeeds", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(fail("network ECONNRESET")).mockReturnValueOnce(ok());
      summary = configureTrust({
        packages: ["@x/a", "@x/b"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the failure", () => {
      expect(summary.failed).toBe(1);
    });

    it("should still process the next package and count it as configured", () => {
      expect(summary.configured).toBe(1);
    });

    it("should record only the failing package in failedPackages", () => {
      expect(summary.failedPackages).toStrictEqual(["@x/a"]);
    });
  });

  describe("when 2FA is required and stdout is not a TTY (non-interactive)", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(false);
      spawnSyncMock.mockReturnValueOnce(fail("EOTP one-time password required"));
      summary = configureTrust({
        packages: ["@x/a", "@x/b"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should short-circuit without prompting", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    });

    it("should count the package as failed (auth_failed)", () => {
      expect(summary.failed).toBe(1);
    });
  });

  describe("when 2FA is required in TTY mode and the interactive retry succeeds", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP one-time password required"))
        .mockReturnValueOnce({ status: 0 });
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as configured", () => {
      expect(summary.configured).toBe(1);
    });

    it("should invoke npm twice (captured + interactive)", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("when interactive 2FA exits non-zero but a captured retry then succeeds", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP needs auth"))
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce(ok());
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as configured", () => {
      expect(summary.configured).toBe(1);
    });
  });

  describe("when the interactive 2FA retry classifies as 'already configured'", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP needs auth"))
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce(fail("409 Conflict"));
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as already configured", () => {
      expect(summary.already).toBe(1);
    });
  });

  describe("when the interactive 2FA retry classifies as 'not published' (404)", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP"))
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce(fail("404 Not Found"));
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as failed", () => {
      expect(summary.failed).toBe(1);
    });
  });

  describe("when the interactive 2FA retry still requires auth", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP"))
        .mockReturnValueOnce({ status: null })
        .mockReturnValueOnce(fail("EOTP again"));
      summary = configureTrust({
        packages: ["@x/a", "@x/b"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as failed", () => {
      expect(summary.failed).toBe(1);
    });

    it("should record the package in failedPackages", () => {
      expect(summary.failedPackages).toStrictEqual(["@x/a"]);
    });

    it("should short-circuit remaining packages after the third attempt", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(3);
    });
  });

  describe("when the interactive 2FA retry classifies as a generic error", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      stubIsTTY(true);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      spawnSyncMock
        .mockReturnValueOnce(fail("EOTP"))
        .mockReturnValueOnce({ status: 1 })
        .mockReturnValueOnce(fail("network reset"));
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as failed", () => {
      expect(summary.failed).toBe(1);
    });
  });

  describe("when spawnSync returns no status field", () => {
    let summary: TrustSummary;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({});
      summary = configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        logger: createLogger(),
      });
    });

    it("should count the package as failed", () => {
      expect(summary.failed).toBe(1);
    });
  });

  describe("when no logger is supplied", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(ok());
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      configureTrust({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
      });
    });

    it("should fall back to console.log", () => {
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("when all packages share the same scope", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      configureTrust({
        packages: ["@myorg/a", "@myorg/b"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should append the inferred scope to the header", () => {
      expect(logger.lines[0]).toBe("Configuring OIDC trusted publishing for 2 packages in @myorg");
    });
  });

  describe("when packages come from different scopes", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      configureTrust({
        packages: ["@one/a", "@two/b"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should omit the scope suffix from the header", () => {
      expect(logger.lines[0]).toBe("Configuring OIDC trusted publishing for 2 packages");
    });
  });

  describe("when packages are unscoped", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      configureTrust({
        packages: ["plain-pkg"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should omit the scope suffix from the header", () => {
      expect(logger.lines[0]).toBe("Configuring OIDC trusted publishing for 1 packages");
    });
  });

  describe("when a package name is just a scope marker without a slash", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      configureTrust({
        packages: ["@onlyScope"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should omit the scope suffix from the header", () => {
      expect(logger.lines[0]).toBe("Configuring OIDC trusted publishing for 1 packages");
    });
  });

  describe("when the packages list is empty", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      configureTrust({
        packages: [],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: true,
        logger,
      });
    });

    it("should omit the scope suffix from the header", () => {
      expect(logger.lines[0]).toBe("Configuring OIDC trusted publishing for 0 packages");
    });
  });
});

describe("listTrust", () => {
  describe("when npm prints output for the package", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "github:o/r release.yml", status: 0 });
      logger = createLogger();
      listTrust({ packages: ["@x/a"], logger });
    });

    it("should log npm's output next to the package name", () => {
      expect(logger.lines.some((line) => line.includes("github:o/r"))).toBe(true);
    });
  });

  describe("when npm prints empty output", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 0 });
      logger = createLogger();
      listTrust({ packages: ["@x/a"], logger });
    });

    it("should log '(no trust configured)'", () => {
      expect(logger.lines.some((line) => line.includes("(no trust configured)"))).toBe(true);
    });
  });

  describe("when npm exits non-zero", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 1 });
      logger = createLogger();
      listTrust({ packages: ["@x/a"], logger });
    });

    it("should log '(no trust configured)'", () => {
      expect(logger.lines.some((line) => line.includes("(no trust configured)"))).toBe(true);
    });
  });

  describe("when no logger is supplied", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "ok", status: 0 });
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      listTrust({ packages: ["@x/a"] });
    });

    it("should fall back to console.log", () => {
      expect(consoleSpy).toHaveBeenCalled();
    });
  });

  describe("when a package name contains shell metacharacters", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 0 });
      listTrust({ packages: ["@x/a$(echo PWNED)"], logger: createLogger() });
    });

    it("should pass the name verbatim as argv (no shell expansion)", () => {
      expect(spawnSyncMock).toHaveBeenCalledWith(
        expect.any(String),
        ["trust", "list", "@x/a$(echo PWNED)"],
        expect.anything(),
      );
    });
  });

  describe("when all packages share the same scope", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce({ stdout: "", status: 0 })
        .mockReturnValueOnce({ stdout: "", status: 0 });
      logger = createLogger();
      listTrust({ packages: ["@myorg/a", "@myorg/b"], logger });
    });

    it("should append the inferred scope to the header", () => {
      expect(logger.lines[0]).toBe("Checking trust status for 2 packages in @myorg");
    });
  });

  describe("when packages come from different scopes", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce({ stdout: "", status: 0 })
        .mockReturnValueOnce({ stdout: "", status: 0 });
      logger = createLogger();
      listTrust({ packages: ["@one/a", "@two/b"], logger });
    });

    it("should omit the scope suffix from the header", () => {
      expect(logger.lines[0]).toBe("Checking trust status for 2 packages");
    });
  });
});
