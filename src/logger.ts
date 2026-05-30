// IMPORTANT: an MCP stdio server uses STDOUT for the JSON-RPC stream.
// A single byte written to stdout that isn't valid JSON-RPC corrupts the whole
// connection. So ALL logging must go to STDERR (file descriptor 2).
import pino from "pino";
import { config } from "./config";

export const logger = pino(
  { level: config.logLevel },
  pino.destination(2), // fd 2 = stderr
);
