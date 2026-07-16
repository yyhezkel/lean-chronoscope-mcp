import { z } from "zod";
import type { FontsListResult } from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const FontsListInput = z.object({
  lang: z
    .string()
    .optional()
    .describe(
      "BCP-47 language filter, e.g. 'he', 'ar', 'zh', 'ja'. Lists only families that cover that language.",
    ),
});

export const fontsList = defineTool({
  name: "fonts_list",
  description:
    "List font families installed in the browser container (fc-list). Pass `lang` (e.g. 'he', 'ar', 'zh') to check a script can render before screenshotting — an empty result means that script will draw tofu boxes. To add a font at any time (no image rebuild): drop .ttf/.otf files into the host dir mounted at /home/mcp/.fonts (volume example in docker-compose.yml) — the daemon detects the change and auto-restarts within ~2 minutes to load them (kills active sessions; `docker restart` forces it immediately; LEAN_CHRONOSCOPE_FONT_WATCH=0 disables).",
  category: "daemon",
  inputSchema: FontsListInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<FontsListResult>("fonts.list", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const header = r.lang
      ? `${r.count} families cover lang=${r.lang}`
      : `${r.count} families installed`;
    const body =
      r.count === 0
        ? r.lang
          ? `(none — text in '${r.lang}' will render as tofu boxes; drop a font into the dir mounted at /home/mcp/.fonts and the daemon auto-restarts to load it)`
          : "(none)"
        : r.families.join(", ");
    return new McpResponse()
      .addSection("Fonts", `${header}\n${body}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
