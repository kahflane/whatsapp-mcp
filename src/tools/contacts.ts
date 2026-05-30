// Contact / name resolution tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listContacts } from "../store/db";
import { conn, getSock, notReady } from "../whatsapp/connection";
import { getGroupMetadataCached } from "../whatsapp/groupcache";
import { isGroupJid, jidToDisplayPhone, phoneToJid } from "../whatsapp/jid";
import { resolveName, resolveNameWithSource } from "../whatsapp/names";
import { errorResult, textResult } from "./util";

export function registerContactTools(server: McpServer): void {
  server.registerTool(
    "wa_list_contacts",
    {
      title: "List contacts",
      description: "List/search known contacts with resolved display names.",
      inputSchema: {
        query: z.string().optional().describe("Filter by name/notify/number substring."),
        limit: z.number().int().min(1).max(500).optional().describe("Max rows (default 50)."),
      },
    },
    async ({ query, limit }) => {
      const rows = listContacts(query, limit ?? 50);
      return textResult(
        rows.map((c) => ({
          jid: c.jid,
          name: c.notify ?? c.verified_name ?? c.name ?? jidToDisplayPhone(c.jid),
          notify: c.notify,
          verifiedName: c.verified_name,
          phone: c.phone ?? jidToDisplayPhone(c.jid),
        })),
        `${rows.length} contact(s).`,
      );
    },
  );

  server.registerTool(
    "wa_resolve_name",
    {
      title: "Resolve name",
      description: "Resolve a single phone number or JID to a human name (with the source of the name).",
      inputSchema: { target: z.string().describe("A phone number or a JID.") },
    },
    async ({ target }) => {
      const jid = isGroupJid(target) ? target : phoneToJid(target);
      const res = await resolveNameWithSource(jid);
      return textResult(res, `${res.name} (via ${res.source})`);
    },
  );

  server.registerTool(
    "wa_check_number",
    {
      title: "Check numbers on WhatsApp",
      description: "Validate one or more phone numbers are on WhatsApp and return their canonical JIDs (anti-ban precheck before sending).",
      inputSchema: { phones: z.array(z.string()).min(1).describe("Phone numbers to check.") },
    },
    async ({ phones }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const out: { input: string; exists: boolean; jid: string | null }[] = [];
      for (const p of phones) {
        const jid = phoneToJid(p);
        try {
          const res = await (getSock() as any).onWhatsApp(jid);
          const hit = res?.[0];
          out.push({ input: p, exists: !!hit?.exists, jid: hit?.jid ?? null });
        } catch (e: any) {
          out.push({ input: p, exists: false, jid: null });
        }
      }
      return textResult(out);
    },
  );

  server.registerTool(
    "wa_get_group_members",
    {
      title: "Get group members",
      description: "List a group's participants with resolved names + admin flags.",
      inputSchema: { groupJid: z.string().describe("The group JID (…@g.us).") },
    },
    async ({ groupJid }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      if (!isGroupJid(groupJid)) return errorResult("not a group JID (expected …@g.us)");
      try {
        const meta = await getGroupMetadataCached(groupJid);
        const members = await Promise.all(
          meta.participants.map(async (p: any) => ({
            jid: p.id,
            name: await resolveName(p.id),
            isAdmin: p.admin === "admin" || p.admin === "superadmin",
          })),
        );
        return textResult({ subject: meta.subject, size: members.length, members });
      } catch (e: any) {
        return errorResult(`could not fetch group metadata: ${e?.message ?? e}`);
      }
    },
  );
}
