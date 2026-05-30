// Entry point. Order matters:
//   1. open the SQLite store
//   2. start the WhatsApp socket + wire events (does NOT block on login)
//   3. connect the MCP stdio transport so Claude can drive login interactively
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { closeDb, initDb } from "./store/db";
import { initSendGuard } from "./whatsapp/sendguard";
import { startSocket } from "./whatsapp/socket";
import { initScheduler } from "./whatsapp/scheduler";
import { initAutoReply } from "./whatsapp/autoreply";
import { conn } from "./whatsapp/connection";
import { buildServer } from "./server";
import { logger } from "./logger";

async function main(): Promise<void> {
  initDb();
  initSendGuard(); // restore any persisted send restriction before we can send
  await startSocket();
  initScheduler();
  initAutoReply();

  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("whatsapp-mcp connected over stdio");
}

function shutdown(): void {
  logger.info("shutting down");
  try {
    (conn.sock?.ev as any)?.removeAllListeners();
  } catch {
    /* ignore */
  }
  try {
    conn.sock?.end(undefined);
  } catch {
    /* ignore */
  }
  try {
    closeDb(); // checkpoint WAL + close so committed rows aren't lost
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  logger.error({ e }, "fatal");
  process.exit(1);
});
