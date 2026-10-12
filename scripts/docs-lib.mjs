// Checks for the public documents: one contact address and repository URL everywhere
// (src/lib/project-info.json), and relative links in Markdown that point at real files.
// Pure functions, so they can be tested; scripts/check-docs.mjs runs them on the repository.

import path from "node:path";

// Personal mailbox domains: an address on one of these that is not the project's own address is
// either stale (an old address the project does not own) or private.
const MAILBOX_DOMAINS = ["outlook.com", "hotmail.com", "gmail.com", "live.com", "icloud.com"];

/**
 * Lines of `text` that name a mailbox address other than `email`, or a smart-beat repository
 * under another owner than the one in `repository`.
 */
export function findStaleContacts(text, { email, repository }) {
  const owner = new URL(repository).pathname.split("/")[1];
  const problems = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[a-z]{2,})/g)) {
      const domain = match[1].toLowerCase();
      if (MAILBOX_DOMAINS.includes(domain) && match[0].toLowerCase() !== email.toLowerCase()) {
        problems.push({ line: index + 1, found: match[0], expected: email });
      }
    }
    for (const match of line.matchAll(/github\.com\/([A-Za-z0-9-]+)\/smart-beat\b/g)) {
      if (match[1] !== owner)
        problems.push({ line: index + 1, found: match[0], expected: repository });
    }
  });
  return problems;
}

/** Relative link targets in a Markdown file: `[text](target)`, `href="target"` and `src="target"`. */
export function relativeLinks(markdown) {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets = [
    ...withoutCode.matchAll(/\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g),
    ...withoutCode.matchAll(/\b(?:href|src)="([^"]+)"/g),
  ].map((match) => match[1] ?? match[2]);
  return [
    ...new Set(
      targets
        .filter((target) => !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith("#"))
        .map((target) => decodeURI(target.split("#")[0].split("?")[0]))
        .filter(Boolean),
    ),
  ];
}

/** Relative links in `file` (repository-relative) whose target is not in `exists`. */
export function findBrokenLinks(file, markdown, exists) {
  return relativeLinks(markdown)
    .map((target) => ({
      target,
      resolved: path.posix.normalize(
        target.startsWith("/")
          ? target.slice(1)
          : path.posix.join(path.posix.dirname(file), target),
      ),
    }))
    .filter(({ resolved }) => !exists(resolved.replace(/\/$/, "")));
}
