// Privacy + blocking tools: block/unblock, blocklist, read & update privacy
// settings, default disappearing mode.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { phoneToJid } from "../whatsapp/jid";
import { resolveName } from "../whatsapp/names";
import { errorResult, noteResult, textResult } from "./util";

export function registerPrivacyTools(server: McpServer): void {
  server.registerTool(
    "wa_block",
    {
      title: "Block / unblock a contact",
      description: "Block or unblock a user. action = block | unblock.",
      inputSchema: { target: z.string().describe("Phone or JID."), action: z.enum(["block", "unblock"]) },
    },
    async ({ target, action }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = target.includes("@") ? target : phoneToJid(target);
      try {
        await getSock().updateBlockStatus(jid, action);
        return noteResult(`${action === "block" ? "Blocked" : "Unblocked"} ${jid}.`);
      } catch (e: any) {
        return errorResult(`${action} failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_blocklist",
    {
      title: "Get block list",
      description: "List the JIDs you have blocked (with resolved names).",
      inputSchema: {},
    },
    async () => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const list: any = await getSock().fetchBlocklist();
        const jids: string[] = Array.isArray(list) ? list : list?.blocklist ?? [];
        const rows = await Promise.all(jids.map(async (j) => ({ jid: j, name: await resolveName(j) })));
        return textResult(rows, `${rows.length} blocked contact(s).`);
      } catch (e: any) {
        return errorResult(`fetch blocklist failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_get_privacy",
    {
      title: "Get privacy settings",
      description: "Fetch your current privacy settings (last-seen, online, profile pic, status, read receipts, groups).",
      inputSchema: {},
    },
    async () => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const settings = await getSock().fetchPrivacySettings(true);
        return textResult(settings);
      } catch (e: any) {
        return errorResult(`fetch privacy failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_set_privacy",
    {
      title: "Update a privacy setting",
      description:
        "Update one privacy setting. scope values differ per setting:\n" +
        "- lastseen / profile_picture / status / groups_add: all | contacts | contact_blacklist | none\n" +
        "- online: all | match_last_seen\n" +
        "- read_receipts: all | none",
      inputSchema: {
        setting: z.enum(["lastseen", "online", "profile_picture", "status", "read_receipts", "groups_add"]),
        scope: z.string().describe("The privacy value — see the setting list above."),
      },
    },
    async ({ setting, scope }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const sock: any = getSock();
      try {
        switch (setting) {
          case "lastseen":
            await sock.updateLastSeenPrivacy(scope);
            break;
          case "online":
            await sock.updateOnlinePrivacy(scope);
            break;
          case "profile_picture":
            await sock.updateProfilePicturePrivacy(scope);
            break;
          case "status":
            await sock.updateStatusPrivacy(scope);
            break;
          case "read_receipts":
            await sock.updateReadReceiptsPrivacy(scope);
            break;
          case "groups_add":
            await sock.updateGroupsAddPrivacy(scope);
            break;
        }
        return noteResult(`Privacy "${setting}" set to "${scope}".`);
      } catch (e: any) {
        return errorResult(`update privacy failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_default_disappearing",
    {
      title: "Set default disappearing mode",
      description: "Set the default disappearing-message timer for NEW chats, in seconds (0 = off, 86400 = 24h, 604800 = 7d, 7776000 = 90d).",
      inputSchema: { seconds: z.number().int().min(0) },
    },
    async ({ seconds }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        await getSock().updateDefaultDisappearingMode(seconds);
        return noteResult(seconds ? `Default disappearing set to ${seconds}s.` : "Default disappearing turned off.");
      } catch (e: any) {
        return errorResult(`set default disappearing failed: ${e?.message ?? e}`);
      }
    },
  );
}
