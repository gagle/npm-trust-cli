import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

const cli = await import("./cli.js");
const { CliError, checkNodeVersion, checkNpmVersion, parseCliArgs, printUsage, runCli } = cli;

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
    log: (m) => logs.push(m),
    error: (m) => errors.push(m),
    logs,
    errors,
  };
}

function stubNodeVersion(version: string): void {
  Object.defineProperty(process.versions, "node", {
    value: version,
    configurable: true,
  });
}

function npmVersionResult(version: string): { stdout: string; status: number } {
  return { stdout: `${version}\n`, status: 0 };
}

const ORIGINAL_NODE_VERSION = process.versions.node;

afterEach(() => {
  stubNodeVersion(ORIGINAL_NODE_VERSION);
  spawnSyncMock.mockReset();
  discoverPackagesMock.mockReset();
  configureTrustMock.mockReset();
  listTrustMock.mockReset();
});

describe("CliError", () => {
  it("when constructed it preserves message and exit code", () => {
    const err = new CliError("boom", 2);
    expect(err.message).toBe("boom");
    expect(err.exitCode).toBe(2);
    expect(err.name).toBe("CliError");
    expect(err).toBeInstanceOf(Error);
  });
});

describe("checkNodeVersion", () => {
  it("when node major is below 24 it throws CliError with exit code 1", () => {
    stubNodeVersion("22.0.0");
    expect(() => checkNodeVersion()).toThrowError(CliError);
  });

  it("when node major is 24 or above it does not throw", () => {
    stubNodeVersion("24.1.0");
    expect(() => checkNodeVersion()).not.toThrow();
  });

  it("when node version is unparseable it throws CliError", () => {
    stubNodeVersion("not-a-version");
    expect(() => checkNodeVersion()).toThrowError(CliError);
  });
});

describe("checkNpmVersion", () => {
  it("when npm major is at or above 11 it does not throw", () => {
    spawnSyncMock.mockReturnValueOnce(npmVersionResult("11.5.1"));
    expect(() => checkNpmVersion()).not.toThrow();
  });

  it("when npm major is below 11 it throws CliError", () => {
    spawnSyncMock.mockReturnValueOnce(npmVersionResult("10.9.0"));
    expect(() => checkNpmVersion()).toThrowError(CliError);
  });

  it("when spawnSync surfaces an error it throws a CliError suggesting installation", () => {
    spawnSyncMock.mockReturnValueOnce({ error: new Error("ENOENT") });
    expect(() => checkNpmVersion()).toThrowError(/npm >= 11/);
  });

  it("when spawnSync exits non-zero it throws a CliError suggesting installation", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 127 });
    expect(() => checkNpmVersion()).toThrowError(/could not determine npm version/);
  });

  it("when npm version output is unparseable it throws CliError", () => {
    spawnSyncMock.mockReturnValueOnce(npmVersionResult("garbage"));
    expect(() => checkNpmVersion()).toThrowError(CliError);
  });
});

describe("printUsage", () => {
  it("when called with a logger it logs the help text", () => {
    const logger = createLogger();
    printUsage(logger);
    expect(logger.logs[0]).toContain("npm-trust-cli");
    expect(logger.logs[0]).toContain("--otp");
  });

  it("when called without a logger it falls back to console.log", () => {
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    printUsage();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("parseCliArgs", () => {
  it("when --help is passed it sets helpRequested", () => {
    const result = parseCliArgs(["--help"]);
    expect(result.helpRequested).toBe(true);
  });

  it("when --packages is passed multiple times it collects all values", () => {
    const result = parseCliArgs(["--packages", "@x/a", "--packages", "@x/b"]);
    expect(result.options.packages).toStrictEqual(["@x/a", "@x/b"]);
  });

  it("when positionals are passed without --packages they become packages", () => {
    const result = parseCliArgs(["pkg1", "pkg2"]);
    expect(result.options.packages).toStrictEqual(["pkg1", "pkg2"]);
  });

  it("when --packages is set it takes precedence over positionals", () => {
    const result = parseCliArgs(["--packages", "@x/a", "extra"]);
    expect(result.options.packages).toStrictEqual(["@x/a"]);
  });

  it("when no packages or positionals are given packages is undefined", () => {
    const result = parseCliArgs(["--scope", "@x"]);
    expect(result.options.packages).toBeUndefined();
  });

  it("when an unknown flag is passed strict mode rejects it", () => {
    expect(() => parseCliArgs(["--otp-code", "123456"])).toThrow();
  });

  it("when all flags are passed it captures them", () => {
    const result = parseCliArgs([
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
    ]);
    expect(result.options).toMatchObject({
      scope: "@x",
      repo: "o/r",
      workflow: "w.yml",
      list: true,
      dryRun: true,
      otp: "123456",
    });
  });
});

describe("runCli", () => {
  beforeEach(() => {
    stubNodeVersion("24.0.0");
    spawnSyncMock.mockReturnValue(npmVersionResult("11.5.1"));
  });

  it("when node version check fails it returns the CliError exit code", async () => {
    stubNodeVersion("22.0.0");
    const logger = createLogger();
    const exitCode = await runCli(["--help"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("Node.js >= 24");
  });

  it("when npm version check fails it returns the CliError exit code", async () => {
    spawnSyncMock.mockReturnValue(npmVersionResult("10.0.0"));
    const logger = createLogger();
    const exitCode = await runCli(["--help"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("npm >= 11");
  });

  it("when --help is passed it prints usage and exits 0", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--help"], logger);
    expect(exitCode).toBe(0);
    expect(logger.logs[0]).toContain("npm-trust-cli");
  });

  it("when an unknown flag is passed it returns 1 with a usage hint", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--bogus"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("Error:");
    expect(logger.errors[1]).toContain("--help");
  });

  it("when --otp shape is invalid it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--packages", "@x/a", "--otp", "abc"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--otp must be a 6-8 digit");
  });

  it("when neither scope nor packages is set it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli([], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--scope or --packages");
  });

  it("when discovery returns no packages it returns 1", async () => {
    discoverPackagesMock.mockResolvedValueOnce([]);
    const logger = createLogger();
    const exitCode = await runCli(["--scope", "@x"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toBe("No packages found");
  });

  it("when --scope discovers packages it forwards them to configureTrust", async () => {
    discoverPackagesMock.mockResolvedValueOnce(["@x/a", "@x/b"]);
    configureTrustMock.mockReturnValueOnce({
      configured: 2,
      already: 0,
      failed: 0,
      failedPackages: [],
    });
    const logger = createLogger();
    const exitCode = await runCli(
      ["--scope", "@x", "--repo", "o/r", "--workflow", "w.yml"],
      logger,
    );
    expect(exitCode).toBe(0);
    expect(configureTrustMock.mock.calls[0]?.[0]).toMatchObject({
      packages: ["@x/a", "@x/b"],
    });
    expect(logger.logs.some((line) => line.includes("Found 2 packages"))).toBe(true);
  });

  it("when --list is used it calls listTrust and returns 0", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--packages", "@x/a", "--list"], logger);
    expect(exitCode).toBe(0);
    expect(listTrustMock).toHaveBeenCalledWith({
      packages: ["@x/a"],
      logger,
    });
  });

  it("when configure is requested without --repo it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--packages", "@x/a", "--workflow", "w.yml"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--repo");
  });

  it("when configure is requested without --workflow it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli(["--packages", "@x/a", "--repo", "o/r"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--workflow");
  });

  it("when --repo shape is invalid it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli(
      ["--packages", "@x/a", "--repo", "no-slash", "--workflow", "w.yml"],
      logger,
    );
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--repo must match");
  });

  it("when --workflow shape is invalid it returns 1", async () => {
    const logger = createLogger();
    const exitCode = await runCli(
      ["--packages", "@x/a", "--repo", "o/r", "--workflow", "release.txt"],
      logger,
    );
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toContain("--workflow must be a .yml");
  });

  it("when configure succeeds with no failures it returns 0 and forwards options", async () => {
    configureTrustMock.mockReturnValueOnce({
      configured: 1,
      already: 0,
      failed: 0,
      failedPackages: [],
    });
    const logger = createLogger();
    const exitCode = await runCli(
      ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml", "--otp", "123456"],
      logger,
    );
    expect(exitCode).toBe(0);
    expect(configureTrustMock).toHaveBeenCalledWith({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      dryRun: false,
      otp: "123456",
      logger,
    });
  });

  it("when configure reports failures it returns 1", async () => {
    configureTrustMock.mockReturnValueOnce({
      configured: 0,
      already: 0,
      failed: 1,
      failedPackages: ["@x/a"],
    });
    const logger = createLogger();
    const exitCode = await runCli(
      ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
      logger,
    );
    expect(exitCode).toBe(1);
  });

  it("when --dry-run is set it forwards dryRun=true", async () => {
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
    expect(configureTrustMock.mock.calls[0]?.[0]).toMatchObject({
      dryRun: true,
    });
  });

  it("when no logger is supplied it falls back to console", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitCode = await runCli([]);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("when an unexpected non-CliError is thrown it is logged and returns exit code 1", async () => {
    Object.defineProperty(process.versions, "node", {
      value: undefined,
      configurable: true,
    });
    const logger = createLogger();
    const exitCode = await runCli(["--help"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toMatch(/^Error: /);
  });

  it("when a non-Error value is thrown it is coerced to a string in the message", async () => {
    stubNodeVersion("24.0.0");
    spawnSyncMock.mockReturnValueOnce(npmVersionResult("11.5.1"));
    discoverPackagesMock.mockRejectedValueOnce("plain string failure");
    const logger = createLogger();
    const exitCode = await runCli(["--scope", "@x"], logger);
    expect(exitCode).toBe(1);
    expect(logger.errors[0]).toBe("Error: plain string failure");
  });
});
