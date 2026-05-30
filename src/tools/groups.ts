// Group management tools. These wrap the fork's group.* socket methods.
// Read-only queries (metadata, list, invite info) work whenever connected;
// mutating actions require the bot to be a group admin (WhatsApp enforces this
// server-side and returns an error we surface verbatim).
//
// Note: these are group ADMIN actions, not chat message sends, so they are
// gated by notReady() but NOT by the send kill-switch (which governs outbound
// messages). Creating a group does not post chat content.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { getGroupMetadataCached } from "../whatsapp/groupcache";
import { isGroupJid, phoneToJid } from "../whatsapp/jid";
import { resolveName } from "../whatsapp/names";
import { errorResult, noteResult, textResult } from "./util";

// Turn a list of phone numbers / JIDs into sendable user JIDs.
function toJids(people: string[]): string[] {
  return people.map((p) => (p.includes("@") ? p : phoneToJid(p)));
}

function requireGroup(jid: string): string | null {
  return isGroupJid(jid) ? null : "not a group JID (expected …@g.us)";
}

export function registerGroupTools(server: McpServer): void {
  // ---- create ----
  server.registerTool(
    "wa_create_group",
    {
      title: "Create group",
      description: "Create a new group with a subject and an initial participant list (phones or JIDs).",
      inputSchema: {
        subject: z.string().min(1).describe("Group name."),
        participants: z.array(z.string()).min(1).describe("Phone numbers or JIDs to add."),
      },
    },
    async ({ subject, participants }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const g: any = await getSock().groupCreate(subject, toJids(participants));
        return textResult({ id: g?.id ?? g?.gid ?? null, subject }, `Created group "${subject}".`);
      } catch (e: any) {
        return errorResult(`create group failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- participants add/remove/promote/demote ----
  server.registerTool(
    "wa_group_participants",
    {
      title: "Add / remove / promote / demote members",
      description: "Modify a group's participants. action = add | remove | promote | demote. Requires admin.",
      inputSchema: {
        groupJid: z.string().describe("The group JID (…@g.us)."),
        participants: z.array(z.string()).min(1).describe("Phones or JIDs to act on."),
        action: z.enum(["add", "remove", "promote", "demote"]),
      },
    },
    async ({ groupJid, participants, action }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        const res = await getSock().groupParticipantsUpdate(groupJid, toJids(participants), action);
        return textResult({ action, result: res }, `${action} done for ${participants.length} member(s).`);
      } catch (e: any) {
        return errorResult(`participants ${action} failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- subject ----
  server.registerTool(
    "wa_group_update_subject",
    {
      title: "Change group subject",
      description: "Rename a group. Requires admin.",
      inputSchema: { groupJid: z.string(), subject: z.string().min(1) },
    },
    async ({ groupJid, subject }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupUpdateSubject(groupJid, subject);
        return noteResult(`Subject set to "${subject}".`);
      } catch (e: any) {
        return errorResult(`update subject failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- description ----
  server.registerTool(
    "wa_group_update_description",
    {
      title: "Change group description",
      description: "Set a group's description (pass empty string to clear). Requires admin.",
      inputSchema: { groupJid: z.string(), description: z.string() },
    },
    async ({ groupJid, description }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupUpdateDescription(groupJid, description);
        return noteResult("Description updated.");
      } catch (e: any) {
        return errorResult(`update description failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- settings ----
  server.registerTool(
    "wa_group_setting",
    {
      title: "Change group settings",
      description:
        "announcement = only admins can message; not_announcement = everyone can message; " +
        "locked = only admins edit group info; unlocked = everyone edits. Requires admin.",
      inputSchema: {
        groupJid: z.string(),
        setting: z.enum(["announcement", "not_announcement", "locked", "unlocked"]),
      },
    },
    async ({ groupJid, setting }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupSettingUpdate(groupJid, setting);
        return noteResult(`Group setting set to "${setting}".`);
      } catch (e: any) {
        return errorResult(`group setting failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- leave ----
  server.registerTool(
    "wa_group_leave",
    {
      title: "Leave group",
      description: "Leave a group.",
      inputSchema: { groupJid: z.string(), confirm: z.boolean().describe("Must be true to proceed.") },
    },
    async ({ groupJid, confirm }) => {
      if (!confirm) return errorResult("set confirm:true to leave the group");
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupLeave(groupJid);
        return noteResult("Left the group.");
      } catch (e: any) {
        return errorResult(`leave failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- invite code get / revoke ----
  server.registerTool(
    "wa_group_invite_code",
    {
      title: "Get / revoke group invite link",
      description: "Return the group's invite code (link = https://chat.whatsapp.com/<code>). Set revoke:true to reset it.",
      inputSchema: { groupJid: z.string(), revoke: z.boolean().optional().describe("Reset the code first.") },
    },
    async ({ groupJid, revoke }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        const code = revoke
          ? await getSock().groupRevokeInvite(groupJid)
          : await getSock().groupInviteCode(groupJid);
        return textResult(
          { code, link: code ? `https://chat.whatsapp.com/${code}` : null, revoked: !!revoke },
          revoke ? "Invite link revoked & regenerated." : "Invite link.",
        );
      } catch (e: any) {
        return errorResult(`invite code failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- join by code ----
  server.registerTool(
    "wa_group_join",
    {
      title: "Join group by invite code",
      description: "Join a group using an invite code (the part after chat.whatsapp.com/).",
      inputSchema: { code: z.string().describe("Invite code only — no URL prefix.") },
    },
    async ({ code }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const clean = code.replace(/^https?:\/\/chat\.whatsapp\.com\//i, "").trim();
      try {
        const res = await getSock().groupAcceptInvite(clean);
        return textResult({ groupJid: res }, `Joined ${res}.`);
      } catch (e: any) {
        return errorResult(`join failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- info by code ----
  server.registerTool(
    "wa_group_info_by_code",
    {
      title: "Preview group by invite code",
      description: "Fetch a group's info from an invite code WITHOUT joining.",
      inputSchema: { code: z.string().describe("Invite code only — no URL prefix.") },
    },
    async ({ code }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const clean = code.replace(/^https?:\/\/chat\.whatsapp\.com\//i, "").trim();
      try {
        const info = await getSock().groupGetInviteInfo(clean);
        return textResult(info);
      } catch (e: any) {
        return errorResult(`info by code failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- metadata ----
  server.registerTool(
    "wa_group_metadata",
    {
      title: "Group metadata",
      description: "Full group info: subject, description, owner, settings, participant count.",
      inputSchema: { groupJid: z.string() },
    },
    async ({ groupJid }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        const m: any = await getGroupMetadataCached(groupJid);
        return textResult({
          id: m.id,
          subject: m.subject,
          description: m.desc ?? null,
          owner: m.owner ?? null,
          size: m.participants?.length ?? 0,
          announce: !!m.announce,
          restrict: !!m.restrict,
          memberAddMode: m.memberAddMode ?? null,
          ephemeralDuration: m.ephemeralDuration ?? null,
        });
      } catch (e: any) {
        return errorResult(`metadata failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- list all participating ----
  server.registerTool(
    "wa_groups_list",
    {
      title: "List all my groups",
      description: "Fetch metadata for every group the account participates in.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional().describe("Max groups (default 100).") },
    },
    async ({ limit }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      try {
        const all: any = await getSock().groupFetchAllParticipating();
        const rows = Object.values(all ?? {})
          .slice(0, limit ?? 100)
          .map((g: any) => ({
            id: g.id,
            subject: g.subject,
            size: g.participants?.length ?? 0,
            announce: !!g.announce,
          }));
        return textResult(rows, `${rows.length} group(s).`);
      } catch (e: any) {
        return errorResult(`list groups failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- join requests list ----
  server.registerTool(
    "wa_group_join_requests",
    {
      title: "List pending join requests",
      description: "List people waiting to join a group (admin only).",
      inputSchema: { groupJid: z.string() },
    },
    async ({ groupJid }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        const list: any = await getSock().groupRequestParticipantsList(groupJid);
        const rows = await Promise.all(
          (list ?? []).map(async (r: any) => ({ jid: r.jid ?? r.id, name: await resolveName(r.jid ?? r.id) })),
        );
        return textResult(rows, `${rows.length} pending request(s).`);
      } catch (e: any) {
        return errorResult(`join requests failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- approve / reject join requests ----
  server.registerTool(
    "wa_group_join_decision",
    {
      title: "Approve / reject join requests",
      description: "Approve or reject pending join requests (admin only).",
      inputSchema: {
        groupJid: z.string(),
        participants: z.array(z.string()).min(1).describe("Phones or JIDs to decide on."),
        decision: z.enum(["approve", "reject"]),
      },
    },
    async ({ groupJid, participants, decision }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        const res = await getSock().groupRequestParticipantsUpdate(groupJid, toJids(participants), decision);
        return textResult({ decision, result: res }, `${decision} done for ${participants.length} request(s).`);
      } catch (e: any) {
        return errorResult(`join decision failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- toggle ephemeral (disappearing) for the group ----
  server.registerTool(
    "wa_group_ephemeral",
    {
      title: "Group disappearing messages",
      description: "Set the group's disappearing-message timer in seconds (0 = off, 86400 = 24h, 604800 = 7d, 7776000 = 90d).",
      inputSchema: { groupJid: z.string(), seconds: z.number().int().min(0) },
    },
    async ({ groupJid, seconds }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupToggleEphemeral(groupJid, seconds);
        return noteResult(seconds ? `Disappearing messages set to ${seconds}s.` : "Disappearing messages turned off.");
      } catch (e: any) {
        return errorResult(`toggle ephemeral failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- member label ----
  server.registerTool(
    "wa_group_member_label",
    {
      title: "Set a group member label",
      description: "Set a custom label/tag for a group (max 30 chars). Requires admin.",
      inputSchema: { groupJid: z.string(), label: z.string().min(1).max(30) },
    },
    async ({ groupJid, label }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      const sock: any = getSock();
      if (typeof sock.updateMemberLabel !== "function")
        return errorResult("updateMemberLabel not available in this Baileys version");
      try {
        await sock.updateMemberLabel(groupJid, label);
        return noteResult(`Member label set to "${label}".`);
      } catch (e: any) {
        return errorResult(`member label failed: ${e?.message ?? e}`);
      }
    },
  );

  // ---- member add mode ----
  server.registerTool(
    "wa_group_add_mode",
    {
      title: "Group member add mode",
      description: "Who can add members: all_member_add (everyone) or admin_add (admins only).",
      inputSchema: { groupJid: z.string(), mode: z.enum(["all_member_add", "admin_add"]) },
    },
    async ({ groupJid, mode }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const ng = requireGroup(groupJid);
      if (ng) return errorResult(ng);
      try {
        await getSock().groupMemberAddMode(groupJid, mode);
        return noteResult(`Add mode set to "${mode}".`);
      } catch (e: any) {
        return errorResult(`add mode failed: ${e?.message ?? e}`);
      }
    },
  );
}
