import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.fn();
const discoverPackagesMock = vi.fn();
const configureTrustMock = vi.fn();
const listTrustMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: ReadonlyArray<unknown>) => spawnSyncMock(...args),
}));

vi.mock("./discover.js", () => ({
  discoverPackages: (...args: ReadonlyArray<unknown>) => discoverPackagesMock(...args),
}));

vi.mock("./trust.js", () => ({
  configureTrust: (...args: ReadonlyArray<unknown>) => configureTrustMock(...args),
  listTrust: (...args: ReadonlyArray<unknown>) => listTrustMock(...args),
}));

const { CliError, checkNodeVersion, checkNpmVersion, parseCliArgs, printUsage, runCli } =
  await import("./cli.js");

interface CapturingLogger {
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly logs: ReadonlyArray<string>;
  readonly errors: ReadonlyArray<string>;
}

function createLogger(): CapturingLogger {
  const logs: Array<string> = [];
  const errors: Array<string> = [];
  return {
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    logs,
    errors,
  };
}

const ORIGINAL_NODE_VERSION = process.versions.node;

function stubNodeVersion(version: string | undefined): void {
  Object.defineProperty(process.versions, "node", {
    value: version,
    configurable: true,
  });
}

function restoreNodeVersion(): void {
  stubNodeVersion(ORIGINAL_NODE_VERSION);
}

function npmVersionResult(version: string): { stdout: string; status: number } {
  return { stdout: `${version}\n`, status: 0 };
}

describe("CliError", () => {
  let error: InstanceType<typeof CliError>;

  beforeEach(() => {
    error = new CliError("boom", 2);
  });

  it("should preserve the message", () => {
    expect(error.message).toBe("boom");
  });

  it("should preserve the exit code", () => {
    expect(error.exitCode).toBe(2);
  });

  it("should set the name to CliError", () => {
    expect(error.name).toBe("CliError");
  });

  it("should be an instance of Error", () => {
    expect(error).toBeInstanceOf(Error);
  });
});

describe("checkNodeVersion", () => {
  beforeEach(() => {
    restoreNodeVersion();
  });

  describe("when the node major version is below 24", () => {
    beforeEach(() => {
      stubNodeVersion("22.0.0");
    });

    it("should throw CliError with exit code 1", () => {
      expect(() => checkNodeVersion()).toThrowError(CliError);
    });
  });

  describe("when the node major version is 24 or above", () => {
    beforeEach(() => {
      stubNodeVersion("24.1.0");
    });

    it("should not throw", () => {
      expect(() => checkNodeVersion()).not.toThrow();
    });
  });

  describe("when the node version string is unparseable", () => {
    beforeEach(() => {
      stubNodeVersion("not-a-version");
    });

    it("should throw CliError", () => {
      expect(() => checkNodeVersion()).toThrowError(CliError);
    });
  });
});

describe("checkNpmVersion", () => {
  describe("when the npm major version is at or above 11", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(npmVersionResult("11.5.1"));
    });

    it("should not throw", () => {
      expect(() => checkNpmVersion()).not.toThrow();
    });
  });

  describe("when the npm major version is below 11", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(npmVersionResult("10.9.0"));
    });

    it("should throw CliError", () => {
      expect(() => checkNpmVersion()).toThrowError(CliError);
    });
  });

  describe("when spawnSync surfaces an error", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ error: new Error("ENOENT") });
    });

    it("should throw a CliError suggesting installation", () => {
      expect(() => checkNpmVersion()).toThrowError(/npm >= 11/);
    });
  });

  describe("when spawnSync exits non-zero", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 127 });
    });

    it("should throw a CliError noting the version could not be determined", () => {
      expect(() => checkNpmVersion()).toThrowError(/could not determine npm version/);
    });
  });

  describe("when the npm version output is unparseable", () => {
    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce(npmVersionResult("garbage"));
    });

    it("should throw CliError", () => {
      expect(() => checkNpmVersion()).toThrowError(CliError);
    });
  });
});

describe("printUsage", () => {
  describe("when called with a logger", () => {
    let logger: CapturingLogger;

    beforeEach(() => {
      logger = createLogger();
      printUsage(logger);
    });

    it("should log the help text including the binary name", () => {
      expect(logger.logs[0]).toContain("npm-trust-cli");
    });

    it("should log the help text including the --otp flag", () => {
      expect(logger.logs[0]).toContain("--otp");
    });
  });

  describe("when called without a logger", () => {
    let consoleSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      printUsage();
    });

    it("should fall back to console.log", () => {
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});

describe("parseCliArgs", () => {
  describe("when --help is passed", () => {
    it("should set helpRequested to true", () => {
      expect(parseCliArgs(["--help"]).helpRequested).toBe(true);
    });
  });

  describe("when --packages is passed multiple times", () => {
    it("should collect every value into options.packages", () => {
      expect(
        parseCliArgs(["--packages", "@x/a", "--packages", "@x/b"]).options.packages,
      ).toStrictEqual(["@x/a", "@x/b"]);
    });
  });

  describe("when positional args are passed without --packages", () => {
    it("should treat the positionals as packages", () => {
      expect(parseCliArgs(["pkg1", "pkg2"]).options.packages).toStrictEqual(["pkg1", "pkg2"]);
    });
  });

  describe("when --packages and positionals are both supplied", () => {
    it("should give --packages precedence over positionals", () => {
      expect(parseCliArgs(["--packages", "@x/a", "extra"]).options.packages).toStrictEqual([
        "@x/a",
      ]);
    });
  });

  describe("when neither packages nor positionals are given", () => {
    it("should leave options.packages undefined", () => {
      expect(parseCliArgs(["--scope", "@x"]).options.packages).toBeUndefined();
    });
  });

  describe("when an unknown flag is passed", () => {
    it("should reject in strict mode", () => {
      expect(() => parseCliArgs(["--otp-code", "123456"])).toThrow();
    });
  });

  describe("when every flag is supplied together", () => {
    let options: ReturnType<typeof parseCliArgs>["options"];

    beforeEach(() => {
      options = parseCliArgs([
        "--scope",
        "@x",
        "--repo",
        "o/r",
        "--workflow",
        "w.yml",
        "--list",
        "--dry-run",
        "--otp",
        "123456",
      ]).options;
    });

    it("should capture every value", () => {
      expect(options).toMatchObject({
        scope: "@x",
        repo: "o/r",
        workflow: "w.yml",
        list: true,
        dryRun: true,
        otp: "123456",
      });
    });
  });
});

describe("runCli", () => {
  beforeEach(() => {
    restoreNodeVersion();
    stubNodeVersion("24.0.0");
    spawnSyncMock.mockReturnValue(npmVersionResult("11.5.1"));
  });

  describe("when the node version check fails", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      stubNodeVersion("22.0.0");
      logger = createLogger();
      exitCode = await runCli(["--help"], logger);
    });

    it("should return the CliError exit code (1)", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a message mentioning Node.js >= 24", () => {
      expect(logger.errors[0]).toContain("Node.js >= 24");
    });
  });

  describe("when the npm version check fails", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      spawnSyncMock.mockReturnValue(npmVersionResult("10.0.0"));
      logger = createLogger();
      exitCode = await runCli(["--help"], logger);
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a message mentioning npm >= 11", () => {
      expect(logger.errors[0]).toContain("npm >= 11");
    });
  });

  describe("when --help is passed", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--help"], logger);
    });

    it("should exit 0", () => {
      expect(exitCode).toBe(0);
    });

    it("should print the usage text", () => {
      expect(logger.logs[0]).toContain("npm-trust-cli");
    });
  });

  describe("when an unknown flag is passed", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--bogus"], logger);
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log an error line", () => {
      expect(logger.errors[0]).toContain("Error:");
    });

    it("should hint at --help", () => {
      expect(logger.errors[1]).toContain("--help");
    });
  });

  describe("when --otp has an invalid shape", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--packages", "@x/a", "--otp", "abc"], logger);
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a 6-8 digit validation error", () => {
      expect(logger.errors[0]).toContain("--otp must be a 6-8 digit");
    });
  });

  describe("when neither --scope nor --packages is set", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli([], logger);
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a message about --scope or --packages", () => {
      expect(logger.errors[0]).toContain("--scope or --packages");
    });
  });

  describe("when discovery returns zero packages", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      discoverPackagesMock.mockResolvedValueOnce([]);
      logger = createLogger();
      exitCode = await runCli(["--scope", "@x"], logger);
    });

    it("should return exit code 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log 'No packages found'", () => {
      expect(logger.errors[0]).toBe("No packages found");
    });
  });

  describe("when --scope discovers packages", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      discoverPackagesMock.mockResolvedValueOnce(["@x/a", "@x/b"]);
      configureTrustMock.mockReturnValueOnce({
        configured: 2,
        already: 0,
        failed: 0,
        failedPackages: [],
      });
      logger = createLogger();
      exitCode = await runCli(["--scope", "@x", "--repo", "o/r", "--workflow", "w.yml"], logger);
    });

    it("should exit 0", () => {
      expect(exitCode).toBe(0);
    });

    it("should forward the discovered packages to configureTrust", () => {
      expect(configureTrustMock).toHaveBeenCalledWith(
        expect.objectContaining({ packages: ["@x/a", "@x/b"] }),
      );
    });

    it("should log the discovered count", () => {
      expect(logger.logs.some((line) => line.includes("Found 2 packages"))).toBe(true);
    });
  });

  describe("when --list is used", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--packages", "@x/a", "--list"], logger);
    });

    it("should exit 0", () => {
      expect(exitCode).toBe(0);
    });

    it("should call listTrust with the packages and logger", () => {
      expect(listTrustMock).toHaveBeenCalledWith({
        packages: ["@x/a"],
        logger,
      });
    });
  });

  describe("when configure is requested without --repo", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--packages", "@x/a", "--workflow", "w.yml"], logger);
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a missing --repo error", () => {
      expect(logger.errors[0]).toContain("--repo");
    });
  });

  describe("when configure is requested without --workflow", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(["--packages", "@x/a", "--repo", "o/r"], logger);
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log a missing --workflow error", () => {
      expect(logger.errors[0]).toContain("--workflow");
    });
  });

  describe("when --repo has an invalid shape", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(
        ["--packages", "@x/a", "--repo", "no-slash", "--workflow", "w.yml"],
        logger,
      );
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log the --repo validation error", () => {
      expect(logger.errors[0]).toContain("--repo must match");
    });
  });

  describe("when --workflow has an invalid shape", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      logger = createLogger();
      exitCode = await runCli(
        ["--packages", "@x/a", "--repo", "o/r", "--workflow", "release.txt"],
        logger,
      );
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log the --workflow validation error", () => {
      expect(logger.errors[0]).toContain("--workflow must be a .yml");
    });
  });

  describe("when configure succeeds with no failures", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      configureTrustMock.mockReturnValueOnce({
        configured: 1,
        already: 0,
        failed: 0,
        failedPackages: [],
      });
      logger = createLogger();
      exitCode = await runCli(
        ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml", "--otp", "123456"],
        logger,
      );
    });

    it("should exit 0", () => {
      expect(exitCode).toBe(0);
    });

    it("should forward every option to configureTrust (without otp in the public payload)", () => {
      expect(configureTrustMock).toHaveBeenCalledWith({
        packages: ["@x/a"],
        repo: "o/r",
        workflow: "w.yml",
        dryRun: false,
        logger,
      });
    });

    it("should route the OTP through process.env.NPM_CONFIG_OTP for the spawned npm to inherit", () => {
      expect(process.env.NPM_CONFIG_OTP).toBe("123456");
    });
  });

  describe("when configure reports failures", () => {
    let exitCode: number;

    beforeEach(async () => {
      configureTrustMock.mockReturnValueOnce({
        configured: 0,
        already: 0,
        failed: 1,
        failedPackages: ["@x/a"],
      });
      exitCode = await runCli(
        ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
        createLogger(),
      );
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });
  });

  describe("when --dry-run is set", () => {
    beforeEach(async () => {
      configureTrustMock.mockReturnValueOnce({
        configured: 0,
        already: 0,
        failed: 0,
        failedPackages: [],
      });
      await runCli(
        ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml", "--dry-run"],
        createLogger(),
      );
    });

    it("should forward dryRun=true to configureTrust", () => {
      expect(configureTrustMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    });
  });

  describe("when no logger is supplied", () => {
    let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
    let exitCode: number;

    beforeEach(async () => {
      consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      exitCode = await runCli([]);
    });

    it("should exit 1 (no scope/packages)", () => {
      expect(exitCode).toBe(1);
    });

    it("should fall back to console.error", () => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
  });

  describe("when a non-CliError is thrown internally", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      stubNodeVersion(undefined);
      logger = createLogger();
      exitCode = await runCli(["--help"], logger);
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should log the message prefixed with 'Error: '", () => {
      expect(logger.errors[0]).toMatch(/^Error: /);
    });
  });

  describe("when a non-Error value is thrown", () => {
    let logger: CapturingLogger;
    let exitCode: number;

    beforeEach(async () => {
      stubNodeVersion("24.0.0");
      spawnSyncMock.mockReturnValueOnce(npmVersionResult("11.5.1"));
      discoverPackagesMock.mockRejectedValueOnce("plain string failure");
      logger = createLogger();
      exitCode = await runCli(["--scope", "@x"], logger);
    });

    it("should exit 1", () => {
      expect(exitCode).toBe(1);
    });

    it("should coerce the value into the error log message", () => {
      expect(logger.errors[0]).toBe("Error: plain string failure");
    });
  });
});
