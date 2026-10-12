import { describe, expect, it } from "vitest";

import project from "../src/lib/project-info.json";
import { findBrokenLinks, findStaleContacts, relativeLinks } from "./docs-lib.mjs";

describe("findStaleContacts", () => {
  it("accepts the project's own address and repository", () => {
    expect(
      findStaleContacts(
        "Write to smart-beat@outlook.com or open https://github.com/mbalyi/smart-beat/issues.",
        project,
      ),
    ).toEqual([]);
  });

  it("flags the old, unowned address with its line", () => {
    expect(findStaleContacts("Intro\nWrite to **smartbeat@outlook.com**.", project)).toEqual([
      { line: 2, found: "smartbeat@outlook.com", expected: "smart-beat@outlook.com" },
    ]);
  });

  it("flags personal mailboxes but not third-party project addresses", () => {
    const text = "a@gmail.com\nsupport@alphatab.net\nnoreply@anthropic.com";
    expect(findStaleContacts(text, project).map((problem) => problem.found)).toEqual([
      "a@gmail.com",
    ]);
  });

  it("flags a fork's repository URL", () => {
    expect(findStaleContacts("https://github.com/someone/smart-beat", project)).toEqual([
      { line: 1, found: "github.com/someone/smart-beat", expected: project.repository },
    ]);
  });
});

describe("relativeLinks", () => {
  it("collects Markdown and HTML targets, without anchors, URLs or code", () => {
    const markdown = [
      "[a](docs/a.md#part) [b](<docs/b c.md>) [web](https://x.dev) [top](#top)",
      '<img src="src/assets/logo.png"> <a href="mailto:x@y.z">',
      "`[not](a-link.md)`",
      "```\n[nor](this.md)\n```",
    ].join("\n");
    expect(relativeLinks(markdown)).toEqual(["docs/a.md", "docs/b c.md", "src/assets/logo.png"]);
  });
});

describe("findBrokenLinks", () => {
  it("resolves targets relative to the file", () => {
    const exists = (target) => ["docs/licensing.md", "LICENSE"].includes(target);
    expect(
      findBrokenLinks(
        "docs/adr/0002.md",
        "[l](../licensing.md) [x](../../LICENSE) [gone](../plan.md)",
        exists,
      ),
    ).toEqual([{ target: "../plan.md", resolved: "docs/plan.md" }]);
  });
});
