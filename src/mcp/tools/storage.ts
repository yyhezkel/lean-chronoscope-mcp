import { z } from "zod";
import type {
  CookiesClearResult,
  CookiesListResult,
  CookiesSetResult,
  IndexedDbClearResult,
  IndexedDbListDatabasesResult,
  IndexedDbQueryResult,
  StorageClearResult,
  StorageGetResult,
  StorageKind,
  StorageListResult,
  StorageRemoveResult,
  StorageSetResult,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const SameSite = z.enum(["Strict", "Lax", "None"]);

const CookiesListInput = z.object({
  urls: z
    .array(z.string().url())
    .optional()
    .describe("Narrow to cookies the browser would send to these URLs. Omit for all session cookies."),
});

export const cookiesList = defineTool({
  name: "cookies_list",
  description:
    "List cookies in the session's browser context. With `urls`, returns only cookies that would be sent to those URLs (path/domain/secure aware).",
  category: "storage",
  inputSchema: CookiesListInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<CookiesListResult>("cookies.list", {
      sessionId: ctx.sessionId,
      urls: input.urls,
    });
    const body =
      r.cookies.length === 0
        ? "(no cookies)"
        : r.cookies.map(formatCookie).join("\n");
    return new McpResponse()
      .addSection("Cookies", body, { changeKey: `${ctx.sessionId}:cookies` })
      .setStructured({ count: r.cookies.length, cookies: r.cookies })
      .build();
  },
});

const CookiesSetInput = z.object({
  cookies: z
    .array(
      z.object({
        name: z.string().min(1),
        value: z.string(),
        url: z.string().url().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        expires: z.number().int().optional().describe("Epoch seconds; omit for session cookie"),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: SameSite.optional(),
      }),
    )
    .min(1)
    .describe("Each cookie must have either url or domain"),
});

export const cookiesSet = defineTool({
  name: "cookies_set",
  description: "Set one or more cookies in the session's browser context.",
  category: "storage",
  inputSchema: CookiesSetInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<CookiesSetResult>("cookies.set", {
      sessionId: ctx.sessionId,
      cookies: input.cookies,
    });
    return new McpResponse()
      .addSection("Result", `Set ${r.set} cookie${r.set === 1 ? "" : "s"}.`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const CookiesClearInput = z.object({
  name: z.string().optional(),
  domain: z.string().optional(),
  path: z.string().optional(),
}).describe("All filters optional — with no filter, clears every cookie in the context.");

export const cookiesClear = defineTool({
  name: "cookies_clear",
  description:
    "Clear cookies in the session. Filters (name/domain/path) AND together; no filter clears everything.",
  category: "storage",
  inputSchema: CookiesClearInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<CookiesClearResult>("cookies.clear", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", `Cleared ${r.cleared} cookie${r.cleared === 1 ? "" : "s"}.`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function formatCookie(c: {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}): string {
  const flags: string[] = [];
  if (c.httpOnly) flags.push("HttpOnly");
  if (c.secure) flags.push("Secure");
  if (c.sameSite) flags.push(`SameSite=${c.sameSite}`);
  if (c.session) flags.push("Session");
  const expires = c.session || c.expires < 0 ? "" : ` exp=${new Date(c.expires * 1000).toISOString()}`;
  const v = c.value.length > 40 ? c.value.slice(0, 40) + "…" : c.value;
  return `${c.name}=${v}  [${c.domain}${c.path}]${expires}${flags.length ? " " + flags.join(",") : ""}`;
}

// --- localStorage / sessionStorage tools (M3.2) ---

const PageScoped = z.object({ pageId: z.string().optional() });
const StorageGetInput = PageScoped.extend({ key: z.string().min(1) });
const StorageSetInput = PageScoped.extend({ key: z.string().min(1), value: z.string() });
const StorageRemoveInput = PageScoped.extend({ key: z.string().min(1) });
const StorageClearInput = PageScoped;
const StorageListInput = PageScoped;

function makeStorageGet(kind: StorageKind) {
  return defineTool({
    name: `${kind === "local" ? "localStorage" : "sessionStorage"}_get`,
    description: `Get one key from window.${kind === "local" ? "localStorage" : "sessionStorage"} of the active (or specified) page.`,
    category: "storage",
    inputSchema: StorageGetInput,
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<StorageGetResult>("storage.get", {
        sessionId: ctx.sessionId,
        kind,
        ...input,
      });
      return new McpResponse()
        .addSection("Result", r.value === null ? `(no value for ${r.key})` : `${r.key} = ${r.value}`)
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

function makeStorageSet(kind: StorageKind) {
  return defineTool({
    name: `${kind === "local" ? "localStorage" : "sessionStorage"}_set`,
    description: `Set one key in window.${kind === "local" ? "localStorage" : "sessionStorage"}.`,
    category: "storage",
    inputSchema: StorageSetInput,
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<StorageSetResult>("storage.set", {
        sessionId: ctx.sessionId,
        kind,
        ...input,
      });
      return new McpResponse()
        .addSection("Result", `Set ${r.key}`)
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

function makeStorageRemove(kind: StorageKind) {
  return defineTool({
    name: `${kind === "local" ? "localStorage" : "sessionStorage"}_remove`,
    description: `Remove one key from window.${kind === "local" ? "localStorage" : "sessionStorage"}.`,
    category: "storage",
    inputSchema: StorageRemoveInput,
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<StorageRemoveResult>("storage.remove", {
        sessionId: ctx.sessionId,
        kind,
        ...input,
      });
      return new McpResponse()
        .addSection("Result", r.existed ? `Removed ${r.key}` : `${r.key} did not exist`)
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

function makeStorageClear(kind: StorageKind) {
  return defineTool({
    name: `${kind === "local" ? "localStorage" : "sessionStorage"}_clear`,
    description: `Clear all keys from window.${kind === "local" ? "localStorage" : "sessionStorage"}.`,
    category: "storage",
    inputSchema: StorageClearInput,
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<StorageClearResult>("storage.clear", {
        sessionId: ctx.sessionId,
        kind,
        ...input,
      });
      return new McpResponse()
        .addSection("Result", `Cleared ${r.cleared} key${r.cleared === 1 ? "" : "s"}`)
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

function makeStorageList(kind: StorageKind) {
  return defineTool({
    name: `${kind === "local" ? "localStorage" : "sessionStorage"}_list`,
    description: `List up to 200 keys (with truncated values) from window.${kind === "local" ? "localStorage" : "sessionStorage"}.`,
    category: "storage",
    inputSchema: StorageListInput,
    handler: async (input, ctx) => {
      const r = await ctx.daemon.call<StorageListResult>("storage.list", {
        sessionId: ctx.sessionId,
        kind,
        ...input,
      });
      const body =
        r.entries.length === 0
          ? "(empty)"
          : r.entries
              .map((e) => `${e.key} = ${e.value}${e.truncated ? "  …(truncated)" : ""}`)
              .join("\n");
      return new McpResponse()
        .addSection(
          `${kind === "local" ? "localStorage" : "sessionStorage"} (${r.totalKeys} keys)`,
          body,
          { changeKey: `${ctx.sessionId}:${kind}storage` },
        )
        .setStructured(r as unknown as Record<string, unknown>)
        .build();
    },
  });
}

export const localStorageGet = makeStorageGet("local");
export const localStorageSet = makeStorageSet("local");
export const localStorageRemove = makeStorageRemove("local");
export const localStorageClear = makeStorageClear("local");
export const localStorageList = makeStorageList("local");
export const sessionStorageGet = makeStorageGet("session");
export const sessionStorageSet = makeStorageSet("session");
export const sessionStorageRemove = makeStorageRemove("session");
export const sessionStorageClear = makeStorageClear("session");
export const sessionStorageList = makeStorageList("session");

// --- IndexedDB tools (M3.3) ---

const IdbListInput = PageScoped;
export const indexeddbListDatabases = defineTool({
  name: "indexeddb_list_databases",
  description: "List IndexedDB databases visible to the active page.",
  category: "storage",
  inputSchema: IdbListInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<IndexedDbListDatabasesResult>(
      "indexeddb.list_databases",
      { sessionId: ctx.sessionId, ...input },
    );
    const body =
      r.databases.length === 0
        ? "(no databases)"
        : r.databases.map((d) => `${d.name}  v${d.version}`).join("\n");
    return new McpResponse()
      .addSection("Databases", body, { changeKey: `${ctx.sessionId}:idb-dbs` })
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const IdbQueryInput = PageScoped.extend({
  database: z.string().min(1),
  store: z.string().min(1),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});
export const indexeddbQuery = defineTool({
  name: "indexeddb_query",
  description: "Read up to `limit` rows (default 20, max 200) from an IndexedDB object store.",
  category: "storage",
  inputSchema: IdbQueryInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<IndexedDbQueryResult>("indexeddb.query", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const body =
      r.rows.length === 0
        ? "(no rows)"
        : r.rows
            .map((row, i) => `[${i}] key=${JSON.stringify(row.key)}  value=${truncateJson(row.value, 200)}`)
            .join("\n");
    const meta = `${r.database}/${r.store} — ${r.rows.length}/${r.count} rows${r.truncated ? " (more available)" : ""}`;
    return new McpResponse()
      .addSection("Rows", `${meta}\n${body}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const IdbClearInput = PageScoped.extend({
  database: z.string().min(1),
  store: z.string().optional().describe("Omit to delete the whole database."),
});
export const indexeddbClear = defineTool({
  name: "indexeddb_clear",
  description: "Clear an IndexedDB object store, or delete an entire database when `store` is omitted.",
  category: "storage",
  inputSchema: IdbClearInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<IndexedDbClearResult>("indexeddb.clear", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const msg = r.deletedDatabase
      ? `Deleted database ${r.database}`
      : `Cleared ${r.database}/${r.store}`;
    return new McpResponse()
      .addSection("Result", msg)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function truncateJson(v: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? s.slice(0, max) + "…" : s;
}
