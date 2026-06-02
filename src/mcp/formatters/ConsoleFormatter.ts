import type { ConsoleSummary } from "@daemon/storage/reader.js";

export interface ConsoleLine {
  text: string;
  /** msgid: stable SQLite primary-key id. */
  msgid: number;
}

const LEVEL_BADGE: Record<string, string> = {
  log: "log",
  info: "info",
  warn: "WRN",
  error: "ERR",
  debug: "dbg",
  trace: "trc",
  exception: "EXC",
};

/** Compact line for listing — caller can fetch full detail via `console_get`. */
export function formatConsoleSummary(row: ConsoleSummary): ConsoleLine {
  const ts = new Date(row.ts).toISOString().slice(11, 23); // HH:MM:SS.sss
  const badge = LEVEL_BADGE[row.level] ?? row.level;
  const loc = row.url ? ` [${shortUrl(row.url)}:${row.line ?? "?"}]` : "";
  const text = row.text.length > 180 ? row.text.slice(0, 180) + "…" : row.text;
  return {
    msgid: row.id,
    text: `[${badge}] ${ts} #${row.id} ${text}${loc}`,
  };
}

/** Collapse consecutive identical messages: "msg (×N)". Display-layer only. */
export function groupConsecutive(rows: ConsoleSummary[]): ConsoleLine[] {
  const out: ConsoleLine[] = [];
  let i = 0;
  while (i < rows.length) {
    let j = i + 1;
    while (
      j < rows.length &&
      rows[j]!.level === rows[i]!.level &&
      rows[j]!.text === rows[i]!.text
    ) {
      j++;
    }
    const base = formatConsoleSummary(rows[i]!);
    if (j - i === 1) {
      out.push(base);
    } else {
      out.push({ msgid: base.msgid, text: `${base.text}  (×${j - i})` });
    }
    i = j;
  }
  return out;
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 30 ? "…" + u.pathname.slice(-30) : u.pathname;
    return u.host + path;
  } catch {
    return url.length > 60 ? "…" + url.slice(-60) : url;
  }
}
