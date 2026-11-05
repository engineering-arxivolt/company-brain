/**
 * Post eTIMS-compliant invoices to Slack with rich formatting.
 *
 * Builds Slack Block Kit messages containing invoice details, eTIMS invoice
 * number, QR code image, and action buttons. Uses the workspace's bot token
 * (stored encrypted in slack_workspace) to post via chat.postMessage.
 */

import { db } from "@repo/db"
import { slackWorkspace } from "@repo/db/schema/slack"
import { eq } from "drizzle-orm"
import { decryptToken } from "@/lib/crypto"
import { encryptionSecret } from "../../setup/secrets"
import { postSlackMessage } from "./client"
import type { ETimsSubmitResponse } from "../etims/oscue-client"

export interface EtimsInvoiceSlackPayload {
  orgId: string
  invoiceId: string
  customerName?: string | null
  customerTin?: string | null
  customerMobile?: string | null
  totTaxblAmt: number
  totTaxAmt: number
  totAmt: number
  status: string
  etimsInvoiceNo?: string | null
  etimsConfirmedAt?: string | null
  etimsQrCode?: string | null
  items?: Array<{
    itemNm: string
    qty: number
    prc: number
    totAmt: number
    taxAmt: number
  }>
  channel?: string
  threadTs?: string
}

function formatKes(amount: number): string {
  return `KES ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`
}

export function buildEtimsInvoiceBlocks(
  payload: EtimsInvoiceSlackPayload,
): { blocks: unknown[]; text: string } {
  const {
    invoiceId,
    customerName,
    customerTin,
    customerMobile,
    totTaxblAmt,
    totTaxAmt,
    totAmt,
    status,
    etimsInvoiceNo,
    etimsConfirmedAt,
    etimsQrCode,
    items,
  } = payload

  const statusEmoji =
    status === "etims_confirmed" ? "\u2705" : status === "draft" ? "\ud83d\udceb" : "\u26a0"
  const statusLabel = status.replace(/_/g, " ").toUpperCase()

  const blocks: unknown[] = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `\ud83d\udceb eTIMS Invoice: ${invoiceId}`,
        emoji: true,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Customer:*\n${customerName ?? "—"}` },
        { type: "mrkdwn", text: `*KRA PIN:*\n${customerTin ?? "—"}` },
        { type: "mrkdwn", text: `*Mobile:*\n${customerMobile ?? "—"}` },
        { type: "mrkdwn", text: `*Status:*\n${statusEmoji} ${statusLabel}` },
      ],
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*eTIMS Invoice No:*\n${etimsInvoiceNo ?? "pending"}` },
        { type: "mrkdwn", text: `*Confirmed At:*\n${etimsConfirmedAt ?? "—"}` },
        { type: "mrkdwn", text: `*Taxable:*\n${formatKes(totTaxblAmt)}` },
        { type: "mrkdwn", text: `*VAT:*\n${formatKes(totTaxAmt)}` },
      ],
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*Total:*\n*${formatKes(totAmt)}*`,
        },
      ],
    },
  ]

  if (items && items.length > 0) {
    const itemLines = items
      .map(
        (item) =>
          `• ${item.itemNm} — ${item.qty} × ${formatKes(item.prc)} = ${formatKes(item.totAmt)} (VAT ${formatKes(item.taxAmt)})`,
      )
      .join("\n")
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Items:*\n${itemLines}`,
      },
    })
  }

  if (etimsQrCode) {
    blocks.push({
      type: "image",
      image_url: etimsQrCode,
      alt_text: `eTIMS QR code for ${etimsInvoiceNo}`,
      title: {
        type: "plain_text",
        text: "eTIMS Verification QR Code",
        emoji: true,
      },
    })
  }

  const actions: unknown[] = []
  actions.push({
    type: "button",
    text: {
      type: "plain_text",
      text: "View Invoice",
      emoji: true,
    },
    action_id: "etims_view_invoice",
    value: invoiceId,
  })
  if (etimsInvoiceNo) {
    actions.push({
      type: "button",
      text: {
        type: "plain_text",
        text: "Verify with KRA",
        emoji: true,
      },
      action_id: "etims_verify_kra",
      value: etimsInvoiceNo,
      url: `https://etims.kra.go.ke/verify?invoiceNo=${etimsInvoiceNo}`,
    })
  }
  blocks.push({
    type: "actions",
    elements: actions,
  })

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Posted by Company Brain • ${new Date().toISOString()}`,
      },
    ],
  })

  const text = `eTIMS Invoice ${invoiceId} — ${statusLabel}\nCustomer: ${customerName ?? "—"} (${customerTin ?? "—"})\nTotal: ${formatKes(totAmt)}\neTIMS No: ${etimsInvoiceNo ?? "pending"}`

  return { blocks, text }
}

export async function getSlackBotTokenForOrg(
  env: Env,
  orgId: string,
): Promise<string | null> {
  const [row] = await db(env)
    .select({ botTokenEnc: slackWorkspace.botTokenEnc })
    .from(slackWorkspace)
    .where(eq(slackWorkspace.orgId, orgId))
    .limit(1)

  if (!row?.botTokenEnc) return null

  const secret = await encryptionSecret(env)
  return decryptToken(row.botTokenEnc, secret)
}

export async function postEtimsInvoiceToSlack(
  env: Env,
  orgId: string,
  payload: EtimsInvoiceSlackPayload,
): Promise<string | undefined> {
  const botToken = await getSlackBotTokenForOrg(env, orgId)
  if (!botToken) {
    console.warn(
      `[etims] no Slack bot token for org=${orgId}, cannot post invoice ${payload.invoiceId}`,
    )
    return undefined
  }

  const channel = payload.channel
  if (!channel) {
    console.warn(
      `[etims] no Slack channel specified for invoice ${payload.invoiceId}`,
    )
    return undefined
  }

  const { blocks, text } = buildEtimsInvoiceBlocks(payload)

  return postSlackMessage(botToken, channel, text, payload.threadTs, blocks)
}