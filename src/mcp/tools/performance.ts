import { z } from "zod";
import type { PerformanceMetricsResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const Input = z.object({ pageId: z.string().optional() });

export const performanceMetrics = defineTool({
  name: "performance_metrics",
  description:
    "Return Chrome performance metrics for the active page: JS heap, DOM nodes, layout count, listener count, navigation timing (TTFB, FCP, LCP).",
  category: "performance",
  inputSchema: Input,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<PerformanceMetricsResult>("performance.metrics", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const cdp = formatCdpMetrics(r.metrics);
    const timing = r.timing ? formatTiming(r.timing) : "(unavailable)";
    const paint = r.paint
      ? [
          r.paint.firstPaintMs != null ? `FP=${r.paint.firstPaintMs}ms` : null,
          r.paint.firstContentfulPaintMs != null ? `FCP=${r.paint.firstContentfulPaintMs}ms` : null,
          r.paint.largestContentfulPaintMs != null ? `LCP=${r.paint.largestContentfulPaintMs}ms` : null,
        ]
          .filter(Boolean)
          .join("  ")
      : "(no paint entries)";
    return new McpResponse()
      .addSection("Page", `${r.url}  (${r.pageId})`)
      .addSection("Chrome", cdp)
      .addSection("Timing", timing)
      .addSection("Paint", paint)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

function formatCdpMetrics(m: Record<string, number>): string {
  const keys = [
    "JSHeapUsedSize",
    "JSHeapTotalSize",
    "Documents",
    "Frames",
    "Nodes",
    "LayoutCount",
    "RecalcStyleCount",
    "LayoutDuration",
    "ScriptDuration",
    "TaskDuration",
    "JSEventListeners",
  ];
  const lines: string[] = [];
  for (const k of keys) {
    if (k in m) {
      const v = m[k]!;
      lines.push(`  ${k.padEnd(22)} ${formatNumber(k, v)}`);
    }
  }
  return lines.join("\n") || "(no metrics)";
}

function formatNumber(name: string, v: number): string {
  if (name.endsWith("HeapUsedSize") || name.endsWith("HeapTotalSize")) {
    return `${(v / 1024 / 1024).toFixed(1)} MB`;
  }
  if (name.endsWith("Duration")) {
    return `${(v * 1000).toFixed(1)} ms`;
  }
  return String(Math.round(v));
}

function formatTiming(t: Record<string, number>): string {
  const start = t.navigationStart ?? 0;
  const rel = (k: string) => (t[k] ? `${t[k] - start}ms` : "-");
  return [
    `  TTFB              ${rel("responseStart")}`,
    `  DOM interactive   ${rel("domInteractive")}`,
    `  DOM complete      ${rel("domComplete")}`,
    `  load event end    ${rel("loadEventEnd")}`,
  ].join("\n");
}
