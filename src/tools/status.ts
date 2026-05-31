// Connection + login tools.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import { rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config";
import { conn } from "../whatsapp/connection";
import { listScheduled, stats } from "../store/db";
import { sendStats } from "../whatsapp/send";
import { getRestriction, setSendRestricted } from "../whatsapp/sendguard";
import { errorResult, noteResult, textResult } from "./util";

// ANSI-free QR for terminals. The `qrcode` lib's "terminal" renderer wraps every
// row in ANSI color escapes (\x1b[47m white-bg, \x1b[30m black-fg) so it stays
// black-on-white on any theme — but those escapes survive as literal garbage when
// piped through an MCP text result into a terminal agent (e.g. Claude Code),
// shredding the QR. We render straight from the module matrix with no escapes.
// Orientation is tuned for a DARK terminal background (Claude Code's default):
// dark modules → blank (shows the dark bg), light modules + quiet zone → █ blocks
// (shows the light fg). On a light-background terminal this inverts — use the PNG.
function qrToAscii(text: string): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const { size, data } = qr.modules;
  const QUIET = 2; // light border QR scanners require
  const DARK = "  "; // dark module: two blanks (two-wide keeps the aspect square)
  const LIGHT = "██"; // light module / quiet zone: solid blocks
  const rows: string[] = [];
  for (let y = -QUIET; y < size + QUIET; y++) {
    let row = "";
    for (let x = -QUIET; x < size + QUIET; x++) {
      const inside = y >= 0 && y < size && x >= 0 && x < size;
      const isDark = inside && data[y * size + x] === 1;
      row += isDark ? DARK : LIGHT;
    }
    rows.push(row);
  }
  return rows.join("\n");
}

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
      description:
        "Return the current login QR (first-time login when no pairing number is set). Default writes a " +
        "scannable PNG to disk AND returns an ascii preview + an inline image, so it works in any client " +
        "(terminal agents like Claude Code, Claude Desktop, etc.). Use format to force one representation.",
      inputSchema: {
        format: z
          .enum(["auto", "png", "ascii", "dataurl", "raw"])
          .optional()
          .describe(
            "auto (default): save PNG + ascii preview + inline image. png: save file, return path. " +
              "ascii: ANSI-free text QR. dataurl: base64 data URL. raw: the underlying QR string.",
          ),
      },
    },
    async ({ format }) => {
      if (conn.state === "open") return errorResult("already logged in");
      if (!conn.qr) return errorResult("no QR available yet — wait a moment and retry, or check wa_status");
      const fmt = format ?? "auto";
      if (fmt === "raw") return noteResult(conn.qr);
      if (fmt === "dataurl") return noteResult(await QRCode.toDataURL(conn.qr));
      if (fmt === "ascii") {
        return noteResult(`Scan with WhatsApp > Linked Devices (open the PNG via 'auto' if this won't scan):\n\n${qrToAscii(conn.qr)}`);
      }

      // png / auto: write a real black-on-white image — the only representation
      // guaranteed to scan regardless of terminal theme or ANSI handling.
      const pngPath = join(config.dataDir, "login-qr.png");
      await QRCode.toFile(pngPath, conn.qr, { width: 512, margin: 2 });

      if (fmt === "png") {
        return noteResult(`Saved login QR to:\n${pngPath}\n\nOpen it and scan with WhatsApp > Linked Devices. (macOS: \`open "${pngPath}"\`)`);
      }

      // auto: hand back everything so it renders in whatever client is in use.
      const b64 = (await readFile(pngPath)).toString("base64");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Scan with WhatsApp > Linked Devices. Three ways, use whichever shows:\n` +
              `1. Open the saved image: ${pngPath}  (macOS: open "${pngPath}")\n` +
              `2. The inline image below (renders in Claude Desktop and image-capable clients).\n` +
              `3. The ascii preview below (tuned for a dark terminal; if it looks inverted, use the PNG).\n\n` +
              qrToAscii(conn.qr),
          },
          { type: "image" as const, data: b64, mimeType: "image/png" },
        ],
      };
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
