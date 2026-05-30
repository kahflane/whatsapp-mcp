// Self-profile (and group display picture) tools: name, status text, picture.
// Picture source may be an http(s) URL or a local file path.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { conn, getSock, notReady } from "../whatsapp/connection";
import { isGroupJid, phoneToJid } from "../whatsapp/jid";
import { errorResult, noteResult } from "./util";

function picture(src: string): { url: string } | Buffer {
  return /^https?:\/\//i.test(src) ? { url: src } : readFileSync(src);
}

// Default the target to "myself" when not given (name/status are always self).
function targetJid(input: string | undefined): string {
  if (!input) return conn.me?.jid ?? "";
  return isGroupJid(input) ? input : phoneToJid(input);
}

export function registerProfileTools(server: McpServer): void {
  server.registerTool(
    "wa_set_name",
    {
      title: "Set my profile name",
      description: "Change your own WhatsApp display name.",
      inputSchema: { name: z.string().min(1) },
    },
    async ({ name }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        await getSock().updateProfileName(name);
        return noteResult(`Profile name set to "${name}".`);
      } catch (e: any) {
        return errorResult(`set name failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_set_status",
    {
      title: "Set my 'about' status text",
      description: "Change your own WhatsApp About/status text.",
      inputSchema: { text: z.string().min(1) },
    },
    async ({ text }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        await getSock().updateProfileStatus(text);
        return noteResult("About text updated.");
      } catch (e: any) {
        return errorResult(`set status failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_set_picture",
    {
      title: "Set profile / group picture",
      description: "Set the display picture for yourself (default) or a group. source = URL or local path. Set wide:true for a panoramic banner.",
      inputSchema: {
        source: z.string().describe("Image URL or local file path."),
        target: z.string().optional().describe("Group JID to set its picture; omit for your own."),
        wide: z.boolean().optional().describe("Use a panoramic (wide) picture instead of a square crop."),
      },
    },
    async ({ source, target, wide }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = targetJid(target);
      if (!jid) return errorResult("no target and own JID unknown — connect first");
      let img: { url: string } | Buffer;
      try {
        img = picture(source);
      } catch (e: any) {
        return errorResult(`could not read source "${source}": ${e?.message ?? e}`);
      }
      try {
        const sock: any = getSock();
        if (wide && typeof sock.updatePanoramaProfilePicture === "function") {
          await sock.updatePanoramaProfilePicture(jid, img);
        } else {
          await sock.updateProfilePicture(jid, img);
        }
        return noteResult(`Picture updated for ${jid}.`);
      } catch (e: any) {
        return errorResult(`set picture failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_remove_picture",
    {
      title: "Remove profile / group picture",
      description: "Remove the display picture for yourself (default) or a group.",
      inputSchema: { target: z.string().optional().describe("Group JID; omit for your own.") },
    },
    async ({ target }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = targetJid(target);
      if (!jid) return errorResult("no target and own JID unknown — connect first");
      try {
        await getSock().removeProfilePicture(jid);
        return noteResult(`Picture removed for ${jid}.`);
      } catch (e: any) {
        return errorResult(`remove picture failed: ${e?.message ?? e}`);
      }
    },
  );
}
