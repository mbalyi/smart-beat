import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map());
vi.mock("node:fs", () => {
  const api = {
    existsSync: (file) => files.has(file),
    mkdirSync: vi.fn(),
    mkdtempSync: (prefix) => `${prefix}test`,
    readFileSync: (file) => {
      if (!files.has(file)) throw new Error(`Missing file: ${file}`);
      return files.get(file);
    },
    writeFileSync: (file, contents) => files.set(file, contents),
    copyFileSync: (source, destination) => files.set(destination, files.get(source)),
    rmSync: vi.fn(),
  };
  return { ...api, default: api };
});
vi.mock("node:child_process", () => {
  const api = {
    execFileSync: (command, args, options) => {
      if (command === "rustc") return "host: aarch64-apple-darwin\n";
      if (command === "cargo") {
        const target = args[args.indexOf("--target") + 1];
        const suffix = process.platform === "win32" ? ".exe" : "";
        files.set(
          path.join(
            options.cwd,
            "src-tauri",
            "target",
            target,
            "release",
            `vst3-host-helper${suffix}`,
          ),
          Buffer.from(target),
        );
      } else if (command === "lipo") {
        files.set(args[2], Buffer.concat(args.slice(3).map((file) => files.get(file))));
      } else if (command === "codesign") {
        // Helper signing is verified independently in sign-plugin-helper.test.mjs.
      } else {
        throw new Error(`Unexpected command: ${command}`);
      }
    },
  };
  return { ...api, default: api };
});

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  vi.stubEnv("APPLE_SIGNING_IDENTITY", "");
  vi.stubEnv("APPLE_CERTIFICATE", "");
  files.clear();
  vi.resetModules();
});

it("stages a universal helper for both externalBin and Cargo's additional binary", async () => {
  vi.stubEnv("TAURI_ENV_TARGET_TRIPLE", "universal-apple-darwin");
  await import("./stage-plugin-helper.mjs");
  const root = path.resolve(import.meta.dirname, "..");
  const suffix = process.platform === "win32" ? ".exe" : "";
  const sidecar = files.get(
    path.join(
      root,
      "src-tauri",
      "binaries",
      `smart-beat-plugin-helper-universal-apple-darwin${suffix}`,
    ),
  );
  const cargoBinary = files.get(
    path.join(
      root,
      "src-tauri",
      "target",
      "universal-apple-darwin",
      "release",
      `vst3-host-helper${suffix}`,
    ),
  );
  expect(sidecar?.toString()).toBe("aarch64-apple-darwinx86_64-apple-darwin");
  expect(cargoBinary).toEqual(sidecar);
  expect(files.get(path.join(root, "src-tauri/binaries/smart-beat-plugin-helper-macos"))).toEqual(
    sidecar,
  );
});
