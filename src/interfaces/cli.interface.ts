export interface CliOptions {
  readonly scope?: string;
  readonly packages?: ReadonlyArray<string>;
  readonly repo?: string;
  readonly workflow?: string;
  readonly list?: boolean;
  readonly dryRun?: boolean;
}

export type TrustResult =
  | "configured"
  | "already"
  | "not_published"
  | "auth_failed"
  | "error";

export interface TrustSummary {
  readonly configured: number;
  readonly already: number;
  readonly failed: number;
  readonly failedPackages: ReadonlyArray<string>;
}
