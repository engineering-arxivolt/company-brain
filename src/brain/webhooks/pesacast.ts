import { createHmac, timingSafeEqual } from "node:crypto"
import { z } from "zod"

// PesaCast phone webhook payload, per docs/webhooks.md and webhook-payload.schema.json.
// The Android app POSTs each parsed M-PESA transaction to a user-configured HTTPS URL.
// Delivery is at-least-once; the Idempotency-Key header (ref@time) lets receivers dedupe.
// The same fields are also sent to the desktop app over BLE/WiFi.

export const PESACAST_DIRECTIONS = [
	"received",
	"sent",
	"paid",
	"withdrawn",
	"airtime",
	"fuliza",
] as const

export type PesaCastDirection = (typeof PESACAST_DIRECTIONS)[number]

export const PesaCastTransactionSchema = z.object({
	type: z.literal("mpesa_txn"),
	direction: z.enum(PESACAST_DIRECTIONS),
	amount: z.string(),
	currency: z.string().default("KES"),
	from: z.string().nullable().optional(),
	recipient: z.string().nullable().optional(),
	ref: z.string().min(1),
	time: z.string().datetime().optional(),
	balance: z.string().nullable().optional(),
	transaction_cost: z.string().nullable().optional(),
})

export type PesaCastTransaction = z.infer<typeof PesaCastTransactionSchema>

export const PesaCastWebhookSchema = z.object({
	test: z.boolean().optional(),
	transactions: z.array(PesaCastTransactionSchema).default([]),
	device_id: z.string().optional(),
	source: z.enum(["android", "desktop"]).optional(),
})

export type PesaCastWebhook = z.infer<typeof PesaCastWebhookSchema>

/** Headers PesaCast sends on every webhook request. */
export type PesaCastWebhookHeaders = {
	idempotencyKey?: string | null
	timestamp?: string | null
	signature?: string | null
	deviceId?: string | null
}

/** Read the PesaCast webhook headers off a live request. */
export function pesacastWebhookHeadersFrom(
	headers: Headers,
): PesaCastWebhookHeaders {
	return {
		idempotencyKey: headers.get("idempotency-key"),
		timestamp: headers.get("x-pesacast-timestamp"),
		signature: headers.get("x-pesacast-signature"),
		deviceId: headers.get("x-pesacast-device-id"),
	}
}

/**
 * Verify a PesaCast webhook signature (HMAC-SHA256 over `timestamp.rawBody`).
 *
 * The app signs with `v1=` + hex(HMAC(secret, `${timestamp}.${body}`)). When no
 * signing secret is configured in the app, the bearer token is the only auth;
 * this function returns false and the caller should fall back to token auth.
 */
export function verifyPesacastSignature(
	rawBody: Uint8Array,
	headers: PesaCastWebhookHeaders,
	secret: string,
	nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
	const timestamp = headers.timestamp
	const signature = headers.signature
	if (!timestamp || !signature || !secret) return false

	const ts = Number(timestamp)
	if (!Number.isFinite(ts)) return false
	// Replay window: 5 minutes, matching the receiver guidance in docs/webhooks.md.
	if (Math.abs(nowSeconds - ts) > 60 * 5) return false

	const expected =
		"v1=" +
		createHmac("sha256", secret)
			.update(`${ts}.`)
			.update(rawBody)
			.digest("hex")

	const left = Buffer.from(signature)
	const right = Buffer.from(expected)
	if (left.length !== right.length) return false
	return timingSafeEqual(left, right)
}

// ── eTIMS invoice types (aligned with paybillke/kra-etims SDKs and KRA OSCU spec v2.0) ──
// These mirror the fields required by KRA's Electronic Tax Invoice Management System.
// Penalty for non-compliance: 2x the tax due (per Tax Procedures Regulations, 2024).

export type ETaxInvoiceCategory = "A" | "B" | "C" | "D" | "E"

export interface ETaxInvoiceItem {
	itemSeq: number // 1-999
	itemCd: string // 1-20 chars
	itemNm: string // 1-200 chars
	pkgUnitCd: string // 1-5 chars (unit code)
	pkg: number // quantity in packages
	qtyUnitCd: string // 1-5 chars (quantity unit code)
	qty: number // quantity
	prc: number // unit price
	splyAmt: number // supply amount
	dcRt?: number // discount rate
	dcAmt?: number // discount amount
	taxTyCd: string // 1-5 chars (tax type code)
	taxblAmt: number // taxable amount
	taxAmt: number // tax amount
	totAmt: number // total amount (splyAmt - dcAmt + taxAmt)
}

export interface ETaxInvoiceReceipt {
	rcptPbctDt: string // yyyyMMddHHmmss (14 digits)
	prchrAcptcYn: "Y" | "N"
	custTin?: string // 11 chars KRA PIN
	custMblNo?: string // max 20 chars
	trdeNm?: string // max 20 chars
	adrs?: string // max 200 chars
	topMsg?: string // max 20 chars
	btmMsg?: string // max 20 chars
}

export interface ETaxInvoicePayload {
	// Required
	invcNo: string // invoice number (no leading zeros)
	salesDt: string // yyyyMMdd (8 digits)
	cfmDt: string // yyyyMMddHHmmss (14 digits, must start with salesDt)
	taxblAmtA: number
	taxblAmtB: number
	taxblAmtC: number
	taxblAmtD: number
	taxblAmtE: number
	taxAmtA: number
	taxAmtB: number
	taxAmtC: number
	taxAmtD: number
	taxAmtE: number
	totTaxblAmt: number
	totTaxAmt: number
	totAmt: number
	prchrAcctcYn: "Y" | "N"
	regrId: string // 1-20 chars
	regrNm: string // 1-60 chars
	modrId: string // 1-20 chars
	modrNm: string // 1-60 chars
	receipt: ETaxInvoiceReceipt
	itemList: ETaxInvoiceItem[]

	// Optional
	custTin?: string // 11 chars KRA PIN
	custNm?: string // 1-60 chars
	pmtTyCd?: string // payment method code
	stockRlsDt?: string
	remark?: string // max 400 chars
}

export interface ETaxInvoiceResponse {
	// What KRA returns on successful submission
	invcNo: string // eTIMS invoice number
	cfmDt: string
	totAmt: number
	qrcode?: string // QR code image/data for verification
	resultCd: string
	resultMsg: string
}

// An invoice stored in company-brain, extended with eTIMS + M-PESA reconciliation state
export type ETaxInvoice = {
	id: string
	orgId: string
	customerTin?: string
	customerName?: string
	customerMobile?: string
	items: ETaxInvoiceItem[]
	receipt: ETaxInvoiceReceipt
	totTaxblAmt: number
	totTaxAmt: number
	totAmt: number
	status: "draft" | "submitted_to_etims" | "etims_confirmed" | "partially_paid" | "paid" | "cancelled"
	etimsInvoiceNo?: string // KRA-assigned eTIMS invoice number
	etimsConfirmedAt?: string
	etimsQrCode?: string
	mpesaRef?: string // M-PESA confirmation code from PesaCast
	mpesaAmount?: string
	mpesaReceivedAt?: string
	mpesaDirection?: "received" | "sent" | "paid" | "withdrawn" | "airtime" | "fuliza"
	rawPayload?: any // full original payload for audit
	createdAt: number
	updatedAt: number
}
