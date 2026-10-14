// Preload for `notes-to-tab.ts`: `node --import ./scripts/record-to-tab/register.mjs ...`.
import { register } from "node:module";

register("./resolve-hooks.mjs", import.meta.url);
