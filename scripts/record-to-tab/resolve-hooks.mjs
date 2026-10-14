// Module resolution for running the app's TypeScript in plain Node: maps the `@/` alias to
// `src/` and adds the `.ts` extension that the source leaves out. Loaded by `register.mjs`.
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

const isFile = (file) => existsSync(file) && statSync(file).isFile();

export async function resolve(specifier, context, next) {
  let target = null;
  if (specifier.startsWith("@/")) {
    target = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".") && context.parentURL?.startsWith(pathToFileURL(SRC).href)) {
    target = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  }
  if (target) {
    for (const candidate of [target, `${target}.ts`, path.join(target, "index.ts")]) {
      if (isFile(candidate)) return next(pathToFileURL(candidate).href, context);
    }
  }
  return next(specifier, context);
}
