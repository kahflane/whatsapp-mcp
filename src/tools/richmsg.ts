// Rich message types that route through safeSend (so they inherit target
// validation, the send kill-switch, and anti-ban pacing): location, contact
// card(s), poll, and event. Forward/pin live in write.ts because they need a
// stored message key.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { safeSend } from "../whatsapp/send";
import { getMessageRawAnyChat, getPollVotes } from "../store/db";
import { resolveName } from "../whatsapp/names";
import { errorResult, textResult } from "./util";

// WhatsApp identifies a chosen poll option by SHA256(optionName). Build a
// hex(digest) -> optionName map from the original poll-creation message.
function pollOptionHashMap(pollMessage: any): Map<string, string> {
  const pc =
    pollMessage?.pollCreationMessage ??
    pollMessage?.pollCreationMessageV2 ??
    pollMessage?.pollCreationMessageV3 ??
    null;
  const map = new Map<string, string>();
  for (const opt of pc?.options ?? []) {
    const name = opt?.optionName;
    if (!name) continue;
    map.set(createHash("sha256").update(Buffer.from(name)).digest("hex"), name);
  }
  return map;
}

// Build a minimal RFC-ish vCard for a contact card.
function vcard(name: string, phone: string): string {
  const digits = phone.replace(/[^0-9]/g, "");
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${name}`,
    `TEL;type=CELL;type=VOICE;waid=${digits}:+${digits}`,
    "END:VCARD",
  ].join("\n");
}

export function registerRichMessageTools(server: McpServer): void {
  server.registerTool(
    "wa_send_location",
    {
      title: "Send a location",
      description: "Send a static location pin.",
      inputSchema: {
        target: z.string().describe("Phone or JID."),
        latitude: z.number(),
        longitude: z.number(),
        name: z.string().optional().describe("Place name."),
        address: z.string().optional(),
        quotedId: z.string().optional(),
      },
    },
    async ({ target, latitude, longitude, name, address }) => {
      const content: any = {
        location: { degreesLatitude: latitude, degreesLongitude: longitude, name, address },
      };
      const res = await safeSend(target, content);
      return res.ok ? textResult(res, "Location sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_send_contact",
    {
      title: "Send contact card(s)",
      description: "Send one or more contact cards (name + phone each).",
      inputSchema: {
        target: z.string().describe("Phone or JID."),
        contacts: z
          .array(z.object({ name: z.string().min(1), phone: z.string().min(3) }))
          .min(1)
          .describe("Contacts to share."),
        displayName: z.string().optional().describe("Label when sending multiple."),
      },
    },
    async ({ target, contacts, displayName }) => {
      const content: any = {
        contacts: {
          displayName: displayName ?? (contacts.length === 1 ? contacts[0].name : `${contacts.length} contacts`),
          contacts: contacts.map((c) => ({ vcard: vcard(c.name, c.phone) })),
        },
      };
      const res = await safeSend(target, content);
      return res.ok ? textResult(res, `Sent ${contacts.length} contact(s).`) : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_send_poll",
    {
      title: "Send a poll",
      description: "Send a poll with a question and 2+ options.",
      inputSchema: {
        target: z.string().describe("Phone or JID."),
        question: z.string().min(1),
        options: z.array(z.string().min(1)).min(2).describe("Poll options (2+)."),
        selectableCount: z.number().int().min(1).optional().describe("How many a voter may pick (default 1)."),
      },
    },
    async ({ target, question, options, selectableCount }) => {
      const content: any = {
        poll: { name: question, values: options, selectableCount: selectableCount ?? 1 },
      };
      const res = await safeSend(target, content);
      return res.ok ? textResult(res, "Poll sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_send_event",
    {
      title: "Send an event",
      description: "Send an event card. startTime/endTime are unix seconds (or omit endTime).",
      inputSchema: {
        target: z.string().describe("Phone or JID."),
        name: z.string().min(1),
        startTime: z.number().int().describe("Unix seconds for the event start."),
        endTime: z.number().int().optional(),
        description: z.string().optional(),
        location: z.string().optional().describe("Location name/address text."),
      },
    },
    async ({ target, name, startTime, endTime, description, location }) => {
      const content: any = {
        event: {
          name,
          startTime,
          ...(endTime ? { endTime } : {}),
          ...(description ? { description } : {}),
          ...(location ? { location: { name: location } } : {}),
        },
      };
      const res = await safeSend(target, content);
      return res.ok ? textResult(res, "Event sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_get_poll_votes",
    {
      title: "Get poll results",
      description:
        "Aggregate the votes on a poll you sent or received. Votes are captured live as they " +
        "arrive, so this only reflects votes seen while the server was connected. Pass the poll " +
        "message id (the id of the original poll message).",
      inputSchema: {
        pollId: z.string().min(1).describe("Message id of the original poll."),
      },
    },
    async ({ pollId }) => {
      const pollMsg = getMessageRawAnyChat(pollId);
      if (!pollMsg?.message)
        return errorResult(`No stored poll message with id ${pollId}.`);
      const hashMap = pollOptionHashMap(pollMsg.message);
      if (hashMap.size === 0)
        return errorResult(`Message ${pollId} is not a poll (no options found).`);

      // tally: optionName -> voter jids
      const tally = new Map<string, string[]>();
      for (const name of hashMap.values()) tally.set(name, []);

      const rows = getPollVotes(pollId);
      for (const row of rows) {
        let selected: string[] = [];
        try {
          selected = JSON.parse(row.options) as string[];
        } catch {
          continue;
        }
        for (const b64 of selected) {
          const hex = Buffer.from(b64, "base64").toString("hex");
          const name = hashMap.get(hex);
          if (name) tally.get(name)!.push(row.voter_jid);
        }
      }

      const pc =
        pollMsg.message.pollCreationMessage ??
        pollMsg.message.pollCreationMessageV2 ??
        pollMsg.message.pollCreationMessageV3 ??
        {};
      const results = await Promise.all(
        [...tally.entries()].map(async ([option, voters]) => ({
          option,
          count: voters.length,
          voters: await Promise.all(voters.map((v) => resolveName(v))),
        })),
      );

      return textResult(
        {
          pollId,
          question: pc?.name ?? null,
          totalVoters: rows.length,
          results,
        },
        `${rows.length} voter(s) seen across ${results.length} option(s).`,
      );
    },
  );
}
