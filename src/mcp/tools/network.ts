import { z } from "zod";
import type { NetworkGetResult, NetworkListResult } from "@shared/protocol.js";
import { loadRedactConfigFromEnv, redactBody, redactHeaders } from "@shared/redact.js";
import { McpResponse } from "../response/McpResponse.js";
import { defineTool } from "./ToolDefinition.js";
import { formatNetworkSummary, formatNetworkDetail } from "../formatters/NetworkFormatter.js";
import { paginationMeta } from "../pagination.js";

const REDACT_CFG = loadRedactConfigFromEnv();

const NetworkListInput = z.object({
  pageId: z.string().optional(),
  navId: z.number().int().optional(),
  resourceTypes: z.array(z.string()).optional(),
  urlContains: z.string().optional(),
  status: z.number().int().optional(),
  hideStatic: z.boolean().optional().describe("Hide static assets (default false)"),
  includePreserved: z.boolean().optional(),
  sinceTs: z.number().int().optional(),
  pageIdx: z.number().int().min(0).optional(),
  pageSize: z.number().int().min(1).max(200).optional(),
});

export const networkList = defineTool({
  name: "network_list",
  description:
    "List captured network requests, paginated. Default scope: current navigation. Use `network_get` to fetch headers/bodies (lists never load body — saves tokens).",
  category: "network",
  inputSchema: NetworkListInput,
  handler: async (input, ctx) => {
    const result = await ctx.daemon.call<NetworkListResult>("network.list", {
      sessionId: ctx.sessionId,
      ...input,
    });
    const meta = paginationMeta(result.total, result.pageIdx, result.pageSize);
    const body =
      result.total === 0
        ? "(no requests)"
        : result.rows.map(formatNetworkSummary).join("\n");
    return new McpResponse()
      .addSection("Network", body, { changeKey: `${ctx.sessionId}:network` })
      .addSection("Pagination", `Showing ${meta.showing} (page ${meta.pageIdx + 1} of ${meta.pages})${meta.hasNext ? ` — pass pageIdx:${meta.pageIdx + 1} for next` : ""}`)
      .setStructured({ ...result, pagination: meta })
      .build();
  },
});

const NetworkGetInput = z.object({
  reqid: z.number().int().positive(),
  part: z.enum(["meta", "request-body", "response-body", "all"]).optional(),
});

export const networkGet = defineTool({
  name: "network_get",
  description:
    "Fetch details of one network request. Use `part:'meta'` for headers only; `part:'response-body'` for the body. Bodies >10KB are stored as blobs (sha returned, fetched separately later).",
  category: "network",
  inputSchema: NetworkGetInput,
  handler: async (input, ctx) => {
    const detail = await ctx.daemon.call<NetworkGetResult>("network.get", {
      sessionId: ctx.sessionId,
      id: input.reqid,
      part: input.part,
    });
    const reqHeadersRedacted = redactHeaders(detail.reqHeaders, detail.url, REDACT_CFG);
    const resHeadersRedacted = redactHeaders(detail.resHeaders, detail.url, REDACT_CFG);
    const reqBodyTextRedacted = redactBody(detail.reqBody.text, detail.url, REDACT_CFG) ?? null;
    const resBodyTextRedacted = redactBody(detail.resBody.text, detail.url, REDACT_CFG) ?? null;
    // Map daemon shape back to formatter's expected shape (NetworkDetail).
    const formatted = formatNetworkDetail(
      {
        id: detail.id,
        pageId: detail.pageId,
        navId: null,
        requestId: detail.requestId,
        tsRequest: detail.tsRequest,
        tsResponse: detail.tsResponse,
        tsFinished: detail.tsFinished,
        method: detail.method,
        url: detail.url,
        resourceType: null,
        status: detail.status,
        errorText: detail.errorText,
        statusText: detail.statusText,
        protocol: detail.protocol,
        remoteIp: detail.remoteIp,
        fromDiskCache: detail.fromDiskCache,
        fromSvcWorker: detail.fromSvcWorker,
        sizeResponse: detail.sizeResponse,
        reqHeaders: reqHeadersRedacted ? JSON.stringify(reqHeadersRedacted) : null,
        resHeaders: resHeadersRedacted ? JSON.stringify(resHeadersRedacted) : null,
        reqBodyText: reqBodyTextRedacted,
        reqBodyBlob: detail.reqBody.blobSha ?? null,
        resBodyText: resBodyTextRedacted,
        resBodyBlob: detail.resBody.blobSha ?? null,
        initiator: null,
      },
      input.part ?? "all",
    );
    return new McpResponse()
      .addSection("Request", formatted.text)
      .setStructured(detail as unknown as Record<string, unknown>)
      .build();
  },
});
