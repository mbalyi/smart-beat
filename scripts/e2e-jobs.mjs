// The e2e jobs CI runs, one line each: "<group> <browser> <workers>". `pnpm test:e2e:queue` feeds
// them to xargs, which keeps three running and starts the next one as one ends. The workers are
// the ones the CI matrix gives the group (1 for a smoke theme, 2 for a feature group).
import { FEATURE_GROUPS, SMOKE_GROUPS } from "../e2e/groups.ts";

// Feature groups first: they are the long ones, so the short ones fill the gaps at the end.
const groups = [
  ...Object.keys(FEATURE_GROUPS).map((group) => [group, 2]),
  ...Object.keys(SMOKE_GROUPS).map((group) => [group, 1]),
];
for (const [group, workers] of groups) {
  for (const browser of ["chromium", "webkit"]) console.log(`${group} ${browser} ${workers}`);
}
