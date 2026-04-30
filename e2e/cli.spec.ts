import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runCli, type RunCliResult } from "./run-cli.js";

interface RegistryHandler {
  (text: string): { objects: ReadonlyArray<{ package: { name: string } }>; total: number };
}

let server: Server;
let baseUrl: string;
let handler: RegistryHandler = () => ({ objects: [], total: 0 });

function getServerAddress(srv: Server): AddressInfo {
  const address = srv.address();
  if (!address || typeof address === "string") {
    throw new Error("server did not return an AddressInfo");
  }
  return address;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/-/v1/search") {
      const text = url.searchParams.get("text") ?? "";
      const body = handler(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = getServerAddress(server);
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  handler = () => ({ objects: [], total: 0 });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function mockRegistry(scope: string, names: ReadonlyArray<string>): void {
  handler = (text) => {
    if (!text.includes(scope)) {
      return { objects: [], total: 0 };
    }
    return {
      objects: names.map((name) => ({ package: { name } })),
      total: names.length,
    };
  };
}

describe("CLI e2e", () => {
  describe("when --help is passed", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({ args: ["--help"] });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should print the binary name in stdout", () => {
      expect(result.stdout).toContain("npm-trust-cli");
    });

    it("should print --scope in the help text", () => {
      expect(result.stdout).toContain("--scope");
    });

    it("should print --dry-run in the help text", () => {
      expect(result.stdout).toContain("--dry-run");
    });
  });

  describe("when no --auto, --scope, or --packages is given", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({ args: [] });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the requirement listing every entry mode", () => {
      expect(result.stderr).toContain("--auto, --scope, or --packages");
    });
  });

  describe("when --auto is used in a pnpm workspace fixture", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--auto", "--repo", "o/r", "--workflow", "w.yml", "--dry-run"],
        workspaceFiles: {
          "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
          "packages/foo/package.json": JSON.stringify({ name: "@org/foo" }),
          "packages/bar/package.json": JSON.stringify({ name: "@org/bar" }),
          "apps/web/package.json": JSON.stringify({ name: "@org/web" }),
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should label the detected source", () => {
      expect(result.stdout).toContain("Detected pnpm workspace");
    });

    it("should mention every discovered package in the dry-run output", () => {
      expect(result.stdout).toContain("@org/foo");
      expect(result.stdout).toContain("@org/bar");
      expect(result.stdout).toContain("@org/web");
    });
  });

  describe("when --auto is used in a single-package fixture", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--auto", "--repo", "o/r", "--workflow", "w.yml", "--dry-run"],
        workspaceFiles: {
          "package.json": JSON.stringify({ name: "solo-pkg" }),
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should label the detected source as single package", () => {
      expect(result.stdout).toContain("Detected single package");
    });

    it("should reference the single package name in the dry-run output", () => {
      expect(result.stdout).toContain("solo-pkg");
    });
  });

  describe("when --auto cannot detect any packages", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--auto"],
        workspaceFiles: {
          "README.md": "no workspace files here",
        },
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should hint at the files it looked for", () => {
      expect(result.stderr).toContain("pnpm-workspace.yaml");
    });
  });

  describe("when --packages is supplied without --repo", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({ args: ["--packages", "@x/a"] });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the --repo requirement", () => {
      expect(result.stderr).toContain("--repo");
    });
  });

  describe("when --packages is supplied with --repo but no --workflow", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({ args: ["--packages", "@x/a", "--repo", "o/r"] });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the --workflow requirement", () => {
      expect(result.stderr).toContain("--workflow");
    });
  });

  describe("when --scope discovers zero packages", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      mockRegistry("@empty", []);
      result = await runCli({
        args: ["--scope", "@empty", "--list"],
        registryUrl: baseUrl,
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print 'No packages found'", () => {
      expect(result.stderr).toContain("No packages found");
    });
  });

  describe("when --packages with --dry-run is given", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "@x/b", "--repo", "o/r", "--workflow", "w.yml", "--dry-run"],
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should print '(dry run)' in stdout", () => {
      expect(result.stdout).toContain("(dry run)");
    });

    it("should not invoke the npm binary", () => {
      expect(result.fakeNpmCalls).toHaveLength(0);
    });
  });

  describe("when --packages configures a single package successfully", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
        fakeNpm: {
          responses: [{ exitCode: 0, stdout: "ok\n" }],
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should invoke npm exactly once", () => {
      expect(result.fakeNpmCalls).toHaveLength(1);
    });

    it("should pass the trust github argv", () => {
      expect(result.fakeNpmCalls[0]).toEqual([
        "trust",
        "github",
        "@x/a",
        "--repo",
        "o/r",
        "--file",
        "w.yml",
        "--yes",
      ]);
    });
  });

  describe("when 2FA is required in non-TTY (CI)", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "@x/b", "--repo", "o/r", "--workflow", "w.yml"],
        fakeNpm: {
          responses: [{ exitCode: 1, stderr: "EOTP one-time password required" }],
        },
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print 'authentication failed'", () => {
      expect(result.stdout).toContain("authentication failed");
    });

    it("should short-circuit after the first failed package", () => {
      expect(result.fakeNpmCalls).toHaveLength(1);
    });
  });

  describe("when --scope discovers packages and configures all of them", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      mockRegistry("@x", ["@x/a", "@x/b"]);
      result = await runCli({
        args: ["--scope", "@x", "--repo", "o/r", "--workflow", "w.yml"],
        registryUrl: baseUrl,
        fakeNpm: {
          responses: [{ exitCode: 0 }, { exitCode: 0 }],
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should invoke npm once per package", () => {
      expect(result.fakeNpmCalls).toHaveLength(2);
    });

    it("should print the discovered count", () => {
      expect(result.stdout).toContain("Found 2 packages");
    });
  });

  describe("when --list is used", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--list"],
        fakeNpm: {
          responses: [{ exitCode: 0, stdout: "github:o/r release.yml" }],
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should call npm trust list per package", () => {
      expect(result.fakeNpmCalls[0]).toEqual(["trust", "list", "@x/a"]);
    });

    it("should print npm's output", () => {
      expect(result.stdout).toContain("github:o/r");
    });
  });

  describe("when 409 is returned for one package", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
        fakeNpm: {
          responses: [{ exitCode: 1, stderr: "npm error 409 Conflict" }],
        },
      });
    });

    it("should exit 0", () => {
      expect(result.exitCode).toBe(0);
    });

    it("should print 'already configured'", () => {
      expect(result.stdout).toContain("already configured");
    });
  });

  describe("when one package is unpublished (404)", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
        fakeNpm: {
          responses: [{ exitCode: 1, stderr: "npm error 404 Not Found" }],
        },
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print 'not published yet'", () => {
      expect(result.stdout).toContain("not published yet");
    });
  });

  describe("when a package name contains shell metacharacters", () => {
    const hostilePackage = "@x/a$(echo PWNED)`echo HACKED`;rm -rf /";
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", hostilePackage, "--repo", "o/r", "--workflow", "w.yml"],
        fakeNpm: { responses: [{ exitCode: 0 }] },
      });
    });

    it("should exit 1 (rejected by package-name validation)", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should not invoke npm at all", () => {
      expect(result.fakeNpmCalls).toHaveLength(0);
    });

    it("should print the invalid-package-name error", () => {
      expect(result.stderr).toContain("invalid package name");
    });
  });

  describe("when --repo has shell metacharacters", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--repo", "o/r$(touch /tmp/pwned)", "--workflow", "w.yml"],
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the --repo validation error", () => {
      expect(result.stderr).toContain("--repo must match");
    });
  });

  describe("when --workflow is not a yml/yaml filename", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "release.sh"],
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the --workflow validation error", () => {
      expect(result.stderr).toContain("--workflow must be");
    });
  });

  describe("when an unknown flag is passed", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({ args: ["--unknown-flag"] });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print a strict-args error mentioning 'unknown'", () => {
      expect(result.stderr.toLowerCase()).toContain("unknown");
    });
  });

  describe("when npm is missing or below 11", () => {
    let result: RunCliResult;

    beforeEach(async () => {
      result = await runCli({
        args: ["--help"],
        env: { FAKE_NPM_VERSION: "10.0.0" },
      });
    });

    it("should exit 1", () => {
      expect(result.exitCode).toBe(1);
    });

    it("should print the npm-version requirement", () => {
      expect(result.stderr).toContain("npm >= 11");
    });
  });
});
