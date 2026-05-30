// Scheduled-message tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listScheduled } from "../store/db";
import { cancel, cancelForJid, scheduleAt, scheduleDelay } from "../whatsapp/scheduler";
import { errorResult, noteResult, textResult } from "./util";

export function registerScheduleTools(server: McpServer): void {
  server.registerTool(
    "wa_schedule_message",
    {
      title: "Schedule a message",
      description:
        "Schedule a text message to be sent later. Provide EITHER atISO (an absolute time) OR delaySeconds (relative). Survives a server restart. Sends go through the same validation + pacing as wa_send_text.",
      inputSchema: {
        target: z.string().describe("Phone number or JID."),
        text: z.string().min(1).describe("Message body."),
        atISO: z.string().optional().describe("Absolute send time, ISO 8601 (e.g. 2026-12-25T09:00:00)."),
        delaySeconds: z.number().int().min(1).optional().describe("Or: send this many seconds from now."),
      },
    },
    async ({ target, text, atISO, delaySeconds }) => {
      if (!atISO && delaySeconds == null) return errorResult("provide atISO or delaySeconds");
      try {
        let entry;
        if (atISO) {
          const when = new Date(atISO);
          if (isNaN(when.getTime())) return errorResult(`invalid atISO date: "${atISO}"`);
          entry = scheduleAt(target, { text }, when);
        } else {
          entry = scheduleDelay(target, { text }, delaySeconds! * 1000);
        }
        return textResult(
          { id: entry.id, jid: entry.jid, scheduledTime: entry.scheduledTime, status: entry.status ?? "pending" },
          `Scheduled (id: ${entry.id}).`,
        );
      } catch (e: any) {
        return errorResult(`could not schedule: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_list_scheduled",
    {
      title: "List scheduled messages",
      description: "List scheduled messages, optionally filtered by status.",
      inputSchema: {
        status: z.enum(["pending", "sent", "failed", "cancelled"]).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    async ({ status, limit }) => {
      const rows = listScheduled(status, limit ?? 200);
      return textResult(
        rows.map((r) => ({
          id: r.id,
          jid: r.jid,
          scheduledTime: r.scheduled_time,
          status: r.status,
          error: r.error,
          messageId: r.message_id,
        })),
        `${rows.length} scheduled entr(y/ies).`,
      );
    },
  );

  server.registerTool(
    "wa_cancel_scheduled",
    {
      title: "Cancel a scheduled message",
      description: "Cancel one scheduled message by id, or all pending for a target.",
      inputSchema: {
        id: z.string().optional().describe("Scheduled entry id."),
        target: z.string().optional().describe("Or: cancel all pending for this jid/number."),
      },
    },
    async ({ id, target }) => {
      if (id) {
        const ok = cancel(id);
        return ok ? noteResult(`Cancelled ${id}.`) : errorResult(`no pending entry with id ${id}`);
      }
      if (target) {
        const n = cancelForJid(target);
        return noteResult(`Cancelled ${n} pending message(s) for ${target}.`);
      }
      return errorResult("provide id or target");
    },
  );
}
