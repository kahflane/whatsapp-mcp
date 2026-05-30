// Connection + login tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import { rmSync } from "node:fs";
import { config } from "../config";
import { conn } from "../whatsapp/connection";
import { listScheduled, stats } from "../store/db";
import { sendStats } from "../whatsapp/send";
import { getRestriction, setSendRestricted } from "../whatsapp/sendguard";
import { errorResult, noteResult, textResult } from "./util";

export function registerStatusTools(server: McpServer): void {
  server.registerTool(
    "wa_status",
    {
      title: "WhatsApp status",
      description: "Report connection + login state. Call this first to know whether other tools can act.",
      inputSchema: {},
    },
    async () => {
      const s = stats();
      return textResult(
        {
          state: conn.state,
          registered: conn.state === "open" || !!conn.me,
          me: conn.me,
          pendingNotificationsDone: conn.pendingDone,
          hasQR: !!conn.qr,
          hasPairingCode: !!conn.pairingCode,
          historyChunks: conn.historyChunks,
          lastError: conn.lastError,
          store: s,
          sends: sendStats(),
          sendRestricted: getRestriction(),
          scheduledPending: listScheduled("pending").length,
        },
        `WhatsApp is "${conn.state}".`,
      );
    },
  );

  server.registerTool(
    "wa_restrict_sending",
    {
      title: "Restrict / allow outbound sending",
      description:
        "Master kill-switch for ALL outbound actions (text, media, templates, buttons, scheduled, " +
        "reactions, edits, deletes, status posts, auto-reply). When enabled, the app refuses to send " +
        "anything — even if an AI agent calls a send tool. The restriction persists across restarts. " +
        "Set enabled:false to allow sending again. Reading/searching is never affected.",
      inputSchema: {
        enabled: z.boolean().describe("true = block all sending; false = allow sending again."),
        reason: z.string().optional().describe("Optional note shown whenever a blocked send is attempted."),
      },
    },
    async ({ enabled, reason }) => {
      const st = setSendRestricted(enabled, reason);
      return textResult(
        st,
        enabled
          ? "🔒 Sending is now RESTRICTED — no outbound messages will be sent (persists across restarts)."
          : "🔓 Restriction lifted — outbound sending is allowed again.",
      );
    },
  );

  server.registerTool(
    "wa_get_login_qr",
    {
      title: "Get login QR",
      description: "Return the current login QR code (first-time login when no pairing number is configured).",
      inputSchema: {
        format: z.enum(["ascii", "dataurl", "raw"]).optional().describe("Render format (default ascii)."),
      },
    },
    async ({ format }) => {
      if (conn.state === "open") return errorResult("already logged in");
      if (!conn.qr) return errorResult("no QR available yet — wait a moment and retry, or check wa_status");
      const fmt = format ?? "ascii";
      if (fmt === "raw") return noteResult(conn.qr);
      if (fmt === "dataurl") return noteResult(await QRCode.toDataURL(conn.qr));
      const ascii = await QRCode.toString(conn.qr, { type: "terminal", small: true });
      return noteResult(`Scan this with WhatsApp > Linked Devices:\n\n${ascii}`);
    },
  );

  server.registerTool(
    "wa_get_pairing_code",
    {
      title: "Get pairing code",
      description: "Return the 8-digit pairing code (headless login; requires WA_PAIRING_NUMBER to be set).",
      inputSchema: {},
    },
    async () => {
      if (conn.state === "open") return errorResult("already logged in");
      if (!config.pairingNumber)
        return errorResult("WA_PAIRING_NUMBER is not set — use wa_get_login_qr instead");
      if (!conn.pairingCode)
        return errorResult("pairing code not generated yet — wait a moment and retry");
      return textResult(
        { code: conn.pairingCode, number: config.pairingNumber },
        `Enter this code in WhatsApp > Linked Devices > Link with phone number: ${conn.pairingCode}`,
      );
    },
  );

  server.registerTool(
    "wa_logout",
    {
      title: "Log out",
      description: "Log out of WhatsApp and wipe local auth so the next start requires a fresh QR/pairing.",
      inputSchema: { confirm: z.boolean().describe("Must be true to proceed.") },
    },
    async ({ confirm }) => {
      if (!confirm) return errorResult("set confirm:true to log out");
      conn.intentionalLogout = true; // stop the close handler from reconnecting
      try {
        await conn.sock?.logout();
      } catch {
        /* ignore */
      }
      try {
        rmSync(config.authDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      conn.state = "logged_out";
      conn.me = null;
      return noteResult("Logged out and wiped local auth. Restart the server to log in again.");
    },
  );
}
