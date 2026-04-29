import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { runCli } from "./run-cli.js";

interface RegistryHandler {
  (text: string): { objects: ReadonlyArray<{ package: { name: string } }>; total: number };
}

let server: Server;
let baseUrl: string;
let handler: RegistryHandler = () => ({ objects: [], total: 0 });

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
  const address = server.address() as AddressInfo;
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
  it("when --help is passed it prints usage and exits 0", async () => {
    const result = await runCli({ args: ["--help"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("npm-trust-cli");
    expect(result.stdout).toContain("--scope");
    expect(result.stdout).toContain("--otp");
  });

  it("when no scope and no packages are given it exits 1", async () => {
    const result = await runCli({ args: [] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--scope or --packages");
  });

  it("when --packages without --repo is given it exits 1", async () => {
    const result = await runCli({ args: ["--packages", "@x/a"] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--repo");
  });

  it("when --packages with --repo but no --workflow is given it exits 1", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--workflow");
  });

  it("when --scope discovers zero packages it exits 1", async () => {
    mockRegistry("@empty", []);
    const result = await runCli({
      args: ["--scope", "@empty", "--list"],
      registryUrl: baseUrl,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("No packages found");
  });

  it("when --packages with --dry-run is given it exits 0 and never invokes npm", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "@x/b", "--repo", "o/r", "--workflow", "w.yml", "--dry-run"],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("(dry run)");
    expect(result.fakeNpmCalls).toHaveLength(0);
  });

  it("when --packages configures a single package successfully it exits 0", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
      fakeNpm: {
        responses: [{ exitCode: 0, stdout: "ok\n" }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.fakeNpmCalls).toHaveLength(1);
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

  it("when --otp is passed it is routed via env (not argv) so it never leaks via process listing", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml", "--otp", "654321"],
      fakeNpm: { responses: [{ exitCode: 0 }] },
    });
    expect(result.exitCode).toBe(0);
    const argv = result.fakeNpmCalls[0] ?? [];
    expect(argv.some((a) => a.includes("654321"))).toBe(false);
    expect(argv.some((a) => a.startsWith("--otp"))).toBe(false);
  });

  it("when 2FA is required without --otp in non-TTY (CI) it exits 1 with auth_failed", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "@x/b", "--repo", "o/r", "--workflow", "w.yml"],
      fakeNpm: {
        responses: [{ exitCode: 1, stderr: "EOTP one-time password required" }],
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("authentication failed");
    expect(result.fakeNpmCalls).toHaveLength(1);
  });

  it("when --scope discovers packages and configures all it exits 0", async () => {
    mockRegistry("@x", ["@x/a", "@x/b"]);
    const result = await runCli({
      args: ["--scope", "@x", "--repo", "o/r", "--workflow", "w.yml"],
      registryUrl: baseUrl,
      fakeNpm: {
        responses: [{ exitCode: 0 }, { exitCode: 0 }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.fakeNpmCalls).toHaveLength(2);
    expect(result.stdout).toContain("Found 2 packages");
  });

  it("when --list is used it queries trust per package and exits 0", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--list"],
      fakeNpm: {
        responses: [{ exitCode: 0, stdout: "github:o/r release.yml" }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.fakeNpmCalls[0]).toEqual(["trust", "list", "@x/a"]);
    expect(result.stdout).toContain("github:o/r");
  });

  it("when 409 is returned for one package it counts as already configured", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
      fakeNpm: {
        responses: [{ exitCode: 1, stderr: "npm error 409 Conflict" }],
      },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already configured");
  });

  it("when one package is unpublished (404) it is reported and exits 1", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml"],
      fakeNpm: {
        responses: [{ exitCode: 1, stderr: "npm error 404 Not Found" }],
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not published yet");
  });

  it("when a package name contains shell metacharacters it is passed verbatim with no expansion", async () => {
    const hostilePackage = "@x/a$(echo PWNED)`echo HACKED`;rm -rf /";
    const result = await runCli({
      args: ["--packages", hostilePackage, "--repo", "o/r", "--workflow", "w.yml"],
      fakeNpm: { responses: [{ exitCode: 0 }] },
    });
    expect(result.exitCode).toBe(0);
    expect(result.fakeNpmCalls[0]).toContain(hostilePackage);
    expect(result.fakeNpmCalls[0]).not.toContain("@x/aPWNED");
    expect(result.fakeNpmCalls[0]).not.toContain("@x/aHACKED");
  });

  it("when --otp has a non-numeric value it exits 1 with a validation error", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "w.yml", "--otp", "abc123"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--otp must be a 6-8 digit numeric code");
  });

  it("when --repo has shell metacharacters it exits 1 with a validation error", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r$(touch /tmp/pwned)", "--workflow", "w.yml"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--repo must match");
  });

  it("when --workflow is not a yml/yaml filename it exits 1 with a validation error", async () => {
    const result = await runCli({
      args: ["--packages", "@x/a", "--repo", "o/r", "--workflow", "release.sh"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--workflow must be");
  });

  it("when an unknown flag is passed it exits 1 with a strict-args error", async () => {
    const result = await runCli({ args: ["--unknown-flag"] });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toLowerCase()).toContain("unknown");
  });

  it("when npm is missing/old it exits 1 with the npm-version message", async () => {
    const result = await runCli({
      args: ["--help"],
      env: { FAKE_NPM_VERSION: "10.0.0" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("npm >= 11");
  });
});
