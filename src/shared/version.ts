import { readFileSync } from "node:fs";

// Single source of truth for the reported version = package.json.
// (Three hardcoded "1.4.0" strings drifted while the tag said 1.6.0.)
export const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();
