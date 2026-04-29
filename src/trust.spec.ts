import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./interfaces/cli.interface.js";

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
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
}

describe("configureTrust", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    restoreIsTTY();
    vi.restoreAllMocks();
  });

  it("when dryRun is true it logs a dry-run line and never invokes npm", () => {
    const logger = createLogger();
    const summary = configureTrust({
      packages: ["@x/a", "@x/b"],
      repo: "o/r",
      workflow: "w.yml",
      dryRun: true,
      logger,
    });

    expect(spawnSyncMock).not.toHaveBeenCalled();
    expect(summary).toStrictEqual({
      configured: 0,
      already: 0,
      failed: 0,
      failedPackages: [],
    });
    expect(logger.lines.some((line) => line.includes("(dry run)"))).toBe(true);
  });

  it("when npm trust succeeds it counts as configured and passes args without --otp in argv", () => {
    spawnSyncMock.mockReturnValueOnce(ok());
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      otp: "123456",
      logger,
    });

    expect(summary.configured).toBe(1);
    expect(summary.failed).toBe(0);
    const [, args] = spawnSyncMock.mock.calls[0] ?? [];
    expect(args).toStrictEqual([
      "trust",
      "github",
      "@x/a",
      "--repo",
      "o/r",
      "--file",
      "w.yml",
      "--yes",
    ]);
    expect(args).not.toContain(`--otp=123456`);
  });

  it("when otp is provided it routes through NPM_CONFIG_OTP env (not argv)", () => {
    spawnSyncMock.mockReturnValueOnce(ok());

    configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      otp: "654321",
      logger: createLogger(),
    });

    const callOptions = spawnSyncMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(callOptions.env.NPM_CONFIG_OTP).toBe("654321");
  });

  it("when otp is omitted NPM_CONFIG_OTP is not set in the spawned env", () => {
    spawnSyncMock.mockReturnValueOnce(ok());

    configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger: createLogger(),
    });

    const callOptions = spawnSyncMock.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(callOptions.env.NPM_CONFIG_OTP).toBeUndefined();
  });

  it("when npm returns 409 it counts as already configured", () => {
    spawnSyncMock.mockReturnValueOnce(fail("npm error 409 Conflict"));
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.already).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it("when npm returns 404 it counts as not_published", () => {
    spawnSyncMock.mockReturnValueOnce(fail("npm error 404 Not Found"));
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
    expect(summary.failedPackages).toStrictEqual(["@x/a"]);
  });

  it("when npm reports an unknown error it counts as failed and continues", () => {
    spawnSyncMock.mockReturnValueOnce(fail("network ECONNRESET")).mockReturnValueOnce(ok());
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a", "@x/b"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
    expect(summary.configured).toBe(1);
    expect(summary.failedPackages).toStrictEqual(["@x/a"]);
  });

  it("when 2FA is required and otp is provided it does NOT fall back to interactive", () => {
    spawnSyncMock.mockReturnValueOnce(fail("EOTP one-time password required"));
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a", "@x/b"],
      repo: "o/r",
      workflow: "w.yml",
      otp: "wrong",
      logger,
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(summary.failed).toBe(1);
    expect(summary.failedPackages).toStrictEqual(["@x/a"]);
  });

  it("when 2FA is required and stdout is not a TTY it short-circuits to auth_failed", () => {
    spawnSyncMock.mockReturnValueOnce(fail("EOTP one-time password required"));
    stubIsTTY(false);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a", "@x/b"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(spawnSyncMock).toHaveBeenCalledTimes(1);
    expect(summary.failed).toBe(1);
  });

  it("when 2FA is required in TTY mode it falls back to interactive and stops on success", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP one-time password required"))
      .mockReturnValueOnce({ status: 0 });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.configured).toBe(1);
    expect(spawnSyncMock).toHaveBeenCalledTimes(2);
  });

  it("when interactive 2FA fails but a captured retry succeeds it counts configured", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP needs auth"))
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce(ok());
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.configured).toBe(1);
  });

  it("when interactive 2FA retry classifies as already it counts already", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP needs auth"))
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce(fail("409 Conflict"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.already).toBe(1);
  });

  it("when interactive 2FA retry classifies as not_published it counts as failed", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP"))
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce(fail("404 Not Found"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
  });

  it("when interactive 2FA retry still needs auth it counts as auth_failed and short-circuits remaining packages", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP"))
      .mockReturnValueOnce({ status: null })
      .mockReturnValueOnce(fail("EOTP again"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a", "@x/b"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
    expect(summary.failedPackages).toStrictEqual(["@x/a"]);
    expect(spawnSyncMock).toHaveBeenCalledTimes(3);
  });

  it("when interactive 2FA retry classifies as a generic error it counts as failed", () => {
    stubIsTTY(true);
    spawnSyncMock
      .mockReturnValueOnce(fail("EOTP"))
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce(fail("network reset"));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
  });

  it("when spawnSync returns no status it treats as failure", () => {
    spawnSyncMock.mockReturnValueOnce({});
    const logger = createLogger();

    const summary = configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
      logger,
    });

    expect(summary.failed).toBe(1);
  });

  it("when no logger is supplied it falls back to console.log", () => {
    spawnSyncMock.mockReturnValueOnce(ok());
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    configureTrust({
      packages: ["@x/a"],
      repo: "o/r",
      workflow: "w.yml",
    });

    expect(consoleSpy).toHaveBeenCalled();
  });
});

describe("listTrust", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("when npm prints output it logs it next to the package name", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "github:o/r release.yml", status: 0 });
    const logger = createLogger();

    listTrust({ packages: ["@x/a"], logger });

    expect(logger.lines.some((line) => line.includes("github:o/r"))).toBe(true);
  });

  it("when npm prints empty output it logs '(no trust configured)'", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 0 });
    const logger = createLogger();

    listTrust({ packages: ["@x/a"], logger });

    expect(logger.lines.some((line) => line.includes("(no trust configured)"))).toBe(true);
  });

  it("when npm exits non-zero it logs '(no trust configured)'", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 1 });
    const logger = createLogger();

    listTrust({ packages: ["@x/a"], logger });

    expect(logger.lines.some((line) => line.includes("(no trust configured)"))).toBe(true);
  });

  it("when no logger is supplied it falls back to console.log", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "ok", status: 0 });
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    listTrust({ packages: ["@x/a"] });

    expect(consoleSpy).toHaveBeenCalled();
  });

  it("when a package name contains shell metacharacters it passes them verbatim as argv", () => {
    spawnSyncMock.mockReturnValueOnce({ stdout: "", status: 0 });

    listTrust({ packages: ["@x/a$(echo PWNED)"], logger: createLogger() });

    const [, args] = spawnSyncMock.mock.calls[0] ?? [];
    expect(args).toStrictEqual(["trust", "list", "@x/a$(echo PWNED)"]);
  });
});
