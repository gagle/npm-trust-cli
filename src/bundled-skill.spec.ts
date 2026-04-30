import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const SKILL_PATH = fileURLToPath(new URL("../skills/setup-npm-trust/SKILL.md", import.meta.url));

describe("bundled setup-npm-trust skill", () => {
  let content: string;

  beforeAll(() => {
    content = readFileSync(SKILL_PATH, "utf-8");
  });

  describe("frontmatter", () => {
    it("should start with the YAML delimiter", () => {
      expect(content.startsWith("---\n")).toBe(true);
    });

    it("should declare the skill name", () => {
      expect(content).toMatch(/^name:\s*setup-npm-trust$/m);
    });

    it("should include a non-empty description", () => {
      const match = content.match(/^description:\s*>\n((?:\s+.+\n)+)/m);
      expect(match?.[1]?.trim()).toBeTruthy();
    });
  });

  describe("structure", () => {
    it("should declare a Pre-flight section that resolves the CLI invocation", () => {
      expect(content).toContain("## Pre-flight — resolve the CLI invocation");
    });

    it("should declare a Phase 1 — Discover section", () => {
      expect(content).toContain("## Phase 1 — Discover");
    });

    it("should declare a Phase 2 — Execute section", () => {
      expect(content).toContain("## Phase 2 — Execute");
    });

    it("should describe when to use the skill", () => {
      expect(content).toContain("## When to use");
    });
  });

  describe("package-manager neutrality", () => {
    it("should use the <CLI> placeholder in commands so the host can resolve its own invocation", () => {
      expect(content).toContain("<CLI> --auto");
    });

    it("should mention `node ./bin/npm-trust-cli.js` as a source-checkout fallback", () => {
      expect(content).toContain("node ./bin/npm-trust-cli.js");
    });

    it("should mention an npx fallback for registry fetch", () => {
      expect(content).toContain("npx -y npm-trust-cli@latest");
    });

    it("should not assume pnpm by hardcoding pnpm exec", () => {
      expect(content).not.toContain("pnpm exec npm-trust-cli");
    });
  });

  describe("safety", () => {
    it("should include a hard `npm whoami` gate before the configure step", () => {
      expect(content).toContain("npm whoami");
      expect(content).toContain("STOP");
    });

    it("should include a pre-flight dry-run before the actual configure call", () => {
      expect(content).toContain("Pre-flight dry-run");
    });

    it("should verify the resolved CLI version supports --auto", () => {
      expect(content).toContain("Verify the resolved version supports the flags");
    });
  });

  describe("doctor integration", () => {
    it("should describe the --doctor --json fast path for v0.4.0+ CLIs", () => {
      expect(content).toContain("<CLI> --doctor --json");
    });

    it("should advertise backward compatibility with v0.2.0 and v0.3.0 CLIs", () => {
      expect(content).toContain("v0.2.0");
      expect(content).toContain("v0.3.0");
    });
  });
});
