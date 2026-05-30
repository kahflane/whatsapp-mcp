// Message-template tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { create, list, quick, render } from "../whatsapp/templates";
import { safeSend } from "../whatsapp/send";
import { getMessageRawAnyChat } from "../store/db";
import type { WAMessage } from "@innovatorssoft/baileys";
import { errorResult, textResult } from "./util";

export function registerTemplateTools(server: McpServer): void {
  server.registerTool(
    "wa_list_templates",
    {
      title: "List templates",
      description: "List available message templates (presets + custom).",
      inputSchema: {},
    },
    async () => textResult(list()),
  );

  server.registerTool(
    "wa_render_template",
    {
      title: "Render a template",
      description:
        "Render a template to text WITHOUT sending. Use a registered template name, or pass an inline template string in `inline` (e.g. 'Hi {{name}}').",
      inputSchema: {
        name: z.string().optional().describe("Registered template name."),
        inline: z.string().optional().describe("Or an inline template string."),
        vars: z.record(z.string()).optional().describe("Variable values."),
      },
    },
    async ({ name, inline, vars }) => {
      try {
        const text = inline ? quick(inline, vars ?? {}) : name ? render(name, vars ?? {}) : null;
        if (text == null) return errorResult("provide name or inline");
        return textResult({ text }, text);
      } catch (e: any) {
        return errorResult(`render failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_create_template",
    {
      title: "Create a template",
      description: "Register a custom template (use {{variable:default}} placeholders).",
      inputSchema: {
        name: z.string().min(1),
        content: z.string().min(1),
        category: z.string().optional(),
      },
    },
    async ({ name, content, category }) => {
      try {
        const t = create({ name, content, category });
        return textResult(t, `Created template "${name}".`);
      } catch (e: any) {
        return errorResult(`create failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_send_template",
    {
      title: "Send a templated message",
      description: "Render a template (by name or inline) and send it as a text message.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        name: z.string().optional(),
        inline: z.string().optional(),
        vars: z.record(z.string()).optional(),
        quotedId: z.string().optional(),
      },
    },
    async ({ target, name, inline, vars, quotedId }) => {
      let text: string;
      try {
        text = inline ? quick(inline, vars ?? {}) : name ? render(name, vars ?? {}) : "";
      } catch (e: any) {
        return errorResult(`render failed: ${e?.message ?? e}`);
      }
      if (!text) return errorResult("provide name or inline");
      const quoted = quotedId ? (getMessageRawAnyChat(quotedId) as WAMessage | null) : null;
      const res = await safeSend(target, { text }, quoted ? { quoted } : undefined);
      return res.ok ? textResult(res, "Sent.") : errorResult(res.error);
    },
  );
}
