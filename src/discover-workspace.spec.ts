import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverFromCwd, parsePnpmWorkspacePackages } from "./discover-workspace.js";

interface PackageFiles {
  readonly [relativePath: string]: string;
}

function writeFiles(root: string, files: PackageFiles): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function pkgJson(name: string, options: { private?: boolean } = {}): string {
  const payload: { name: string; private?: boolean } = { name };
  if (options.private !== undefined) {
    payload.private = options.private;
  }
  return JSON.stringify(payload);
}

describe("parsePnpmWorkspacePackages", () => {
  describe("when the file is empty", () => {
    it("should return an empty list", () => {
      expect(parsePnpmWorkspacePackages("")).toStrictEqual([]);
    });
  });

  describe("when there is no packages key", () => {
    it("should return an empty list", () => {
      expect(parsePnpmWorkspacePackages("other:\n  - foo\n")).toStrictEqual([]);
    });
  });

  describe("when the packages block has plain entries", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      result = parsePnpmWorkspacePackages("packages:\n  - packages/*\n  - apps/*\n");
    });

    it("should return both globs in order", () => {
      expect(result).toStrictEqual(["packages/*", "apps/*"]);
    });
  });

  describe("when entries are quoted", () => {
    it("should strip single quotes", () => {
      expect(parsePnpmWorkspacePackages("packages:\n  - 'packages/*'\n")).toStrictEqual([
        "packages/*",
      ]);
    });

    it("should strip double quotes", () => {
      expect(parsePnpmWorkspacePackages('packages:\n  - "packages/*"\n')).toStrictEqual([
        "packages/*",
      ]);
    });
  });

  describe("when the block contains comments and blank lines", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      result = parsePnpmWorkspacePackages(
        "packages:\n  - packages/* # main\n\n  # standalone comment\n  - apps/*\n",
      );
    });

    it("should ignore comments and blanks while keeping real entries", () => {
      expect(result).toStrictEqual(["packages/*", "apps/*"]);
    });
  });

  describe("when a sibling root key follows the packages block", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      result = parsePnpmWorkspacePackages(
        "packages:\n  - packages/*\nonlyBuiltDependencies:\n  - esbuild\n",
      );
    });

    it("should stop at the sibling root key", () => {
      expect(result).toStrictEqual(["packages/*"]);
    });
  });

  describe("when the block dedents below the established indent", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      result = parsePnpmWorkspacePackages("packages:\n    - packages/*\n  - dropped-by-dedent\n");
    });

    it("should stop at the dedented line", () => {
      expect(result).toStrictEqual(["packages/*"]);
    });
  });

  describe("when entries use tab indentation", () => {
    it("should treat tabs as indented", () => {
      expect(parsePnpmWorkspacePackages("packages:\n\t- packages/*\n")).toStrictEqual([
        "packages/*",
      ]);
    });
  });

  describe("when an entry has only quotes", () => {
    it("should drop empty values after stripping quotes", () => {
      expect(parsePnpmWorkspacePackages("packages:\n  - ''\n  - apps/*\n")).toStrictEqual([
        "apps/*",
      ]);
    });
  });

  describe("when a line in the block is not a list item", () => {
    let result: ReadonlyArray<string>;

    beforeEach(() => {
      result = parsePnpmWorkspacePackages("packages:\n  scalar-noise\n  - packages/*\n");
    });

    it("should skip the non-list line and keep collecting list items", () => {
      expect(result).toStrictEqual(["packages/*"]);
    });
  });

  describe("when an entry is wrapped in mismatched short quotes", () => {
    it("should leave the value unchanged", () => {
      expect(parsePnpmWorkspacePackages("packages:\n  - x\n")).toStrictEqual(["x"]);
    });
  });

  describe("when packages uses YAML flow form on a single line", () => {
    it("should parse single-quoted entries", () => {
      expect(parsePnpmWorkspacePackages("packages: ['packages/*', 'apps/*']\n")).toStrictEqual([
        "packages/*",
        "apps/*",
      ]);
    });

    it("should parse double-quoted entries", () => {
      expect(parsePnpmWorkspacePackages('packages: ["a", "b"]\n')).toStrictEqual(["a", "b"]);
    });

    it("should parse unquoted entries", () => {
      expect(parsePnpmWorkspacePackages("packages: [a, b]\n")).toStrictEqual(["a", "b"]);
    });

    it("should drop empty entries from the flow array", () => {
      expect(parsePnpmWorkspacePackages("packages: ['a', '', 'b']\n")).toStrictEqual(["a", "b"]);
    });
  });

  describe("when packages uses an unterminated flow form", () => {
    it("should return an empty list rather than parsing partially", () => {
      expect(parsePnpmWorkspacePackages("packages: ['a', 'b'\n")).toStrictEqual([]);
    });
  });
});

describe("discoverFromCwd", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "discover-workspace-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("when nothing identifying a workspace or package is present", () => {
    it("should return null", async () => {
      const result = await discoverFromCwd(tmpDir);
      expect(result).toBeNull();
    });
  });

  describe("when pnpm-workspace.yaml lists package globs", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
        "packages/foo/package.json": pkgJson("@org/foo"),
        "packages/bar/package.json": pkgJson("@org/bar"),
        "apps/web/package.json": pkgJson("@org/web"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should report the pnpm-workspace source", () => {
      expect(result?.source).toBe("pnpm-workspace");
    });

    it("should return all discovered package names sorted", () => {
      expect(result?.packages).toStrictEqual(["@org/bar", "@org/foo", "@org/web"]);
    });
  });

  describe("when pnpm-workspace.yaml contains a literal negation path", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - '!packages/excluded'\n",
        "packages/keeper/package.json": pkgJson("@org/keeper"),
        "packages/excluded/package.json": pkgJson("@org/excluded"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should drop the negated path from the result", () => {
      expect(result?.packages).toStrictEqual(["@org/keeper"]);
    });
  });

  describe("when a workspace match has no package.json", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/empty/.gitkeep": "",
        "packages/real/package.json": pkgJson("@org/real"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should silently skip directories without a package.json", () => {
      expect(result?.packages).toStrictEqual(["@org/real"]);
    });
  });

  describe("when a matched package.json is malformed JSON", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/bad/package.json": "{ not valid",
        "packages/good/package.json": pkgJson("@org/good"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should silently skip the malformed package", () => {
      expect(result?.packages).toStrictEqual(["@org/good"]);
    });
  });

  describe("when a matched package.json is private", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/private-one/package.json": pkgJson("@org/private-one", { private: true }),
        "packages/public-one/package.json": pkgJson("@org/public-one"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should skip the private package", () => {
      expect(result?.packages).toStrictEqual(["@org/public-one"]);
    });
  });

  describe("when a matched package.json has no name", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/nameless/package.json": JSON.stringify({}),
        "packages/named/package.json": pkgJson("@org/named"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should skip the unnamed package", () => {
      expect(result?.packages).toStrictEqual(["@org/named"]);
    });
  });

  describe("when a matched package.json parses to a non-object value", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
        "packages/scalar/package.json": "42",
        "packages/named/package.json": pkgJson("@org/named"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should skip the non-object package", () => {
      expect(result?.packages).toStrictEqual(["@org/named"]);
    });
  });

  describe("when the same package name appears under two patterns", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - packages/*\n  - apps/*\n",
        "packages/dup/package.json": pkgJson("@org/dup"),
        "apps/dup/package.json": pkgJson("@org/dup"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should deduplicate the name", () => {
      expect(result?.packages).toStrictEqual(["@org/dup"]);
    });
  });

  describe("when package.json declares workspaces as an array", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        }),
        "packages/alpha/package.json": pkgJson("@org/alpha"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should report the npm-workspace source", () => {
      expect(result?.source).toBe("npm-workspace");
    });

    it("should return the discovered package names", () => {
      expect(result?.packages).toStrictEqual(["@org/alpha"]);
    });
  });

  describe("when package.json declares workspaces as an object", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({
          name: "root",
          private: true,
          workspaces: { packages: ["packages/*"] },
        }),
        "packages/alpha/package.json": pkgJson("@org/alpha"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should report the npm-workspace source", () => {
      expect(result?.source).toBe("npm-workspace");
    });
  });

  describe("when package.json declares workspaces as an object without packages", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({
          name: "root",
          workspaces: { nohmagic: true },
        }),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should fall back to single-package mode using the root name", () => {
      expect(result).toStrictEqual({ source: "single-package", packages: ["root"] });
    });
  });

  describe("when package.json declares workspaces.packages as a non-array value", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({
          name: "root",
          workspaces: { packages: 42 },
        }),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should fall back to single-package mode using the root name", () => {
      expect(result).toStrictEqual({ source: "single-package", packages: ["root"] });
    });
  });

  describe("when workspaces entries are mixed strings and other types", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*", 42, null, "", "   "],
        }),
        "packages/alpha/package.json": pkgJson("@org/alpha"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should drop non-string and blank entries", () => {
      expect(result?.packages).toStrictEqual(["@org/alpha"]);
    });
  });

  describe("when package.json has a name and is not private and has no workspaces", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": pkgJson("solo-pkg"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should report the single-package source", () => {
      expect(result?.source).toBe("single-package");
    });

    it("should return the root package name", () => {
      expect(result?.packages).toStrictEqual(["solo-pkg"]);
    });
  });

  describe("when the root package.json is private and has no workspaces", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": pkgJson("workspace-root", { private: true }),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should return null", () => {
      expect(result).toBeNull();
    });
  });

  describe("when the root package.json has no name", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": JSON.stringify({}),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should return null", () => {
      expect(result).toBeNull();
    });
  });

  describe("when the root package.json is malformed JSON", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": "{ broken",
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should return null", () => {
      expect(result).toBeNull();
    });
  });

  describe("when the root package.json parses to a non-object value", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "package.json": "true",
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should return null", () => {
      expect(result).toBeNull();
    });
  });

  describe("when pnpm-workspace.yaml has empty patterns", () => {
    let result: Awaited<ReturnType<typeof discoverFromCwd>>;

    beforeEach(async () => {
      writeFiles(tmpDir, {
        "pnpm-workspace.yaml": "packages:\n  - ''\n  - packages/*\n",
        "packages/foo/package.json": pkgJson("@org/foo"),
      });
      result = await discoverFromCwd(tmpDir);
    });

    it("should skip empty patterns", () => {
      expect(result?.packages).toStrictEqual(["@org/foo"]);
    });
  });
});
