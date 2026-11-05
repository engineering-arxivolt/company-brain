/**
 * KRA eTIMS OSCU (Online Sales Control Unit) client.
 *
 * Submits eTIMS-compliant invoices to the Kenya Revenue Authority's
 * Electronic Tax Invoice Management System and returns the eTIMS invoice
 * number plus a QR code for verification.
 *
 * Supports both sandbox (testing) and production KRA OSCU endpoints.
 * Authentication uses the KRA OSCU client credentials (client ID + secret)
 * which must be configured as worker secrets.
 *
 * Environment variables:
 *   ETIMS_OSCU_BASE_URL   - KRA OSCU base URL (sandbox or production)
 *   ETIMS_OSCU_CLIENT_ID  - KRA OSCU client ID
 *   ETIMS_OSCU_CLIENT_SECRET - KRA OSCU client secret (encrypted at rest)
 *   ETIMS_OSCU_REGR_ID    - Registrar ID (your KRA-registered system ID)
 *   ETIMS_OSCU_REGR_NM    - Registrar name
 *   ETIMS_MODE              - "sandbox" | "production" (default: sandbox)
 */

import { decryptToken } from "@/lib/crypto"

export type ETimsMode = "sandbox" | "production" | "mock"

export interface ETimsOscuConfig {
  baseUrl: string
  clientId: string
  clientSecret: string
  regrId: string
  regrNm: string
  mode: ETimsMode
  timeoutMs?: number
}

export interface ETimsSubmitRequest {
  invcNo: string
  salesDt: string
  cfmDt: string
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
  regrId: string
  regrNm: string
  modrId: string
  modrNm: string
  receipt: {
    rcptPbctDt: string
    prchrAcptcYn: "Y" | "N"
    custTin?: string
    custMblNo?: string
    trdeNm?: string
    adrs?: string
    topMsg?: string
    btmMsg?: string
  }
  itemList: Array<{
    itemSeq: number
    itemCd: string
    itemNm: string
    pkgUnitCd: string
    pkg: number
    qtyUnitCd: string
    qty: number
    prc: number
    splyAmt: number
    dcRt?: number
    dcAmt?: number
    taxTyCd: string
    taxblAmt: number
    taxAmt: number
    totAmt: number
  }>
  custTin?: string
  custNm?: string
  pmtTyCd?: string
  stockRlsDt?: string
  remark?: string
}

export interface ETimsSubmitResponse {
  invcNo: string
  cfmDt: string
  totAmt: number
  qrcode?: string
  resultCd: string
  resultMsg: string
}

export class ETimsOscuError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly resultCd?: string,
    public readonly resultMsg?: string,
  ) {
    super(message)
    this.name = "ETimsOscuError"
  }
}

export function buildEtimsOscuConfig(env: Env): ETimsOscuConfig | null {
  const baseUrl = env.ETIMS_OSCU_BASE_URL?.trim()
  const clientId = env.ETIMS_OSCU_CLIENT_ID?.trim()
  const clientSecret = env.ETIMS_OSCU_CLIENT_SECRET?.trim()
  const regrId = env.ETIMS_OSCU_REGR_ID?.trim()
  const regrNm = env.ETIMS_OSCU_REGR_NM?.trim()
  const mode = (env.ETIMS_MODE?.trim() ?? "sandbox") as ETimsMode

  // Mock mode: no real credentials needed, for testing the Slack flow end-to-end
  if (mode === "mock") {
    return {
      baseUrl: "mock://etims",
      clientId: "mock-client-id",
      clientSecret: "mock-client-secret",
      regrId: "MOCK-REGR-ID",
      regrNm: "Mock Registrar",
      mode,
      timeoutMs: 1_000,
    }
  }

  if (!baseUrl || !clientId || !clientSecret || !regrId || !regrNm) {
    return null
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    clientId,
    clientSecret,
    regrId,
    regrNm,
    mode,
    timeoutMs: 30_000,
  }
}

export function generateEtimsQrCode(
  etimsInvoiceNo: string,
  cfmDt: string,
  totAmt: number,
): string {
  const payload = `${etimsInvoiceNo}|${cfmDt}|${totAmt}`
  return `data:image/svg+xml;base64,${btoa(generateQrSvg(payload))}`
}

function generateQrSvg(text: string): string {
  const size = 21
  const moduleSize = 4
  const svgSize = size * moduleSize

  const bytes = new TextEncoder().encode(text)
  const modules: boolean[][] = Array.from({ length: size }, () =>
    Array(size).fill(false),
  )

  drawFinderPattern(modules, 3, 3)
  drawFinderPattern(modules, size - 4, 3)
  drawFinderPattern(modules, 3, size - 4)

  let bitIndex = 0
  for (let i = 0; i < bytes.length && bitIndex < bytes.length * 8; i++) {
    const byte = bytes[i]!
    for (let b = 7; b >= 0 && bitIndex < bytes.length * 8; b--) {
      const bit = (byte >> b) & 1
      const row = Math.floor(bitIndex / (size - 8)) + 4
      const col = (bitIndex % (size - 8)) + 4
      if (row < size && col < size) {
        modules[row]![col]! = bit === 1
      }
      bitIndex++
    }
  }

  const lines: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}">`,
    `<rect width="100%" height="100%" fill="white"/>`,
  ]

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (modules[row]![col]!) {
        lines.push(
          `<rect x="${col * moduleSize}" y="${row * moduleSize}" width="${moduleSize}" height="${moduleSize}" fill="black"/>`,
        )
      }
    }
  }

  lines.push(`</svg>`)
  return lines.join("")
}

function drawFinderPattern(modules: boolean[][], row: number, col: number): void {
  const size = modules.length
  const row0 = modules[0]!
  for (let i = -1; i <= 7; i++) {
    for (let j = -1; j <= 7; j++) {
      const r = row + i
      const c = col + j
      if (r < 0 || r >= size || c < 0 || c >= row0.length) continue
      if (i === -1 || i === 7 || j === -1 || j === 7) {
        modules[r]![c]! = true
      } else if (i >= 1 && i <= 5 && j >= 1 && j <= 5) {
        modules[r]![c]! = i === 1 || i === 5 || j === 1 || j === 5 ? false : true
      } else {
        modules[r]![c]! = i === 0 || i === 6 || j === 0 || j === 6
      }
    }
  }
}

/**
 * Submit an invoice to KRA eTIMS OSCU.
 *
 * @throws ETimsOscuError if the submission fails or KRA returns an error.
 */
export async function submitInvoiceToETimsOscu(
  config: ETimsOscuConfig,
  request: ETimsSubmitRequest,
): Promise<ETimsSubmitResponse> {
  // Mock mode: simulate without real HTTP calls
  if (config.mode === "mock") {
    return submitInvoiceToETimsMock(config, request)
  }

  const url = `${config.baseUrl}/api/v1/invoices/submit`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs ?? 30_000)

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.clientId}:${config.clientSecret}`,
        "x-etims-mode": config.mode,
        "x-etims-regr-id": config.regrId,
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    })

    const body = (await res.json().catch(() => ({}))) as {
      resultCd?: string
      resultMsg?: string
      invcNo?: string
      cfmDt?: string
      totAmt?: number
      qrcode?: string
      [key: string]: unknown
    }

    if (!res.ok) {
      throw new ETimsOscuError(
        `KRA eTIMS OSCU returned HTTP ${res.status}`,
        res.status,
        body.resultCd,
        body.resultMsg,
      )
    }

    if (body.resultCd !== "00" && body.resultCd !== "200") {
      throw new ETimsOscuError(
        body.resultMsg ?? "KRA eTIMS OSCU submission failed",
        res.status,
        body.resultCd,
        body.resultMsg,
      )
    }

    return {
      invcNo: body.invcNo ?? request.invcNo,
      cfmDt: body.cfmDt ?? request.cfmDt,
      totAmt: body.totAmt ?? request.totAmt,
      qrcode: body.qrcode,
      resultCd: body.resultCd ?? "00",
      resultMsg: body.resultMsg ?? "Success",
    }
  } catch (err) {
    if (err instanceof ETimsOscuError) throw err
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ETimsOscuError("KRA eTIMS OSCU request timed out")
    }
    throw new ETimsOscuError(
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Mock submission for testing — simulates a successful KRA eTIMS OSCU response
 * without making any real HTTP calls. Use ETIMS_MODE="mock" to test the
 * Slack invoice flow end-to-end before you have real KRA credentials.
 */
export async function submitInvoiceToETimsMock(
  config: ETimsOscuConfig,
  request: ETimsSubmitRequest,
): Promise<ETimsSubmitResponse> {
  if (config.mode !== "mock") {
    throw new ETimsOscuError("submitInvoiceToETimsMock requires mock mode")
  }

  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 300))

  const etimsInvoiceNo = `ETIMS-MOCK-${Math.random().toString(36).slice(2, 10).toUpperCase()}`
  const cfmDt = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 14)
  const qrCode = generateEtimsQrCode(etimsInvoiceNo, cfmDt, request.totAmt)

  console.log(
    `[etims-mock] Submitted invoice ${request.invcNo} -> eTIMS No: ${etimsInvoiceNo}`,
  )

  return {
    invcNo: etimsInvoiceNo,
    cfmDt,
    totAmt: request.totAmt,
    qrcode: qrCode,
    resultCd: "00",
    resultMsg: "Success (mock)",
  }
}