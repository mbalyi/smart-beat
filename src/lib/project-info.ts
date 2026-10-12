import { version } from "../../package.json";
import info from "./project-info.json";

/**
 * Smart Beat's public contact details and links. `project-info.json` is the single source:
 * `scripts/check-docs.mjs` fails `pnpm check` when a document or manifest uses another contact
 * address or repository URL.
 */
export const PROJECT = info;

export const CONTACT_MAILTO = `mailto:${PROJECT.email}`;

/** The project links the app opens (About dialog); each is allowed in the app's capability. */
export const PROJECT_LINKS = [PROJECT.repository, CONTACT_MAILTO];

/** The app version (package.json, the one canonical version; see docs/release.md). */
export const APP_VERSION = version;
