// Broadcast lists. WhatsApp Web can't CREATE broadcast lists, but you can query
// an existing one and send to it. A broadcast send is a normal sendMessage with
// { broadcast: true, statusJidList } in the options — only the recipients you
// supply receive it. We send through the live socket directly (safeSend's
// onWhatsApp target check doesn't apply to a @broadcast jid) but still honor the
// send kill-switch + connection guard manually.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { sendBlocked } from "../whatsapp/sendguard";
import { phoneToJid } from "../whatsapp/jid";
import { errorResult, textResult } from "./util";

export function registerBroadcastTools(server: McpServer): void {
  server.registerTool(
    "wa_broadcast_info",
    {
      title: "Query a broadcast list",
      description: "Fetch a broadcast list's name + recipients. broadcastJid looks like 1234@broadcast.",
      inputSchema: { broadcastJid: z.string().describe("…@broadcast id.") },
    },
    async ({ broadcastJid }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const sock: any = getSock();
      if (typeof sock.getBroadcastListInfo !== "function")
        return errorResult("getBroadcastListInfo not available in this Baileys version");
      try {
        const info = await sock.getBroadcastListInfo(broadcastJid);
        return textResult(info);
      } catch (e: any) {
        return errorResult(`broadcast info failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_send_broadcast",
    {
      title: "Send a broadcast (text)",
      description:
        "Send a text broadcast to a list of recipients. Only the recipients you list will receive it. " +
        "Honors the send kill-switch. Use sparingly — broadcasts are a strong ban signal.",
      inputSchema: {
        recipients: z.array(z.string()).min(1).describe("Phones or JIDs that will receive the broadcast."),
        text: z.string().min(1),
      },
    },
    async ({ recipients, text }) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const statusJidList = recipients.map((r) => (r.includes("@") ? r : phoneToJid(r)));
      try {
        const sent: any = await getSock().sendMessage(
          "status@broadcast",
          { text } as any,
          { statusJidList, broadcast: true } as any,
        );
        return textResult(
          { messageId: sent?.key?.id ?? null, recipients: statusJidList.length },
          `Broadcast sent to ${statusJidList.length} recipient(s).`,
        );
      } catch (e: any) {
        return errorResult(`broadcast send failed: ${e?.message ?? e}`);
      }
    },
  );
}
