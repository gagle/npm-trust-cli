interface SearchResult {
  readonly objects: ReadonlyArray<{
    readonly package: {
      readonly name: string;
    };
  }>;
  readonly total: number;
}

export async function discoverPackages(scope: string): Promise<Array<string>> {
  const scopeWithAt = scope.startsWith("@") ? scope : `@${scope}`;
  const packages: Array<string> = [];
  let from = 0;
  const size = 250;

  for (;;) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(scopeWithAt)}&size=${size}&from=${from}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Registry search failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as SearchResult;

    for (const entry of data.objects) {
      packages.push(entry.package.name);
    }

    if (packages.length >= data.total || data.objects.length === 0) {
      break;
    }

    from += size;
  }

  return packages.sort();
}
