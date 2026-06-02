import type { NetworkSummary, NetworkDetail } from "@daemon/storage/reader.js";

export const INLINE_BODY_THRESHOLD = 10_000;

/** Concise one-liner for listing. */
export function formatNetworkSummary(row: NetworkSummary): string {
  const status = row.status ?? (row.errorText ? `ERR` : "...");
  const dur = row.tsResponse != null ? `${row.tsResponse - row.tsRequest}ms` : "...";
  const size = row.sizeResponse != null ? sizeOf(row.sizeResponse) : "";
  const type = row.resourceType ? `[${row.resourceType}]` : "";
  return `#${row.id} ${row.method.padEnd(4)} ${String(status).padStart(3)} ${dur.padStart(6)}  ${size.padEnd(7)} ${type} ${shortUrl(row.url)}`;
}

export interface FormattedDetail {
  text: string;
  reqBodyHint?: { inline?: string; sha?: string; bytes?: number };
  resBodyHint?: { inline?: string; sha?: string; bytes?: number };
}

export function formatNetworkDetail(
  detail: NetworkDetail,
  part: "meta" | "request-body" | "response-body" | "all" = "all",
): FormattedDetail {
  const lines: string[] = [];
  if (part === "meta" || part === "all") {
    lines.push(`#${detail.id} ${detail.method} ${detail.url}`);
    lines.push(`Status: ${detail.status ?? "(none)"} ${detail.statusText ?? ""}`.trim());
    if (detail.protocol) lines.push(`Protocol: ${detail.protocol}`);
    if (detail.remoteIp) lines.push(`Remote IP: ${detail.remoteIp}`);
    if (detail.fromDiskCache) lines.push("From disk cache");
    if (detail.fromSvcWorker) lines.push("From service worker");
    if (detail.sizeResponse != null) lines.push(`Response size: ${detail.sizeResponse}`);
    if (detail.errorText) lines.push(`Error: ${detail.errorText}`);
    if (detail.tsResponse) {
      lines.push(`Timing: req->resp ${detail.tsResponse - detail.tsRequest}ms, resp->fin ${detail.tsFinished != null ? detail.tsFinished - detail.tsResponse : "?"}ms`);
    }
    lines.push("");
    lines.push("Request headers:");
    lines.push(prettyHeaders(detail.reqHeaders));
    if (detail.resHeaders) {
      lines.push("");
      lines.push("Response headers:");
      lines.push(prettyHeaders(detail.resHeaders));
    }
  }
  const out: FormattedDetail = { text: "" };
  if (part === "request-body" || part === "all") {
    const hint = bodyHint(detail.reqBodyText, detail.reqBodyBlob);
    out.reqBodyHint = hint;
    if (hint) {
      lines.push("");
      lines.push("Request body:");
      lines.push(bodyDisplay(hint));
    }
  }
  if (part === "response-body" || part === "all") {
    const hint = bodyHint(detail.resBodyText, detail.resBodyBlob);
    out.resBodyHint = hint;
    if (hint) {
      lines.push("");
      lines.push("Response body:");
      lines.push(bodyDisplay(hint));
    }
  }
  out.text = lines.join("\n");
  return out;
}

function bodyHint(text: string | null, blobSha: string | null) {
  if (text) return { inline: text };
  if (blobSha) return { sha: blobSha };
  return undefined;
}

function bodyDisplay(hint: { inline?: string; sha?: string }): string {
  if (hint.inline != null) {
    const trimmed = hint.inline.length > INLINE_BODY_THRESHOLD ? hint.inline.slice(0, INLINE_BODY_THRESHOLD) + "…[truncated]" : hint.inline;
    return trimmed;
  }
  if (hint.sha) return `(stored as blob ${hint.sha.slice(0, 12)} — fetch via separate tool when added)`;
  return "(empty)";
}

function prettyHeaders(json: string | null): string {
  if (!json) return "  (none)";
  try {
    const h = JSON.parse(json) as Record<string, string>;
    return Object.entries(h)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
  } catch {
    return "  (unparseable)";
  }
}

function shortUrl(url: string): string {
  if (url.length <= 90) return url;
  try {
    const u = new URL(url);
    return u.host + (u.pathname.length > 50 ? "…" + u.pathname.slice(-50) : u.pathname) + (u.search ? "?…" : "");
  } catch {
    return "…" + url.slice(-90);
  }
}

function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / 1024 / 1024).toFixed(1)}M`;
}
