export interface CliOptions {
  readonly scope?: string;
  readonly packages?: ReadonlyArray<string>;
  readonly repo?: string;
  readonly workflow?: string;
  readonly list?: boolean;
  readonly dryRun?: boolean;
  readonly auto?: boolean;
}

export type WorkspaceSource = "pnpm-workspace" | "npm-workspace" | "single-package";

export interface DiscoveredWorkspace {
  readonly source: WorkspaceSource;
  readonly packages: ReadonlyArray<string>;
}

export type TrustResult = "configured" | "already" | "not_published" | "auth_failed" | "error";

export interface TrustSummary {
  readonly configured: number;
  readonly already: number;
  readonly failed: number;
  readonly failedPackages: ReadonlyArray<string>;
}

export interface ConfigureTrustOptions {
  readonly packages: ReadonlyArray<string>;
  readonly repo: string;
  readonly workflow: string;
  readonly dryRun?: boolean;
  readonly logger?: Logger;
}

export interface ListTrustOptions {
  readonly packages: ReadonlyArray<string>;
  readonly logger?: Logger;
}

export interface Logger {
  readonly log: (message: string) => void;
}

export interface RuntimeLogger extends Logger {
  readonly error: (message: string) => void;
}
