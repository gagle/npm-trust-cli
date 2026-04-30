import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageStatus } from "./interfaces/cli.interface.js";

const spawnSyncMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: ReadonlyArray<unknown>) => spawnSyncMock(...args),
  spawn: (...args: ReadonlyArray<unknown>) => spawnMock(...args),
}));

const { checkPackageStatuses, checkPackageStatusesAsync, findUnconfiguredPackages } =
  await import("./diff.js");

interface SpawnInvocation {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

function recordedSyncCalls(): ReadonlyArray<SpawnInvocation> {
  return spawnSyncMock.mock.calls.map((call) => {
    const [bin, args] = call as [string, ReadonlyArray<string>];
    return { bin, args };
  });
}

function trustListResponse(stdout: string, status = 0): { stdout: string; status: number } {
  return { stdout, status };
}

function distResponseWithProvenance(): { stdout: string; status: number } {
  return {
    stdout: JSON.stringify({
      integrity: "sha512-deadbeef",
      shasum: "abc123",
      tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
      attestations: {
        url: "https://registry.npmjs.org/-/npm/v1/attestations/x@1.0.0",
        provenance: { predicateType: "https://slsa.dev/provenance/v1" },
      },
    }),
    status: 0,
  };
}

function distResponseWithoutProvenance(): { stdout: string; status: number } {
  return {
    stdout: JSON.stringify({
      integrity: "sha512-deadbeef",
      shasum: "abc123",
      tarball: "https://registry.npmjs.org/x/-/x-1.0.0.tgz",
    }),
    status: 0,
  };
}

function distResponseUnpublished(): { stdout: string; status: number } {
  return { stdout: "", status: 1 };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function queueAsyncResponse(stdout: string, status: number): void {
  spawnMock.mockImplementationOnce(() => {
    const child = createFakeChild();
    queueMicrotask(() => {
      if (stdout !== "") {
        child.stdout.emit("data", Buffer.from(stdout, "utf-8"));
      }
      child.emit("close", status);
    });
    return child;
  });
}

function queueAsyncError(): void {
  spawnMock.mockImplementationOnce(() => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.emit("error", new Error("ENOENT"));
    });
    return child;
  });
}

function queueAsyncCloseWithNullCode(): void {
  spawnMock.mockImplementationOnce(() => {
    const child = createFakeChild();
    queueMicrotask(() => {
      child.emit("close", null);
    });
    return child;
  });
}

function queueAsyncChildWithoutStdoutStderr(): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as FakeChild;
    Object.defineProperty(child, "stdout", { value: null });
    Object.defineProperty(child, "stderr", { value: null });
    return child;
  });
}

describe("checkPackageStatuses (sync)", () => {
  describe("when a package has trust configured, is published, and lacks provenance", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report every signal accurately", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/a",
        trustConfigured: true,
        published: true,
        hasProvenance: false,
      });
    });

    it("should call npm exactly twice per package", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(2);
    });
  });

  describe("when npm trust list returns empty stdout", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured false", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when npm trust list exits non-zero", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce({ stdout: "boom", status: 1 })
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured false", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when npm trust list returns no stdout field", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured false when stdout is missing", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when npm view dist exits non-zero (not published)", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseUnpublished());
      result = checkPackageStatuses(["@x/new"]);
    });

    it("should report published false and hasProvenance false", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/new",
        trustConfigured: true,
        published: false,
        hasProvenance: false,
      });
    });
  });

  describe("when npm view dist returns the dist object with attestations", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseWithProvenance());
      result = checkPackageStatuses(["@x/web-trusted"]);
    });

    it("should report hasProvenance true even when trustConfigured is false", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/web-trusted",
        trustConfigured: false,
        published: true,
        hasProvenance: true,
      });
    });
  });

  describe("when npm view dist exits zero but stdout is empty", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce({ stdout: "", status: 0 });
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should treat the package as not published", () => {
      expect(result[0]?.published).toBe(false);
    });
  });

  describe("when npm view dist returns malformed JSON", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce({ stdout: "{ not valid", status: 0 });
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should treat the package as published but without provenance", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/a",
        trustConfigured: true,
        published: true,
        hasProvenance: false,
      });
    });
  });

  describe("when npm view dist parses to a non-object", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce({ stdout: "42", status: 0 });
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should treat the package as published but without provenance", () => {
      expect(result[0]?.hasProvenance).toBe(false);
      expect(result[0]?.published).toBe(true);
    });
  });

  describe("when multiple packages are checked", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance())
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = checkPackageStatuses(["@x/a", "@x/b"]);
    });

    it("should preserve the input order", () => {
      expect(result.map((status) => status.pkg)).toStrictEqual(["@x/a", "@x/b"]);
    });

    it("should call npm twice per package (trust list + view dist --json)", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(4);
    });

    it("should pass --json to the npm view call", () => {
      const calls = recordedSyncCalls();
      expect(calls[1]?.args.slice(0, 4)).toStrictEqual(["view", "@x/a", "dist", "--json"]);
    });
  });

  describe("when called with no packages", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      result = checkPackageStatuses([]);
    });

    it("should return an empty list without invoking npm", () => {
      expect(result).toStrictEqual([]);
    });

    it("should not call spawnSync", () => {
      expect(spawnSyncMock).not.toHaveBeenCalled();
    });
  });

  describe("when spawnSync returns no stdout and no status fields", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({}).mockReturnValueOnce({});
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should default the captured stdout to empty and the status to 1", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/a",
        trustConfigured: false,
        published: false,
        hasProvenance: false,
      });
    });
  });
});

describe("checkPackageStatusesAsync", () => {
  describe("when a package has provenance and trust configured", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      queueAsyncResponse("github:o/r release.yml", 0);
      queueAsyncResponse(distResponseWithProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should report every signal accurately", () => {
      expect(result[0]).toStrictEqual({
        pkg: "@x/a",
        trustConfigured: true,
        published: true,
        hasProvenance: true,
      });
    });
  });

  describe("when the trust-list child errors before closing", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      queueAsyncError();
      queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should treat trust as not configured", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when called with more packages than the concurrency limit", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      for (let i = 0; i < 3; i++) {
        queueAsyncResponse("github:o/r release.yml", 0);
        queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      }
      result = await checkPackageStatusesAsync(["@x/a", "@x/b", "@x/c"], { concurrency: 2 });
    });

    it("should preserve input order across chunks", () => {
      expect(result.map((status) => status.pkg)).toStrictEqual(["@x/a", "@x/b", "@x/c"]);
    });

    it("should issue one trust-list and one view-dist call per package", () => {
      expect(spawnMock).toHaveBeenCalledTimes(6);
    });
  });

  describe("when called with no packages", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      result = await checkPackageStatusesAsync([]);
    });

    it("should return an empty list without invoking spawn", () => {
      expect(result).toStrictEqual([]);
    });

    it("should not call spawn", () => {
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });

  describe("when called without an explicit concurrency option", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      queueAsyncResponse("github:o/r release.yml", 0);
      queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should default to a single chunk and complete normally", () => {
      expect(result).toHaveLength(1);
    });
  });

  describe("when a child closes with a null exit code", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      queueAsyncCloseWithNullCode();
      queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should treat trust as not configured when the close code is null", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when a child emits data on stderr", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      spawnMock.mockImplementationOnce(() => {
        const child = createFakeChild();
        queueMicrotask(() => {
          child.stderr.emit("data", Buffer.from("npm warn: noisy", "utf-8"));
          child.stdout.emit("data", Buffer.from("github:o/r release.yml", "utf-8"));
          child.emit("close", 0);
        });
        return child;
      });
      queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should still resolve to a configured trust status", () => {
      expect(result[0]?.trustConfigured).toBe(true);
    });
  });

  describe("when the spawned child has no stdout/stderr streams", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(async () => {
      queueAsyncChildWithoutStdoutStderr();
      queueAsyncResponse(distResponseWithoutProvenance().stdout, 0);
      result = await checkPackageStatusesAsync(["@x/a"]);
    });

    it("should resolve the trust-list call with an error result", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });
});

describe("findUnconfiguredPackages", () => {
  describe("when every package is trust-configured and published", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance())
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = findUnconfiguredPackages(["@x/a", "@x/b"]);
    });

    it("should return an empty list", () => {
      expect(result).toStrictEqual([]);
    });
  });

  describe("when one package lacks trust configuration", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance())
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseWithoutProvenance());
      result = findUnconfiguredPackages(["@x/configured", "@x/missing"]);
    });

    it("should keep the unconfigured package and drop the configured one", () => {
      expect(result).toStrictEqual(["@x/missing"]);
    });
  });

  describe("when one package is unpublished", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseWithoutProvenance())
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(distResponseUnpublished());
      result = findUnconfiguredPackages(["@x/old", "@x/unpublished"]);
    });

    it("should keep the unpublished package even when trust is configured", () => {
      expect(result).toStrictEqual(["@x/unpublished"]);
    });
  });

  describe("when a package has SLSA provenance but no explicit trust record", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseWithProvenance());
      result = findUnconfiguredPackages(["@x/web-trusted"]);
    });

    it("should treat the package as effectively configured and drop it from the filter", () => {
      expect(result).toStrictEqual([]);
    });
  });

  describe("when both trust-list and provenance signals are missing", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(distResponseUnpublished());
      result = findUnconfiguredPackages(["@x/brand-new"]);
    });

    it("should keep the package", () => {
      expect(result).toStrictEqual(["@x/brand-new"]);
    });
  });
});
