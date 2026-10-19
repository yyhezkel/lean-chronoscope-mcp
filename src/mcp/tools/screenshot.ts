import { z } from "zod";
import type { ScreenshotTakeResult } from "@shared/protocol.js";
import { loadRedactConfigFromEnv, redactUrl } from "@shared/redact.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const REDACT_CFG = loadRedactConfigFromEnv();

const ScreenshotInput = z.object({
  pageId: z.string().optional(),
  fullPage: z.boolean().optional(),
  format: z.enum(["png", "jpeg", "webp"]).optional(),
  quality: z.number().int().min(1).max(100).optional(),
});

export const screenshotTake = defineTool({
  name: "screenshot_take",
  description: "Take a screenshot of the current (or specified) page. Returns the image inline.",
  category: "screenshot",
  inputSchema: ScreenshotInput,
  handler: async (input, ctx) => {
    const result = await ctx.daemon.call<ScreenshotTakeResult>("screenshot.take", {
      sessionId: ctx.sessionId,
      pageId: input.pageId,
      fullPage: input.fullPage,
      format: input.format,
      quality: input.quality,
    });
    const url = redactUrl(result.url, REDACT_CFG);
    const mimeType =
      result.format === "jpeg" ? "image/jpeg" : result.format === "webp" ? "image/webp" : "image/png";
    return new McpResponse()
      .addSection(
        "Result",
        `Screenshot of ${url}\n${result.width}x${result.height} • ${result.bytes} bytes • ${result.format}`,
      )
      .addImage(result.data, mimeType)
      .setStructured({
        pageId: result.pageId,
        url,
        width: result.width,
        height: result.height,
        format: result.format,
        bytes: result.bytes,
      })
      .build();
  },
});
