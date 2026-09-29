import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");

/**
 * Production npm packages (direct + transitive) with their declared license,
 * as reported by `pnpm licenses list --prod --json`.
 */
export function listProductionPackages() {
  const output = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const byLicense = JSON.parse(output);

  return Object.entries(byLicense)
    .flatMap(([license, packages]) =>
      packages.map((pkg) => ({
        name: pkg.name,
        versions: pkg.versions ?? [pkg.version],
        paths: pkg.paths ?? [pkg.path],
        license: pkg.license ?? license,
        homepage: pkg.homepage,
      })),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Reads a package's metadata straight from node_modules (for dev dependencies). */
export function readInstalledPackage(name) {
  const dir = path.join(ROOT, "node_modules", name);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  const license = typeof manifest.license === "string" ? manifest.license : manifest.license?.type;
  return {
    name,
    versions: [manifest.version],
    paths: [dir],
    license,
    homepage: manifest.homepage,
  };
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i;

/** Contents of the LICENSE / COPYING / NOTICE files a package ships, if any. */
export function readLicenseFiles(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => LICENSE_FILE.test(file))
    .sort()
    .map((file) => readFileSync(path.join(dir, file), "utf8").trim());
}
