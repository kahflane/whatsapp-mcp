// User queries + presence: fetch someone's About/status, profile picture URL,
// business profile, and send/subscribe presence (typing/online).
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { isGroupJid, phoneToJid } from "../whatsapp/jid";
import { errorResult, noteResult, textResult } from "./util";

function toJid(input: string): string {
  return input.includes("@") ? input : phoneToJid(input);
}

export function registerUserTools(server: McpServer): void {
  server.registerTool(
    "wa_get_status",
    {
      title: "Get someone's About text",
      description: "Fetch a user's About/status text.",
      inputSchema: { target: z.string().describe("Phone or JID.") },
    },
    async ({ target }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const status = await getSock().fetchStatus(toJid(target));
        return textResult(status ?? null);
      } catch (e: any) {
        return errorResult(`fetch status failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_get_picture_url",
    {
      title: "Get profile picture URL",
      description: "Fetch a user's or group's profile picture URL. type = preview (low-res, default) | image (full).",
      inputSchema: {
        target: z.string().describe("Phone, user JID, or group JID."),
        type: z.enum(["preview", "image"]).optional(),
      },
    },
    async ({ target, type }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = isGroupJid(target) ? target : toJid(target);
      try {
        const url = await (getSock() as any).profilePictureUrl(jid, type === "image" ? "image" : "preview");
        if (!url) return noteResult("No profile picture (or it is private).");
        return textResult({ jid, url });
      } catch (e: any) {
        // WhatsApp throws 404 when there is no picture / it's hidden
        return noteResult(`No accessible profile picture for ${jid} (${e?.message ?? e}).`);
      }
    },
  );

  server.registerTool(
    "wa_get_business_profile",
    {
      title: "Get business profile",
      description: "Fetch a business account's profile (description, category, email, website, hours).",
      inputSchema: { target: z.string().describe("Phone or JID of a business account.") },
    },
    async ({ target }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const profile = await getSock().getBusinessProfile(toJid(target));
        if (!profile) return noteResult("Not a business account (or no profile available).");
        return textResult(profile);
      } catch (e: any) {
        return errorResult(`business profile failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_subscribe_presence",
    {
      title: "Subscribe to presence",
      description:
        "Subscribe to a chat's presence so future presence.update events (online/typing) flow in. " +
        "This only registers interest; it returns immediately.",
      inputSchema: { target: z.string().describe("Phone or JID.") },
    },
    async ({ target }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = isGroupJid(target) ? target : toJid(target);
      try {
        await getSock().presenceSubscribe(jid);
        return noteResult(`Subscribed to presence for ${jid}.`);
      } catch (e: any) {
        return errorResult(`presence subscribe failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_send_presence",
    {
      title: "Send my presence",
      description:
        "Broadcast your presence. state = available | unavailable | composing (typing) | recording | paused. " +
        "Pass a target for chat-scoped states (composing/recording/paused); available/unavailable are global.",
      inputSchema: {
        state: z.enum(["available", "unavailable", "composing", "recording", "paused"]),
        target: z.string().optional().describe("Phone or JID (required for typing/recording)."),
      },
    },
    async ({ state, target }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const jid = target ? (isGroupJid(target) ? target : toJid(target)) : undefined;
      try {
        await getSock().sendPresenceUpdate(state, jid as any);
        return noteResult(`Presence "${state}"${jid ? ` to ${jid}` : ""} sent.`);
      } catch (e: any) {
        return errorResult(`send presence failed: ${e?.message ?? e}`);
      }
    },
  );
}
