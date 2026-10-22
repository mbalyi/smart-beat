import capability from "../../src-tauri/capabilities/default.json";
import catalogueSource from "../../src-tauri/src/audio/soundfonts.rs?raw";
import { ALPHATAB, CREDIT_URLS, OTHER_CREDITS } from "@/lib/credits";
import { PROJECT_LINKS } from "@/lib/project-info";

// The bank pages live in the Rust catalogue; read them from there so the two cannot drift apart.
const CATALOGUE_PAGES = [...catalogueSource.matchAll(/^\s*page: "([^"]+)",$/gm)].map(
  (match) => match[1]!,
);

describe("credits", () => {
  const opener = capability.permissions.find(
    (permission): permission is { identifier: string; allow: { url: string }[] } =>
      typeof permission === "object" && permission.identifier === "opener:allow-open-url",
  );

  it("puts alphaTab first and only links to https pages", () => {
    expect(CREDIT_URLS[0]).toBe(ALPHATAB.url);
    for (const url of CREDIT_URLS) expect(url).toMatch(/^https:\/\//);
  });

  it("has no duplicate or unnamed credits", () => {
    expect(new Set(CREDIT_URLS).size).toBe(CREDIT_URLS.length);
    for (const credit of OTHER_CREDITS) {
      expect(credit.name).not.toBe("");
      expect(credit.description.length).toBeGreaterThan(20);
    }
  });

  it("reads every recommended bank page from the catalogue", () => {
    expect(CATALOGUE_PAGES.length).toBeGreaterThanOrEqual(5);
    expect(new Set(CATALOGUE_PAGES).size).toBe(CATALOGUE_PAGES.length);
  });

  it("is exactly what the app is allowed to open: no link that does nothing, no extra address", () => {
    expect(opener).toBeDefined();
    expect(opener!.allow.map((entry) => entry.url).sort()).toEqual(
      [...CREDIT_URLS, ...PROJECT_LINKS, ...CATALOGUE_PAGES].sort(),
    );
  });
});
