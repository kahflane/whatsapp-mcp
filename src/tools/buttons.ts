// Interactive button / list message tools, built on the fork's generate*
// helpers so we don't hand-build the complex payloads.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as Baileys from "@innovatorssoft/baileys";
import { z } from "zod";
import { safeSend } from "../whatsapp/send";
import { errorResult, textResult } from "./util";

const gen = Baileys as any;

export function registerButtonTools(server: McpServer): void {
  server.registerTool(
    "wa_send_buttons",
    {
      title: "Send interactive buttons",
      description:
        "Send a message with native interactive buttons (mix reply / url / copy / call). Uses generateCombinedButtons.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        body: z.string().min(1).describe("Message body text."),
        title: z.string().optional(),
        footer: z.string().optional(),
        buttons: z
          .array(
            z.object({
              type: z.enum(["reply", "url", "copy", "call"]),
              displayText: z.string(),
              id: z.string().optional().describe("reply: button id"),
              url: z.string().optional().describe("url: link"),
              copyCode: z.string().optional().describe("copy: code to copy"),
              phoneNumber: z.string().optional().describe("call: phone number"),
            }),
          )
          .min(1)
          .max(3),
      },
    },
    async ({ target, body, title, footer, buttons }) => {
      if (typeof gen.generateCombinedButtons !== "function")
        return errorResult("generateCombinedButtons not available in this Baileys version");
      try {
        const content = gen.generateCombinedButtons(body, buttons, { title, footer });
        const res = await safeSend(target, content);
        return res.ok ? textResult(res, "Sent buttons.") : errorResult(res.error);
      } catch (e: any) {
        return errorResult(`send failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_send_list",
    {
      title: "Send interactive list",
      description: "Send an interactive list message (sections of selectable rows). Uses generateInteractiveListMessage.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        title: z.string(),
        buttonText: z.string().describe("Text on the button that opens the list."),
        description: z.string().optional(),
        footer: z.string().optional(),
        sections: z
          .array(
            z.object({
              title: z.string(),
              rows: z
                .array(
                  z.object({
                    rowId: z.string(),
                    title: z.string(),
                    description: z.string().optional(),
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
      },
    },
    async ({ target, title, buttonText, description, footer, sections }) => {
      if (typeof gen.generateInteractiveListMessage !== "function")
        return errorResult("generateInteractiveListMessage not available in this Baileys version");
      try {
        const content = gen.generateInteractiveListMessage({ title, buttonText, description, footer, sections });
        const res = await safeSend(target, content);
        return res.ok ? textResult(res, "Sent list.") : errorResult(res.error);
      } catch (e: any) {
        return errorResult(`send failed: ${e?.message ?? e}`);
      }
    },
  );
}
