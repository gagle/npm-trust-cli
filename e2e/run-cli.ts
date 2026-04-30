import { execa, type Options as ExecaOptions } from "execa";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI_ENTRY = join(ROOT, "bin", "npm-trust-cli.js");
const FAKE_NPM = join(ROOT, "e2e", "fixtures", "fake-npm", "npm");

export interface FakeNpmResponse {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface FakeNpmScript {
  readonly responses: ReadonlyArray<FakeNpmResponse>;
  readonly default?: FakeNpmResponse;
}

export interface RunCliOptions {
  readonly args: ReadonlyArray<string>;
  readonly fakeNpm?: FakeNpmScript;
  readonly env?: Record<string, string>;
  readonly registryUrl?: string;
  readonly workspaceFiles?: Readonly<Record<string, string>>;
}

export interface RunCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly fakeNpmCalls: ReadonlyArray<ReadonlyArray<string>>;
}

export async function runCli(options: RunCliOptions): Promise<RunCliResult> {
  const tmp = mkdtempSync(join(tmpdir(), "npm-trust-cli-e2e-"));
  try {
    const scriptPath = join(tmp, "script.json");
    const logPath = join(tmp, "log.jsonl");
    const counterPath = join(tmp, "counter");

    writeFileSync(scriptPath, JSON.stringify(options.fakeNpm ?? { responses: [] }));
    writeFileSync(logPath, "");
    writeFileSync(counterPath, "0");

    let workspaceCwd: string | null = null;
    if (options.workspaceFiles) {
      workspaceCwd = join(tmp, "workspace");
      mkdirSync(workspaceCwd, { recursive: true });
      for (const [relativePath, content] of Object.entries(options.workspaceFiles)) {
        const fullPath = join(workspaceCwd, relativePath);
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, content);
      }
    }

    const env: ExecaOptions["env"] = {
      ...process.env,
      NPM_TRUST_CLI_NPM: FAKE_NPM,
      FAKE_NPM_SCRIPT: scriptPath,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_COUNTER: counterPath,
      ...(options.registryUrl ? { NPM_TRUST_CLI_REGISTRY: options.registryUrl } : {}),
      ...options.env,
    };

    const result = await execa("node", [CLI_ENTRY, ...options.args], {
      cwd: workspaceCwd ?? undefined,
      env,
      reject: false,
      all: false,
    });

    const logContent = readFileSync(logPath, "utf-8").trim();
    const allCalls: ReadonlyArray<ReadonlyArray<string>> = logContent
      ? logContent
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as ReadonlyArray<string>)
      : [];
    const fakeNpmCalls = allCalls.filter((call) => call[0] !== "--version");

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.exitCode ?? 0,
      fakeNpmCalls,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
