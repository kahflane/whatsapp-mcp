// Chat listing tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listChats } from "../store/db";
import { resolveName } from "../whatsapp/names";
import { textResult } from "./util";

export function registerChatTools(server: McpServer): void {
  server.registerTool(
    "wa_list_chats",
    {
      title: "List chats",
      description: "List known chats (individual + group) with resolved names, newest first.",
      inputSchema: {
        query: z.string().optional().describe("Filter by name/jid substring."),
        type: z.enum(["individual", "group", "all"]).optional().describe("Default all."),
        limit: z.number().int().min(1).max(200).optional().describe("Max rows (default 50)."),
      },
    },
    async ({ query, type, limit }) => {
      const rows = listChats(query, type ?? "all", limit ?? 50);
      // resolve display names (handles LID -> phone/contact) for any row whose
      // stored name is missing.
      const view = await Promise.all(
        rows.map(async (c) => ({
          jid: c.jid,
          name: c.name ?? (await resolveName(c.jid)),
          isGroup: !!c.is_group,
          unread: c.unread,
          lastMessageTs: c.last_ts,
        })),
      );
      return textResult(view, `${rows.length} chat(s).`);
    },
  );
}
