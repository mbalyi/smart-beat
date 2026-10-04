import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { accentedNamesGp5, drumLinesGp5 } from "@/test/legacy-fixtures";

const FIXTURES = path.join(import.meta.dirname, "../../e2e/fixtures");

/**
 * The committed GP5 fixtures are what the generators write. Run with
 * `UPDATE_FIXTURES=1 pnpm vitest run src/test/legacy-fixtures.test.ts` after
 * changing a generator or the GP5 writer.
 */
describe.each([
  ["accented-names.gp5", accentedNamesGp5],
  ["drum-lines.gp5", drumLinesGp5],
])("fixture %s", (name, generate) => {
  it("is up to date", () => {
    const file = path.join(FIXTURES, name);
    const bytes = generate();
    if (process.env.UPDATE_FIXTURES || !existsSync(file)) writeFileSync(file, bytes);
    expect(new Uint8Array(readFileSync(file))).toEqual(bytes);
  });
});
