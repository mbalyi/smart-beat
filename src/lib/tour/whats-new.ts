import { FEATURE_REGISTRY, type FeatureEntry } from "@/lib/tour/feature-registry";

/** -1, 0 or 1; a missing or malformed part counts as 0. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** The features that came after `lastSeen`, up to and including the running version. */
export function pendingFeatures(
  lastSeen: string | null,
  current: string,
  registry: readonly FeatureEntry[] = FEATURE_REGISTRY,
): FeatureEntry[] {
  if (lastSeen === null) return [];
  return registry.filter(
    (f) => compareVersions(f.since, lastSeen) > 0 && compareVersions(f.since, current) <= 0,
  );
}

/** The newest release in the registry and its features, for Help › What's New. */
export function latestFeatures(registry: readonly FeatureEntry[] = FEATURE_REGISTRY): {
  version: string;
  features: FeatureEntry[];
} {
  let version = "0.0.0";
  for (const f of registry) if (compareVersions(f.since, version) > 0) version = f.since;
  return { version, features: registry.filter((f) => f.since === version) };
}
