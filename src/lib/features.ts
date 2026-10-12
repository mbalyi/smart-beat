import features from "./features.json";

/** Feature flags (src/lib/features.json). The native menu reads the same file. */
export type FeatureId = keyof typeof features;

export const isEnabled = (id: FeatureId): boolean => features[id];
