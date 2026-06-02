// Minimal response builder for M0. Will grow to sectioned text + structuredContent in M1.

import { noteChange } from "./change-detect.js";

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface McpToolResponse {
  content: McpContent[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface AddSectionOptions {
  /**
   * When set, the body is hashed and compared to the last call with the same
   * `changeKey`. If the body is identical, the section collapses to a 1-line
   * marker `### {title} (unchanged since rev N)`. Saves tokens on repeated
   * polling. Memo lives in `change-detect.ts`, scoped to the MCP-server process.
   */
  changeKey?: string;
}

export class McpResponse {
  private readonly sections: string[] = [];
  private readonly images: { data: string; mimeType: string }[] = [];
  private structured?: Record<string, unknown>;
  private errored = false;

  addText(text: string): this {
    this.sections.push(text);
    return this;
  }

  addSection(title: string, body: string, opts?: AddSectionOptions): this {
    if (opts?.changeKey) {
      const { changed, rev } = noteChange(opts.changeKey, body);
      if (!changed) {
        this.sections.push(`### ${title} (unchanged since rev ${rev})`);
        return this;
      }
    }
    this.sections.push(`### ${title}\n${body}`);
    return this;
  }

  addImage(base64: string, mimeType: string): this {
    this.images.push({ data: base64, mimeType });
    return this;
  }

  setError(message: string): this {
    this.errored = true;
    this.sections.push(`### Error\n${message}`);
    return this;
  }

  setStructured(obj: Record<string, unknown>): this {
    this.structured = obj;
    return this;
  }

  build(): McpToolResponse {
    const content: McpContent[] = [];
    if (this.sections.length > 0) {
      content.push({ type: "text", text: this.sections.join("\n\n") });
    }
    for (const img of this.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    if (content.length === 0) {
      content.push({ type: "text", text: "(no output)" });
    }
    const out: McpToolResponse = { content };
    if (this.errored) out.isError = true;
    if (this.structured) out.structuredContent = this.structured;
    return out;
  }
}
