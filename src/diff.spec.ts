import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PackageStatus } from "./interfaces/cli.interface.js";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: ReadonlyArray<unknown>) => spawnSyncMock(...args),
}));

const { checkPackageStatuses, findUnconfiguredPackages } = await import("./diff.js");

interface SpawnInvocation {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

function recordedCalls(): ReadonlyArray<SpawnInvocation> {
  return spawnSyncMock.mock.calls.map((call) => {
    const [bin, args] = call as [string, ReadonlyArray<string>];
    return { bin, args };
  });
}

function trustListResponse(stdout: string, status = 0): { stdout: string; status: number } {
  return { stdout, status };
}

function viewResponse(status: number, stdout = ""): { stdout: string; status: number } {
  return { stdout, status };
}

describe("checkPackageStatuses", () => {
  describe("when a package has trust configured and is published", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(0, "@x/a"));
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured true and published true", () => {
      expect(result[0]).toStrictEqual({ pkg: "@x/a", trustConfigured: true, published: true });
    });
  });

  describe("when npm trust list returns empty stdout", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(viewResponse(0));
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
        .mockReturnValueOnce(viewResponse(0));
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured false", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when npm trust list returns no stdout field", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock.mockReturnValueOnce({ status: 0 }).mockReturnValueOnce(viewResponse(0));
      result = checkPackageStatuses(["@x/a"]);
    });

    it("should report trustConfigured false when stdout is missing", () => {
      expect(result[0]?.trustConfigured).toBe(false);
    });
  });

  describe("when npm view exits non-zero (not published)", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(1, "npm error 404"));
      result = checkPackageStatuses(["@x/new"]);
    });

    it("should report published false", () => {
      expect(result[0]?.published).toBe(false);
    });
  });

  describe("when multiple packages are checked", () => {
    let result: ReadonlyArray<PackageStatus>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(0))
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(viewResponse(0));
      result = checkPackageStatuses(["@x/a", "@x/b"]);
    });

    it("should preserve the input order", () => {
      expect(result.map((status) => status.pkg)).toStrictEqual(["@x/a", "@x/b"]);
    });

    it("should call npm twice per package (trust list + view)", () => {
      expect(spawnSyncMock).toHaveBeenCalledTimes(4);
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
});

describe("findUnconfiguredPackages", () => {
  describe("when every package is trust-configured and published", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(0))
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(0));
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
        .mockReturnValueOnce(viewResponse(0))
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(viewResponse(0));
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
        .mockReturnValueOnce(viewResponse(0))
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(1));
      result = findUnconfiguredPackages(["@x/old", "@x/unpublished"]);
    });

    it("should keep the unpublished package even when trust is configured", () => {
      expect(result).toStrictEqual(["@x/unpublished"]);
    });
  });

  describe("when both signals are missing", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("", 0))
        .mockReturnValueOnce(viewResponse(1));
      result = findUnconfiguredPackages(["@x/brand-new"]);
    });

    it("should keep the package", () => {
      expect(result).toStrictEqual(["@x/brand-new"]);
    });
  });

  describe("when called", () => {
    beforeEach(() => {
      spawnSyncMock
        .mockReturnValueOnce(trustListResponse("github:o/r release.yml"))
        .mockReturnValueOnce(viewResponse(0));
      findUnconfiguredPackages(["@x/a"]);
    });

    it("should invoke npm trust list before npm view", () => {
      const calls = recordedCalls();
      expect(calls[0]?.args[0]).toBe("trust");
      expect(calls[1]?.args[0]).toBe("view");
    });
  });
});
