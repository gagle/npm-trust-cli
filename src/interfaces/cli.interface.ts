export interface CliOptions {
  readonly scope?: string;
  readonly packages?: ReadonlyArray<string>;
  readonly repo?: string;
  readonly workflow?: string;
  readonly list?: boolean;
  readonly dryRun?: boolean;
  readonly auto?: boolean;
  readonly onlyNew?: boolean;
  readonly initSkill?: boolean;
  readonly doctor?: boolean;
  readonly json?: boolean;
}

export type WorkspaceSource = "pnpm-workspace" | "npm-workspace" | "single-package";

export interface DiscoveredWorkspace {
  readonly source: WorkspaceSource;
  readonly packages: ReadonlyArray<string>;
}

export interface PackageStatus {
  readonly pkg: string;
  readonly trustConfigured: boolean;
  readonly published: boolean;
  readonly hasProvenance: boolean;
}

export type DoctorIssueSeverity = "warn" | "fail";

export type DoctorIssueCode =
  | "NODE_TOO_OLD"
  | "NPM_TOO_OLD"
  | "NPM_UNREACHABLE"
  | "AUTH_NOT_LOGGED_IN"
  | "AUTH_REGISTRY_UNUSUAL"
  | "WORKSPACE_NOT_DETECTED"
  | "WORKSPACE_EMPTY"
  | "REPO_NO_REMOTE"
  | "REPO_REMOTE_NOT_GITHUB"
  | "WORKFLOWS_NONE"
  | "WORKFLOWS_AMBIGUOUS"
  | "WORKFLOW_NOT_FOUND"
  | "PACKAGE_TRUST_DISCREPANCY"
  | "PACKAGE_NOT_PUBLISHED"
  | "REGISTRY_UNREACHABLE"
  | "DOCTOR_FLAG_IGNORED";

export interface DoctorIssue {
  readonly severity: DoctorIssueSeverity;
  readonly code: DoctorIssueCode;
  readonly message: string;
  readonly remedy?: string;
  readonly relatedField?: string;
}

export interface VersionCheck {
  readonly version: string | null;
  readonly required: string;
  readonly satisfies: boolean;
}

export type RepoHost = "github" | "other" | null;

export interface PackageDoctorEntry extends PackageStatus {
  readonly discrepancies: ReadonlyArray<string>;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly cli: {
    readonly version: string;
    readonly path: string;
  };
  readonly runtime: {
    readonly node: VersionCheck;
    readonly npm: VersionCheck;
    readonly platform: string;
  };
  readonly auth: {
    readonly loggedIn: boolean;
    readonly username: string | null;
    readonly registry: string;
  };
  readonly workspace: DiscoveredWorkspace | null;
  readonly repo: {
    readonly url: string | null;
    readonly inferredSlug: string | null;
    readonly host: RepoHost;
  };
  readonly workflows: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<PackageDoctorEntry>;
  readonly issues: ReadonlyArray<DoctorIssue>;
  readonly summary: {
    readonly ok: number;
    readonly warn: number;
    readonly fail: number;
  };
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
