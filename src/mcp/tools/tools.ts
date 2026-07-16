import type { ToolDefinition } from "./ToolDefinition.js";
import {
  pageNavigate,
  pageList,
  pageNew,
  pageSelect,
  pageClose,
  pageBack,
  pageForward,
  pageReload,
} from "./pages.js";
import { sessionList, sessionNew, sessionClose, sessionAttach } from "./session.js";
import { screenshotTake } from "./screenshot.js";
import { consoleList, consoleGet } from "./console.js";
import { networkList, networkGet } from "./network.js";
import { snapshotTake, snapshotDiff } from "./snapshot.js";
import { click, hover, typeText, fillForm, key, scroll, drag } from "./input.js";
import {
  cookiesList,
  cookiesSet,
  cookiesClear,
  localStorageGet,
  localStorageSet,
  localStorageRemove,
  localStorageClear,
  localStorageList,
  sessionStorageGet,
  sessionStorageSet,
  sessionStorageRemove,
  sessionStorageClear,
  sessionStorageList,
  indexeddbListDatabases,
  indexeddbQuery,
  indexeddbClear,
} from "./storage.js";
import { interceptAdd, interceptList, interceptRemove } from "./intercept.js";
import { emulateViewport, emulateUserAgent, emulateNetwork, emulateGeolocation } from "./emulate.js";
import { performanceMetrics } from "./performance.js";
import { consoleSearch, networkSearch } from "./search.js";
import { daemonStatus } from "./daemon.js";
import { fontsList } from "./fonts.js";
import { scriptEvaluate } from "./script.js";
import { waitFor, networkWaitFor, uploadFile } from "./wait.js";
import { gatewayTools } from "./gateway.js";

export const allTools: ToolDefinition<any>[] = [
  sessionList,
  sessionNew,
  sessionClose,
  sessionAttach,
  pageNavigate,
  pageList,
  pageNew,
  pageSelect,
  pageClose,
  pageBack,
  pageForward,
  pageReload,
  screenshotTake,
  snapshotTake,
  snapshotDiff,
  consoleList,
  consoleGet,
  networkList,
  networkGet,
  click,
  hover,
  typeText,
  fillForm,
  key,
  scroll,
  drag,
  cookiesList,
  cookiesSet,
  cookiesClear,
  localStorageGet,
  localStorageSet,
  localStorageRemove,
  localStorageClear,
  localStorageList,
  sessionStorageGet,
  sessionStorageSet,
  sessionStorageRemove,
  sessionStorageClear,
  sessionStorageList,
  indexeddbListDatabases,
  indexeddbQuery,
  indexeddbClear,
  interceptAdd,
  interceptList,
  interceptRemove,
  emulateViewport,
  emulateUserAgent,
  emulateNetwork,
  emulateGeolocation,
  performanceMetrics,
  consoleSearch,
  networkSearch,
  daemonStatus,
  fontsList,
  scriptEvaluate,
  waitFor,
  networkWaitFor,
  uploadFile,
];

// Tools resolvable by name when handling a `tools/call`. Includes the gateway
// tools so they work when advertised, and keeps the real 56 callable by name
// even if a mode hides them from `tools/list` (slim/gateway are additive, not
// restrictive — advanced clients and `tools_invoke` can still reach any tool).
const resolvableTools: ToolDefinition<any>[] = [...allTools, ...gatewayTools];

export function getTool(name: string): ToolDefinition<any> | undefined {
  return resolvableTools.find((t) => t.name === name);
}

/** How many tools `tools/list` advertises at mount. */
export type ToolMode = "full" | "slim" | "gateway";

/**
 * Slim mode (`--slim`): minimal tool surface for low-token contexts. Five core
 * tools cover navigation + perception + interaction; everything else is hidden.
 */
const SLIM_TOOL_NAMES = new Set([
  "page_navigate",
  "snapshot_take",
  "screenshot_take",
  "click",
  "script_evaluate",
]);

/**
 * Which tools to advertise in `tools/list`:
 * - "full"    → all 56 (default)
 * - "slim"    → 5 core tools
 * - "gateway" → 3 meta-tools (catalog/schema/invoke); the 56 stay callable by name
 */
export function selectTools(mode: ToolMode): ToolDefinition<any>[] {
  if (mode === "gateway") return gatewayTools;
  if (mode === "slim") return allTools.filter((t) => SLIM_TOOL_NAMES.has(t.name));
  return allTools;
}
