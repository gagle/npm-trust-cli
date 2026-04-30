export { checkPackageStatuses, findUnconfiguredPackages } from "./diff.js";
export { discoverPackages } from "./discover.js";
export { discoverFromCwd, parsePnpmWorkspacePackages } from "./discover-workspace.js";
export { configureTrust, listTrust } from "./trust.js";
export { runCli } from "./cli.js";
export type {
  ConfigureTrustOptions,
  DiscoveredWorkspace,
  ListTrustOptions,
  Logger,
  PackageStatus,
  RuntimeLogger,
  TrustResult,
  TrustSummary,
  WorkspaceSource,
} from "./interfaces/cli.interface.js";
