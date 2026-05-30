// Call control. WhatsApp-web can reject incoming calls; outgoing call media is
// not supported by the fork (initiateCall is deprecated / signaling-only), so we
// expose reject only. callId + callFrom come from the `call` event.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getSock, notReady } from "../whatsapp/connection";
import { errorResult, noteResult } from "./util";

export function registerCallTools(server: McpServer): void {
  server.registerTool(
    "wa_reject_call",
    {
      title: "Reject an incoming call",
      description: "Reject a ringing call. Get callId and callFrom from the incoming 'call' event / notification.",
      inputSchema: {
        callId: z.string().describe("The call id."),
        callFrom: z.string().describe("The caller JID."),
      },
    },
    async ({ callId, callFrom }) => {
      const blocked = notReady();
      if (blocked) return errorResult(blocked);
      const sock: any = getSock();
      if (typeof sock.rejectCall !== "function")
        return errorResult("rejectCall not available in this Baileys version");
      try {
        await sock.rejectCall(callId, callFrom);
        return noteResult(`Rejected call ${callId} from ${callFrom}.`);
      } catch (e: any) {
        return errorResult(`reject call failed: ${e?.message ?? e}`);
      }
    },
  );
}
