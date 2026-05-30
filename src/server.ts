// Builds the MCP server and registers every tool group.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerStatusTools } from "./tools/status";
import { registerContactTools } from "./tools/contacts";
import { registerChatTools } from "./tools/chats";
import { registerReadTools } from "./tools/read";
import { registerWriteTools } from "./tools/write";
import { registerScheduleTools } from "./tools/schedule";
import { registerTemplateTools } from "./tools/templates";
import { registerButtonTools } from "./tools/buttons";
import { registerAutoReplyTools } from "./tools/autoreply";
import { registerStatusPostTools } from "./tools/status_post";
import { registerGroupTools } from "./tools/groups";
import { registerChatMgmtTools } from "./tools/chatmgmt";
import { registerProfileTools } from "./tools/profile";
import { registerPrivacyTools } from "./tools/privacy";
import { registerUserTools } from "./tools/users";
import { registerRichMessageTools } from "./tools/richmsg";
import { registerCallTools } from "./tools/calls";
import { registerCommerceTools } from "./tools/commerce";
import { registerBroadcastTools } from "./tools/broadcast";

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "whatsapp-mcp", version: "0.1.0" },
    {
      instructions:
        "WhatsApp access via Baileys. Call wa_status first. If not connected, drive login with " +
        "wa_get_login_qr (or wa_get_pairing_code). Always wa_check_number before sending to a new number. " +
        "Reading/searching works offline from the local store; sending requires an open connection.",
    },
  );

  registerStatusTools(server);
  registerContactTools(server);
  registerChatTools(server);
  registerReadTools(server);
  registerWriteTools(server);
  registerScheduleTools(server);
  registerTemplateTools(server);
  registerButtonTools(server);
  registerAutoReplyTools(server);
  registerStatusPostTools(server);
  registerGroupTools(server);
  registerChatMgmtTools(server);
  registerProfileTools(server);
  registerPrivacyTools(server);
  registerUserTools(server);
  registerRichMessageTools(server);
  registerCallTools(server);
  registerCommerceTools(server);
  registerBroadcastTools(server);

  return server;
}
