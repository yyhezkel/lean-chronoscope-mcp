import { z } from "zod";
import type {
  EmulateGeolocationResult,
  EmulateNetworkResult,
  EmulateUserAgentResult,
  EmulateViewportResult,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const PageScoped = z.object({ pageId: z.string().optional() });

const EmulateViewportInput = PageScoped.extend({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive().optional(),
  isMobile: z.boolean().optional(),
  hasTouch: z.boolean().optional(),
  isLandscape: z.boolean().optional(),
});
export const emulateViewport = defineTool({
  name: "emulate_viewport",
  description:
    "Set the page viewport (width/height in CSS pixels). Also accepts deviceScaleFactor and mobile/touch/landscape flags.",
  category: "emulation",
  inputSchema: EmulateViewportInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<EmulateViewportResult>("emulate.viewport", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", `Viewport ${r.width}x${r.height} on ${r.pageId}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const EmulateUserAgentInput = PageScoped.extend({
  userAgent: z.string().min(1),
  acceptLanguage: z.string().optional(),
  platform: z.string().optional(),
});
export const emulateUserAgent = defineTool({
  name: "emulate_useragent",
  description: "Override the page's User-Agent (and optionally Accept-Language / platform).",
  category: "emulation",
  inputSchema: EmulateUserAgentInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<EmulateUserAgentResult>("emulate.useragent", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", `User-Agent set on ${r.pageId}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const EmulateNetworkInput = PageScoped.extend({
  preset: z
    .enum(["online", "offline", "Slow 3G", "Fast 3G", "4G", "WiFi"])
    .optional()
    .describe("Named preset. Mutually exclusive with custom values."),
  offline: z.boolean().optional(),
  latencyMs: z.number().min(0).optional(),
  downloadKbps: z.number().min(0).optional(),
  uploadKbps: z.number().min(0).optional(),
});
export const emulateNetwork = defineTool({
  name: "emulate_network",
  description:
    "Throttle / disable the page's network. Use `preset` (online/offline/Slow 3G/Fast 3G/4G/WiFi) or custom latency+throughput values.",
  category: "emulation",
  inputSchema: EmulateNetworkInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<EmulateNetworkResult>("emulate.network", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const a = r.applied;
    const msg = a.offline
      ? `Offline`
      : `latency=${a.latencyMs}ms down=${a.downloadKbps}kbps up=${a.uploadKbps}kbps`;
    return new McpResponse()
      .addSection("Result", `${msg} on ${r.pageId}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const EmulateGeolocationInput = PageScoped.extend({
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  accuracy: z.number().min(0).optional(),
});
export const emulateGeolocation = defineTool({
  name: "emulate_geolocation",
  description: "Override geolocation. Pass latitude/longitude=null (or omit both) to clear the override.",
  category: "emulation",
  inputSchema: EmulateGeolocationInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<EmulateGeolocationResult>("emulate.geolocation", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", r.cleared ? `Geolocation override cleared on ${r.pageId}` : `Geolocation set on ${r.pageId}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
