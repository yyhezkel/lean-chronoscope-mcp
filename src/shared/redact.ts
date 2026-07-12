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
 * Regexes that strip secret-shaped substrings inside bodies. Kept conservative
 * — false positives ("redacted normal text") are far worse than false negatives.
 */
const BODY_PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // JSON-style "token": "..." / "password": "..." / "api_key": "..."
  {
    re: /("(?:access_?token|auth_?token|password|passwd|secret|api[_-]?key|client[_-]?secret|refresh[_-]?token|bearer)"\s*:\s*")[^"]*(")/gi,
    replacement: "$1[REDACTED]$2",
  },
  // Form-encoded password=... / api_key=...
  {
    re: /\b(access_?token|auth_?token|password|passwd|secret|api[_-]?key|client[_-]?secret|refresh[_-]?token|bearer)=([^&\s"]+)/gi,
    replacement: "$1=[REDACTED]",
  },
  // Authorization: Bearer ... or basic ... inside text
  {
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: "$1 [REDACTED]",
  },
];

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
    if (SECRET_HEADERS.has(k.toLowerCase())) {
      out[k] = "[REDACTED]";
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
