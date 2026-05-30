// Commerce / catalog send-side tools. IMPORTANT: this fork exposes NO catalog
// READ APIs (no getCatalog/getCollections/getOrderDetails). Only message SENDS
// exist, and product/order messages generally render correctly only when the
// account is a WhatsApp **Business** account. These are best-effort wrappers:
// they route through safeSend (target validation + kill-switch + pacing) and
// surface any server error verbatim.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { safeSend } from "../whatsapp/send";
import { phoneToJid } from "../whatsapp/jid";
import { errorResult, textResult } from "./util";

export function registerCommerceTools(server: McpServer): void {
  server.registerTool(
    "wa_send_product",
    {
      title: "Send a product message",
      description:
        "Send a catalog product card. Best-effort: usually requires a Business account to render. " +
        "priceAmount1000 is the price × 1000 (e.g. 28300000 = 28,300.00).",
      inputSchema: {
        target: z.string().describe("Destination phone or JID."),
        productId: z.string().describe("Catalog product id."),
        title: z.string(),
        description: z.string().optional(),
        imageUrl: z.string().describe("Product image URL."),
        currencyCode: z.string().describe("e.g. USD, IDR, MYR."),
        priceAmount1000: z.union([z.string(), z.number()]).describe("Price × 1000."),
        retailerId: z.string().optional(),
        url: z.string().optional().describe("Product web URL."),
        businessOwnerJid: z.string().optional().describe("Owner JID; defaults to the target."),
        caption: z.string().optional(),
        footer: z.string().optional(),
      },
    },
    async (a) => {
      const owner = a.businessOwnerJid
        ? a.businessOwnerJid.includes("@")
          ? a.businessOwnerJid
          : phoneToJid(a.businessOwnerJid)
        : a.target.includes("@")
          ? a.target
          : phoneToJid(a.target);
      const content: any = {
        product: {
          productImage: { url: a.imageUrl },
          productId: a.productId,
          title: a.title,
          description: a.description,
          currencyCode: a.currencyCode,
          priceAmount1000: String(a.priceAmount1000),
          retailerId: a.retailerId,
          url: a.url,
          productImageCount: 1,
        },
        businessOwnerJid: owner,
        caption: a.caption,
        footer: a.footer,
      };
      const res = await safeSend(a.target, content);
      return res.ok ? textResult(res, "Product sent.") : errorResult(res.error);
    },
  );

  server.registerTool(
    "wa_send_order",
    {
      title: "Send an order message",
      description:
        "Send an order summary card. Best-effort (Business-oriented). totalAmount1000 is the total × 1000.",
      inputSchema: {
        target: z.string().describe("Destination phone or JID."),
        orderId: z.string(),
        orderTitle: z.string(),
        itemCount: z.union([z.string(), z.number()]).describe("Number of items."),
        status: z.enum(["INQUIRY", "ACCEPTED", "DECLINED"]).optional(),
        message: z.string().optional().describe("Caption."),
        token: z.string().optional(),
        sellerJid: z.string().optional(),
        totalAmount1000: z.union([z.string(), z.number()]).optional(),
        totalCurrencyCode: z.string().optional().describe("e.g. USD, MYR."),
      },
    },
    async (a) => {
      const content: any = {
        order: {
          orderId: a.orderId,
          itemCount: String(a.itemCount),
          status: a.status ?? "INQUIRY",
          surface: "CATALOG",
          message: a.message,
          orderTitle: a.orderTitle,
          sellerJid: a.sellerJid,
          token: a.token,
          totalAmount1000: a.totalAmount1000 != null ? String(a.totalAmount1000) : undefined,
          totalCurrencyCode: a.totalCurrencyCode,
        },
      };
      const res = await safeSend(a.target, content);
      return res.ok ? textResult(res, "Order sent.") : errorResult(res.error);
    },
  );
}
