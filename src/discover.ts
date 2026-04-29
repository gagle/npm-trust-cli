const PAGE_SIZE = 250;
const MAX_RESULTS = 10_000;
const FETCH_TIMEOUT_MS = 15_000;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1"]);

interface SearchResult {
  readonly objects: ReadonlyArray<{ readonly package: { readonly name: string } }>;
  readonly total: number;
}

function resolveRegistry(): string {
  const raw = process.env.NPM_TRUST_CLI_REGISTRY ?? "https://registry.npmjs.org";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Invalid NPM_TRUST_CLI_REGISTRY: ${raw}`);
  }
  const isHttps = parsed.protocol === "https:";
  const isLocalHttp = parsed.protocol === "http:" && LOCAL_HOSTS.has(parsed.hostname);
  if (!isHttps && !isLocalHttp) {
    throw new Error(
      `Invalid NPM_TRUST_CLI_REGISTRY: ${raw} (require https://, or http:// for localhost)`,
    );
  }
  return raw.replace(/\/$/, "");
}

function parseSearchResponse(data: unknown): SearchResult {
  if (typeof data !== "object" || data === null) {
    throw new Error("Registry response is not an object");
  }
  const candidate = data as { objects?: unknown; total?: unknown };
  if (!Array.isArray(candidate.objects)) {
    throw new Error("Registry response missing 'objects' array");
  }
  if (
    typeof candidate.total !== "number" ||
    !Number.isFinite(candidate.total) ||
    candidate.total < 0
  ) {
    throw new Error("Registry response missing finite non-negative 'total'");
  }
  const objects: Array<{ package: { name: string } }> = [];
  for (const entry of candidate.objects) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Registry response 'objects' entry is not an object");
    }
    const pkg = (entry as { package?: unknown }).package;
    if (typeof pkg !== "object" || pkg === null) {
      throw new Error("Registry response entry missing 'package'");
    }
    const name = (pkg as { name?: unknown }).name;
    if (typeof name !== "string") {
      throw new Error("Registry response entry missing string 'package.name'");
    }
    objects.push({ package: { name } });
  }
  return { objects, total: candidate.total };
}

export async function discoverPackages(scope: string): Promise<Array<string>> {
  const scopeWithAt = scope.startsWith("@") ? scope : `@${scope}`;
  const registry = resolveRegistry();
  const packages: Array<string> = [];
  let from = 0;

  for (;;) {
    const url = `${registry}/-/v1/search?text=${encodeURIComponent(scopeWithAt)}&size=${PAGE_SIZE}&from=${from}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (!response.ok) {
      throw new Error(`Registry search failed: ${response.status} ${response.statusText}`);
    }

    const data = parseSearchResponse(await response.json());

    for (const entry of data.objects) {
      packages.push(entry.package.name);
    }

    if (
      packages.length >= data.total ||
      data.objects.length === 0 ||
      data.objects.length < PAGE_SIZE ||
      from + PAGE_SIZE >= MAX_RESULTS
    ) {
      break;
    }

    from += PAGE_SIZE;
  }

  return packages.sort();
}
