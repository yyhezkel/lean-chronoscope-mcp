import { z } from "zod";
import type {
  NetworkWaitForResult,
  UploadFileResult,
  WaitForResult,
} from "@shared/protocol.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";

const WaitForInput = z
  .object({
    text: z.string().optional().describe("Wait until this substring appears in the page text."),
    textGone: z.string().optional().describe("Wait until this substring disappears."),
    timeoutMs: z.number().int().min(100).max(120_000).optional(),
    pageId: z.string().optional(),
  })
  .refine((v) => v.text || v.textGone, { message: "Provide text or textGone" });

export const waitFor = defineTool({
  name: "wait_for",
  description:
    "Poll the page until `text` appears (or `textGone` disappears) in the visible text, or until timeout (default 10s).",
  category: "snapshot",
  inputSchema: WaitForInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<WaitForResult>("wait.for", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", r.matched ? `Matched after ${r.waitedMs}ms` : `Timed out after ${r.waitedMs}ms`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const NetworkWaitForInput = z.object({
  urlContains: z.string().min(1),
  status: z.number().int().optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  pageId: z.string().optional(),
});

export const networkWaitFor = defineTool({
  name: "network_wait_for",
  description:
    "Poll until a completed network request whose URL contains `urlContains` (and optional `status`) is captured, or timeout.",
  category: "network",
  inputSchema: NetworkWaitForInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<NetworkWaitForResult>("network.wait_for", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const msg = r.matched
      ? `Matched #${r.request?.id} ${r.request?.method} ${r.request?.status} ${r.request?.url} after ${r.waitedMs}ms`
      : `Timed out after ${r.waitedMs}ms`;
    return new McpResponse()
      .addSection("Result", msg)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});

const UploadFileInput = z.object({
  uid: z.string().min(1).describe("UID of a file input element from a snapshot."),
  paths: z.array(z.string().min(1)).min(1).describe("Absolute file paths inside the container."),
  pageId: z.string().optional(),
});

export const uploadFile = defineTool({
  name: "upload_file",
  description:
    "Set the files on a file <input> identified by its snapshot UID. Paths are resolved inside the lean-chronoscope-mcp container.",
  category: "input",
  inputSchema: UploadFileInput,
  handler: async (input, ctx) => {
    const r = await ctx.daemon.call<UploadFileResult>("input.upload_file", {
      sessionId: ctx.sessionId,
      ...input,
    });
    return new McpResponse()
      .addSection("Result", `Set ${r.fileCount} file(s) on ${r.uid}`)
      .setStructured(r as unknown as Record<string, unknown>)
      .build();
  },
});
