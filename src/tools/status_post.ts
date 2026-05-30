// Status / Story posting.
//
// Two complementary tools:
//   wa_post_status     — post to "My Status" and MENTION up to 5 JIDs (overlay
//                        mentions). Uses the older sock.sendStatusMentions.
//   wa_post_status_to  — post a status with an explicit AUDIENCE (jidList of
//                        contacts AND/OR groups). Uses the fork's StatusHelper
//                        (rich text backgrounds + fonts, image/video/gif/audio).
//
// Multi-Device note: a status@broadcast post is only visible to the contacts in
// the jidList. Groups can be targeted directly by including a @g.us jid —
// StatusHelper.send handles both cases.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import * as Baileys from "@innovatorssoft/baileys";
import { getSock, notReady } from "../whatsapp/connection";
import { sendBlocked } from "../whatsapp/sendguard";
import { errorResult, textResult } from "./util";

function media(src: string): { url: string } | Buffer {
  return /^https?:\/\//i.test(src) ? { url: src } : readFileSync(src);
}

// StatusHelper's media factories want a Buffer | string. Local path -> Buffer;
// URL -> fetched into a Buffer (Bun ships global fetch) so we always hand it bytes.
async function toBuffer(src: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${res.status} for ${src}`);
    return Buffer.from(await res.arrayBuffer());
  }
  return readFileSync(src);
}

// Resolve a background to a hex string. Accepts:
//   "#RRGGBB" / "RRGGBB"        -> used as-is
//   "solid.purple" / "gradient.sunset" -> looked up (gradient -> first colour)
//   "purple"                    -> tries solid, then gradient, then top-level
function resolveBackground(input?: string): string | undefined {
  if (!input) return undefined;
  if (input.startsWith("#")) return input;
  if (/^[0-9a-fA-F]{6}$/.test(input)) return `#${input}`;
  const BG: any = (Baileys as any).STATUS_BACKGROUNDS;
  if (!BG) return input;
  let v: any;
  if (input.includes(".")) {
    const [grp, name] = input.split(".");
    v = BG?.[grp]?.[name];
  } else {
    v = BG?.solid?.[input] ?? BG?.gradient?.[input] ?? BG?.[input];
  }
  if (Array.isArray(v)) return v[0]; // gradient pair -> first colour
  if (typeof v === "string") return v;
  return input; // unknown token: pass through
}

// Resolve a font to its numeric index. Accepts a number, an exact STATUS_FONTS
// key (e.g. "DANCINGSCRIPT_REGULAR"), or a fuzzy name ("DANCING").
function resolveFont(input?: number | string): number | undefined {
  if (input == null) return undefined;
  if (typeof input === "number") return input;
  const RAW: any = (Baileys as any).STATUS_FONTS;
  const FONTS: any = RAW?.data ?? RAW;
  if (FONTS && typeof FONTS === "object") {
    const keys = Object.keys(FONTS);
    const up = input.toUpperCase();
    const exact = keys.find((k) => k.toUpperCase() === up);
    if (exact) return FONTS[exact];
    const fuzzy = keys.find((k) => k.toUpperCase().includes(up));
    if (fuzzy) return FONTS[fuzzy];
  }
  const n = Number(input);
  return Number.isFinite(n) ? n : undefined;
}

export function registerStatusPostTools(server: McpServer): void {
  server.registerTool(
    "wa_post_status",
    {
      title: "Post a status (story) with mentions",
      description:
        "Post to My Status mentioning up to 5 JIDs. kind=text|image|video|audio. For media, `source` is a URL or local path.",
      inputSchema: {
        kind: z.enum(["text", "image", "video", "audio"]),
        jids: z.array(z.string()).min(1).describe("JIDs to mention (max 5 are used)."),
        text: z.string().optional().describe("text kind: the status text."),
        source: z.string().optional().describe("media kinds: URL or local file path."),
        caption: z.string().optional(),
        font: z.number().int().optional().describe("text kind: font index."),
        textColor: z.string().optional().describe("text kind: e.g. FF0000."),
        backgroundColor: z.string().optional().describe("text/audio kind: e.g. #000000."),
        mimetype: z.string().optional().describe("audio kind."),
        ptt: z.boolean().optional().describe("audio kind: voice-note style."),
      },
    },
    async (a) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);

      const jids = a.jids.slice(0, 5);
      const dropped = a.jids.length - jids.length;

      let content: any;
      try {
        switch (a.kind) {
          case "text":
            if (!a.text) return errorResult("text status needs `text`");
            content = { text: a.text, font: a.font, textColor: a.textColor, backgroundColor: a.backgroundColor };
            break;
          case "image":
            if (!a.source) return errorResult("image status needs `source`");
            content = { image: media(a.source), caption: a.caption };
            break;
          case "video":
            if (!a.source) return errorResult("video status needs `source`");
            content = { video: media(a.source), caption: a.caption };
            break;
          case "audio":
            if (!a.source) return errorResult("audio status needs `source`");
            content = {
              audio: media(a.source),
              backgroundColor: a.backgroundColor,
              mimetype: a.mimetype ?? "audio/mp4",
              ptt: a.ptt ?? true,
            };
            break;
        }
        const sock: any = getSock();
        if (typeof sock.sendStatusMentions !== "function")
          return errorResult("sendStatusMentions not available in this Baileys version");
        const result = await sock.sendStatusMentions(content, jids);
        return textResult(
          { messageId: result?.key?.id ?? null, mentioned: jids, droppedOverLimit: dropped },
          `Posted status mentioning ${jids.length} JID(s)${dropped ? ` (dropped ${dropped} over the 5 limit)` : ""}.`,
        );
      } catch (e: any) {
        return errorResult(`status post failed: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_post_status_to",
    {
      title: "Post a status to a chosen audience (contacts + groups)",
      description:
        "Post a story visible ONLY to the JIDs in `audience` — contacts (…@s.whatsapp.net) and/or groups (…@g.us). " +
        "kind=text|image|video|gif|voiceNote|audio. text supports rich background + font. " +
        "background accepts a hex ('#RRGGBB') OR a named token ('solid.purple', 'gradient.sunset', or 'purple'). " +
        "font accepts an index OR a name ('DANCING', 'SERIF'). Honors the send kill-switch.",
      inputSchema: {
        kind: z.enum(["text", "image", "video", "gif", "voiceNote", "audio"]),
        audience: z
          .array(z.string())
          .min(1)
          .describe("Who can see it: contact JIDs and/or group JIDs. Only these recipients receive the status."),
        text: z.string().optional().describe("text kind: the status text."),
        source: z.string().optional().describe("media kinds: URL or local file path."),
        caption: z.string().optional().describe("media kinds (not voiceNote)."),
        background: z.string().optional().describe("text kind: hex or named (solid.purple / gradient.sunset / purple)."),
        font: z.union([z.number().int(), z.string()]).optional().describe("text kind: index or name (e.g. DANCING)."),
        textColor: z.string().optional().describe("text kind: e.g. #FFFFFF."),
      },
    },
    async (a) => {
      const restricted = sendBlocked();
      if (restricted) return errorResult(restricted);
      const blocked = notReady();
      if (blocked) return errorResult(blocked);

      const SH: any = (Baileys as any).StatusHelper;
      if (!SH || typeof SH.send !== "function")
        return errorResult("StatusHelper not available in this Baileys version");

      try {
        let content: any;
        switch (a.kind) {
          case "text": {
            if (!a.text) return errorResult("text status needs `text`");
            content = SH.text(a.text, resolveBackground(a.background), resolveFont(a.font), a.textColor);
            break;
          }
          case "image":
            if (!a.source) return errorResult("image status needs `source`");
            content = SH.image(await toBuffer(a.source), a.caption);
            break;
          case "video":
            if (!a.source) return errorResult("video status needs `source`");
            content = SH.video(await toBuffer(a.source), a.caption);
            break;
          case "gif":
            if (!a.source) return errorResult("gif status needs `source`");
            content = SH.gif(await toBuffer(a.source), a.caption);
            break;
          case "voiceNote":
            if (!a.source) return errorResult("voiceNote status needs `source`");
            content = SH.voiceNote(await toBuffer(a.source));
            break;
          case "audio":
            if (!a.source) return errorResult("audio status needs `source`");
            content = SH.audio(await toBuffer(a.source), a.caption);
            break;
        }
        const result = await SH.send(getSock(), content, a.audience);
        const groups = a.audience.filter((j) => j.endsWith("@g.us")).length;
        return textResult(
          {
            messageId: result?.key?.id ?? null,
            audience: a.audience.length,
            groups,
            contacts: a.audience.length - groups,
          },
          `Status posted to ${a.audience.length} recipient(s)${groups ? ` (${groups} group${groups > 1 ? "s" : ""})` : ""}.`,
        );
      } catch (e: any) {
        return errorResult(`status post failed: ${e?.message ?? e}`);
      }
    },
  );
}
