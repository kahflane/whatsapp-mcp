// Auto-reply tools. Off by default; enable explicitly.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  addRule,
  clearRules,
  isEnabled,
  listRules,
  removeRule,
  setEnabled,
  setRuleActive,
} from "../whatsapp/autoreply";
import { errorResult, noteResult, textResult } from "./util";

export function registerAutoReplyTools(server: McpServer): void {
  server.registerTool(
    "wa_autoreply_set",
    {
      title: "Enable/disable auto-reply",
      description: "Turn the keyword/pattern auto-replier on or off (off by default).",
      inputSchema: { enabled: z.boolean() },
    },
    async ({ enabled }) => {
      setEnabled(enabled);
      return noteResult(`Auto-reply is now ${enabled ? "ON" : "OFF"}.`);
    },
  );

  server.registerTool(
    "wa_autoreply_add_rule",
    {
      title: "Add auto-reply rule",
      description:
        "Add a rule. Provide ONE matcher (keywords / pattern / exactMatch) and a responseText. Rules are in-memory (reset on restart).",
      inputSchema: {
        responseText: z.string().min(1).describe("Reply to send when the rule matches."),
        keywords: z.array(z.string()).optional().describe("Substring keywords (case-insensitive)."),
        pattern: z.string().optional().describe("Regex source (applied case-insensitively)."),
        exactMatch: z.string().optional().describe("Exact message text to match."),
        quoted: z.boolean().optional().describe("Reply quoting the original message."),
        groupsOnly: z.boolean().optional(),
        privateOnly: z.boolean().optional(),
        cooldown: z.number().int().optional().describe("Per-JID cooldown in ms."),
        priority: z.number().int().optional().describe("Higher = checked first."),
        allowedJids: z.array(z.string()).optional().describe("Only fire for these JIDs."),
      },
    },
    async (args) => {
      if (!args.keywords && !args.pattern && !args.exactMatch)
        return errorResult("provide one matcher: keywords, pattern, or exactMatch");
      try {
        const rule = addRule(args);
        return textResult({ rule, enabled: isEnabled() }, "Rule added.");
      } catch (e: any) {
        return errorResult(`could not add rule: ${e?.message ?? e}`);
      }
    },
  );

  server.registerTool(
    "wa_autoreply_list_rules",
    {
      title: "List auto-reply rules",
      description: "List current auto-reply rules + enabled state.",
      inputSchema: {},
    },
    async () => textResult({ enabled: isEnabled(), rules: listRules() }),
  );

  server.registerTool(
    "wa_autoreply_remove_rule",
    {
      title: "Remove/toggle auto-reply rule",
      description: "Remove a rule by id, toggle its active state, or clear all rules.",
      inputSchema: {
        id: z.string().optional(),
        active: z.boolean().optional().describe("If set with id, toggles instead of removing."),
        clearAll: z.boolean().optional(),
      },
    },
    async ({ id, active, clearAll }) => {
      if (clearAll) {
        clearRules();
        return noteResult("Cleared all rules.");
      }
      if (!id) return errorResult("provide id (or clearAll)");
      if (active != null) {
        setRuleActive(id, active);
        return noteResult(`Rule ${id} ${active ? "activated" : "paused"}.`);
      }
      const ok = removeRule(id);
      return ok ? noteResult(`Removed ${id}.`) : errorResult(`no rule ${id}`);
    },
  );
}
