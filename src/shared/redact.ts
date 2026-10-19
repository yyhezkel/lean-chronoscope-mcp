/**
 * 3-mode secret redaction for network payloads.
 *
 *   - "all":     redact everywhere (paranoia mode, e.g. demos / screen-recordings)
 *   - "external": redact requests/responses going to hosts NOT in trustedDomains
 *                 (default: localhost, 127.0.0.1, ::1). Add your own hosts via
 *                 LEAN_CHRONOSCOPE_TRUSTED_DOMAINS. Treats trusted hosts as safe;
 *                 everything else is dirty.
 *   - "none":    no redaction (raw passthrough)
 *
 * Configuration via env (read once at MCP-server start; legacy BROWSER_MCP_*
 * names still honored as a fallback):
 *   LEAN_CHRONOSCOPE_REDACT_MODE=all|external|none  (default: external)
 *   LEAN_CHRONOSCOPE_TRUSTED_DOMAINS=a.com,b.org    (comma-separated, replaces defaults)
 */

import { env } from "./env.js";

export type RedactMode = "all" | "external" | "none";

export interface RedactConfig {
  mode: RedactMode;
  trustedDomains: string[];
}

const DEFAULT_TRUSTED = ["localhost", "127.0.0.1", "::1"];

/**
 * Header names whose entire value should be replaced. Lowercase keys.
 * Anything case-insensitively matching these is fully redacted.
 */
const SECRET_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-amz-security-token",
]);

/**
 * Header names whose value is a URL (or path) — kept, but run through URL
 * redaction since they echo the request's query string.
 */
const URL_HEADERS = new Set(["referer", "location", "content-location", ":path"]);

/**
 * Key names whose values are treated as secrets — shared by the JSON and
 * form-encoded body patterns and by the URL query-param redaction. Only
 * unambiguous, compound names live here: body text is free-form, so a short
 * generic word would redact ordinary prose / JSON (`"code": 404`, `"key": "id"`).
 */
const SECRET_KEY_SRC =
  "access_?token|auth_?token|id_?token|password|passwd|secret|api[_-]?key|client[_-]?secret|refresh[_-]?token|bearer|jwt";

/**
 * Extra key names treated as secrets ONLY as URL params (`?name=` / `&name=` /
 * `#name=` / `;name=`), where the param name is exact and delimited, so short
 * generic names are safe to match there: bare `token`, OAuth `code`, Google
 * `?key=AIza…`, signed-URL `sig`/`signature`, AWS SigV4 presign params
 * (`X-Amz-Signature`, `X-Amz-Credential`, `X-Amz-Security-Token`), GCS V4
 * (`X-Goog-Signature`, `X-Goog-Credential`), and session ids (`session`,
 * `session_id`, Java `jsessionid`, PHP `PHPSESSID`, bare `sid` — exact names
 * only, so `foosid=` is untouched). Deliberately NOT
 * added to the body patterns — there they would cause false positives.
 * Matching is case-insensitive.
 */
const URL_ONLY_KEY_SRC =
  "token|code|key|sig|signature|auth|session|session_?id|jsessionid|phpsessid|sid|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential";

const URL_KEY_SRC = `${SECRET_KEY_SRC}|${URL_ONLY_KEY_SRC}`;

/**
 * Regexes that strip secret-shaped substrings inside bodies. Kept conservative
 * — false positives ("redacted normal text") are far worse than false negatives.
 */
const BODY_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // JSON-style "token": "..." / "password": "..." / "api_key": "..."
  {
    re: new RegExp(`("(?:${SECRET_KEY_SRC})"\\s*:\\s*")[^"]*(")`, "gi"),
    replacement: "$1[REDACTED]$2",
  },
  // Form-encoded password=... / api_key=...
  {
    re: new RegExp(`\\b(${SECRET_KEY_SRC})=([^&\\s"]+)`, "gi"),
    replacement: "$1=[REDACTED]",
  },
  // Authorization: Bearer ... or basic ... inside text
  {
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "$1 [REDACTED]",
  },
  // Inline URL credentials inside text (stack traces, error messages, bodies)
  {
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'<>]+@/gi,
    replacement: "$1[REDACTED]@",
  },
];

/** Userinfo of a whole URL string: everything between `scheme://` and the last `@` of the authority. */
const URL_USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;
/**
 * Secret query/fragment params; value stops at `&`, `#` or whitespace so the
 * rest of the URL survives. A `/` (or `?`) does NOT end a query value: secrets
 * such as base64 signatures may contain `/`, and stopping there would leak the
 * tail — over-redacting the remainder of a query is the safer failure.
 */
const URL_QUERY_PARAM_RE = new RegExp(`([?&#;](?:${URL_KEY_SRC})=)[^&#\\s]*`, "gi");
/**
 * Secret matrix params in the PATH (`/p;secret=x/more`): value also stops at
 * `/`, `;` and `?` so the remaining path segments and the query survive.
 */
const URL_PATH_PARAM_RE = new RegExp(`([;&](?:${URL_KEY_SRC})=)[^&#;/?\\s]*`, "gi");

export function loadRedactConfigFromEnv(): RedactConfig {
  const rawMode = (env("REDACT_MODE") ?? "external").toLowerCase();
  const mode: RedactMode =
    rawMode === "all" || rawMode === "none" || rawMode === "external"
      ? (rawMode as RedactMode)
      : "external";
  const trustedFromEnv = env("TRUSTED_DOMAINS");
  const trustedDomains = trustedFromEnv
    ? trustedFromEnv
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    : DEFAULT_TRUSTED;
  return { mode, trustedDomains };
}

/** True when redaction should run for a request to `url` under `cfg`. */
export function shouldRedact(url: string | null | undefined, cfg: RedactConfig): boolean {
  if (cfg.mode === "none") return false;
  if (cfg.mode === "all") return true;
  if (!url) return true; // unknown origin → assume external
  const host = hostnameOf(url);
  if (!host) return true;
  return !isTrustedHost(host, cfg.trustedDomains);
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isTrustedHost(host: string, trusted: string[]): boolean {
  for (const t of trusted) {
    if (host === t) return true;
    if (host.endsWith("." + t)) return true;
    // wildcard ".local" style entries
    if (t.startsWith(".") && host.endsWith(t)) return true;
    if (t.startsWith("*.") && host.endsWith(t.slice(1))) return true;
  }
  return false;
}

/**
 * Redact a headers object (returned by daemon as plain map). Returns a NEW object;
 * does not mutate the input. Header lookups are case-insensitive.
 */
export function redactHeaders(
  headers: Record<string, string> | null,
  url: string | null | undefined,
  cfg: RedactConfig,
): Record<string, string> | null {
  if (!headers) return headers;
  if (!shouldRedact(url, cfg)) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (SECRET_HEADERS.has(lk)) {
      out[k] = "[REDACTED]";
    } else if (URL_HEADERS.has(lk)) {
      out[k] = redactUrlString(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Redact secret-shaped substrings inside a string body. Returns the new string. */
export function redactBody(
  body: string | null | undefined,
  url: string | null | undefined,
  cfg: RedactConfig,
): string | null | undefined {
  if (body == null) return body;
  if (!shouldRedact(url, cfg)) return body;
  let out = body;
  for (const { re, replacement } of BODY_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Redact credentials inside a URL: userinfo (`https://user:pass@h` and
 * `https://user@h` → `https://[REDACTED]@h`) and the values of secret-named
 * query/fragment params. Purely string-based, so unparseable URLs are still
 * redacted and never throw; everything else in the URL is left byte-identical.
 */
export function redactUrl<T extends string | null | undefined>(url: T, cfg: RedactConfig): T {
  if (url == null) return url;
  if (!shouldRedact(url, cfg)) return url;
  return redactUrlString(url) as T;
}

function redactUrlString(url: string): string {
  const u = url.replace(URL_USERINFO_RE, "$1[REDACTED]@");
  // Split at the first `?`/`#`: before it is the path (matrix-param rules),
  // from it on is the query/fragment (query-param rules). Idempotent:
  // `[REDACTED]` contains none of the delimiters and re-redacts to itself.
  const cut = u.search(/[?#]/);
  const path = cut === -1 ? u : u.slice(0, cut);
  const rest = cut === -1 ? "" : u.slice(cut);
  return path.replace(URL_PATH_PARAM_RE, "$1[REDACTED]") + rest.replace(URL_QUERY_PARAM_RE, "$1[REDACTED]");
}
