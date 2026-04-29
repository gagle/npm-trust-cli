import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverPackages } from "./discover.js";

interface RegistryPage {
  readonly objects: ReadonlyArray<{ readonly package: { readonly name: string } }>;
  readonly total: number;
}

function fakeResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Not Found",
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function pageResponse(body: RegistryPage, ok = true, status = 200): Response {
  return fakeResponse(body, ok, status);
}

describe("discoverPackages", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe("when the scope is normalised", () => {
    it("should add a leading @ when missing", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }));
      await discoverPackages("myorg");
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toContain(encodeURIComponent("@myorg"));
    });

    it("should leave an existing @ prefix alone", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }));
      await discoverPackages("@myorg");
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toContain(encodeURIComponent("@myorg"));
    });
  });

  describe("when the registry responds successfully", () => {
    it("should return sorted package names for a single page", async () => {
      fetchMock.mockResolvedValueOnce(
        pageResponse({
          objects: [{ package: { name: "@x/b" } }, { package: { name: "@x/a" } }],
          total: 2,
        }),
      );
      const result = await discoverPackages("@x");
      expect(result).toStrictEqual(["@x/a", "@x/b"]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("should paginate until all pages are fetched", async () => {
      const page1Objects = Array.from({ length: 250 }, (_, i) => ({
        package: { name: `@x/p${String(i).padStart(3, "0")}` },
      }));
      const page2Objects = [{ package: { name: "@x/p999" } }];
      fetchMock
        .mockResolvedValueOnce(pageResponse({ objects: page1Objects, total: 251 }))
        .mockResolvedValueOnce(pageResponse({ objects: page2Objects, total: 251 }));

      const result = await discoverPackages("@x");

      expect(result).toHaveLength(251);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1]?.[0]).toContain("from=250");
    });

    it("should stop pagination when an empty page is returned", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 999 }));
      const result = await discoverPackages("@x");
      expect(result).toStrictEqual([]);
    });

    it("should pass an AbortSignal timeout to fetch", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }));
      await discoverPackages("@x");
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[1]?.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe("when the registry returns a non-ok response", () => {
    it("should throw with the status code", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }, false, 503));
      await expect(discoverPackages("@x")).rejects.toThrow(/Registry search failed: 503/);
    });
  });

  describe("when NPM_TRUST_CLI_REGISTRY is set", () => {
    it("should use the configured registry with the trailing slash stripped", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }));
      vi.stubEnv("NPM_TRUST_CLI_REGISTRY", "http://127.0.0.1:1234/");
      await discoverPackages("@x");
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toMatch(/^http:\/\/127\.0\.0\.1:1234\/-\/v1\/search/);
    });

    it("should accept http://localhost", async () => {
      fetchMock.mockResolvedValueOnce(pageResponse({ objects: [], total: 0 }));
      vi.stubEnv("NPM_TRUST_CLI_REGISTRY", "http://localhost:4873");
      await discoverPackages("@x");
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall?.[0]).toMatch(/^http:\/\/localhost:4873\//);
    });

    it("should reject a malformed URL", async () => {
      vi.stubEnv("NPM_TRUST_CLI_REGISTRY", "not a url");
      await expect(discoverPackages("@x")).rejects.toThrow(/Invalid NPM_TRUST_CLI_REGISTRY/);
    });

    it("should reject http:// for non-localhost hosts", async () => {
      vi.stubEnv("NPM_TRUST_CLI_REGISTRY", "http://evil.example.com");
      await expect(discoverPackages("@x")).rejects.toThrow(
        /require https:\/\/, or http:\/\/ for localhost/,
      );
    });

    it("should reject non-http(s) protocols", async () => {
      vi.stubEnv("NPM_TRUST_CLI_REGISTRY", "ftp://registry.example.com");
      await expect(discoverPackages("@x")).rejects.toThrow(/Invalid NPM_TRUST_CLI_REGISTRY/);
    });
  });

  describe("when the registry response is malformed", () => {
    it("should reject a non-object body", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse("nope"));
      await expect(discoverPackages("@x")).rejects.toThrow(/not an object/);
    });

    it("should reject when objects is not an array", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: "x", total: 0 }));
      await expect(discoverPackages("@x")).rejects.toThrow(/missing 'objects' array/);
    });

    it("should reject a non-numeric total", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: [], total: "lots" }));
      await expect(discoverPackages("@x")).rejects.toThrow(/finite non-negative 'total'/);
    });

    it("should reject Infinity total", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: [], total: Infinity }));
      await expect(discoverPackages("@x")).rejects.toThrow(/finite non-negative 'total'/);
    });

    it("should reject a negative total", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: [], total: -1 }));
      await expect(discoverPackages("@x")).rejects.toThrow(/finite non-negative 'total'/);
    });

    it("should reject a non-object objects entry", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: ["bad"], total: 1 }));
      await expect(discoverPackages("@x")).rejects.toThrow(/'objects' entry is not an object/);
    });

    it("should reject an entry with a missing package", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: [{}], total: 1 }));
      await expect(discoverPackages("@x")).rejects.toThrow(/missing 'package'/);
    });

    it("should reject an entry whose package.name is not a string", async () => {
      fetchMock.mockResolvedValueOnce(
        fakeResponse({ objects: [{ package: { name: 42 } }], total: 1 }),
      );
      await expect(discoverPackages("@x")).rejects.toThrow(/missing string 'package.name'/);
    });

    it("should reject an entry whose package is not an object", async () => {
      fetchMock.mockResolvedValueOnce(fakeResponse({ objects: [{ package: "x" }], total: 1 }));
      await expect(discoverPackages("@x")).rejects.toThrow(/missing 'package'/);
    });
  });

  describe("when pagination would exceed MAX_RESULTS", () => {
    it("should stop after the 10000-result cap", async () => {
      const fullPage = Array.from({ length: 250 }, (_, i) => ({
        package: { name: `@x/p${String(i).padStart(5, "0")}` },
      }));
      for (let i = 0; i < 40; i += 1) {
        fetchMock.mockResolvedValueOnce(pageResponse({ objects: fullPage, total: 1_000_000 }));
      }
      const result = await discoverPackages("@x");
      expect(result.length).toBe(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(40);
    });
  });
});
