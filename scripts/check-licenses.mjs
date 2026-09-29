#!/usr/bin/env node
// Fails if a shipped npm package uses a license outside the policy in
// scripts/license-policy.mjs (e.g. GPL, AGPL, LGPL, SSPL, non-commercial).
// Rust crates are checked by `cargo deny check licenses` (deny.toml).

import { EMBEDDED_BUILD_PACKAGES, isAllowed, REVIEWED_PACKAGES } from "./license-policy.mjs";
import { listProductionPackages, readInstalledPackage } from "./npm-packages.mjs";

const packages = [
  ...listProductionPackages(),
  ...EMBEDDED_BUILD_PACKAGES.map(readInstalledPackage),
];

const violations = packages.filter((pkg) => {
  const license = REVIEWED_PACKAGES.get(pkg.name) ?? pkg.license;
  return !isAllowed(license);
});

if (violations.length > 0) {
  console.error("License policy violations (see docs/licensing.md):\n");
  for (const pkg of violations) {
    console.error(`  ✗ ${pkg.name}@${pkg.versions.join(", ")}: ${pkg.license ?? "UNKNOWN"}`);
  }
  console.error(
    "\nReplace the package, or if its license is actually compatible, review it and add it to REVIEWED_PACKAGES in scripts/license-policy.mjs.",
  );
  process.exit(1);
}

console.log(`✓ ${packages.length} shipped npm packages comply with the license policy.`);
