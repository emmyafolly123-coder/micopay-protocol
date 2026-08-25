/**
 * SEC-02 — Regression tests: the QR must not carry the HTLC preimage.
 *
 * docs/security-reports/SEC-02-htlc-secret-en-qr.md (severidad Alta) pide un
 * "QR opaco de un solo uso: incluir solo un claim_token aleatorio, corto TTL,
 * estado server-side y marcado atomico como consumido". Esto verifica esas
 * cuatro propiedades:
 *   - getTradeSecret no devuelve el preimage y el payload no lo contiene
 *   - el token vive server-side y expira (nunca despues del trade)
 *   - merchantConfirmScan solo acepta el token emitido para ESE trade
 *   - el segundo escaneo del mismo token es rechazado
 *
 * Runs against the in-memory DB (ALLOW_IN_MEMORY_DB=true, no PostgreSQL needed).
 */

import { strictEqual, ok } from "assert";
import { createHash, randomBytes } from "crypto";
import db from "../db/schema.js";
import {
  getTradeSecret,
  merchantConfirmScan,
} from "../services/trade.service.js";
import { AppError } from "../utils/errors.js";

// ── Helpers ────────────────────────────────────────────────────────────────

const fakeRequest = {
  ip: "127.0.0.1",
  headers: {},
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
  },
} as any;

async function createUser(suffix: string): Promise<string> {
  const row = await db.getOne<{ id: string }>(
    `INSERT INTO users (stellar_address, username, phone_hash, merchant_available, availability, is_suspended)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      `G${"B".repeat(54)}${suffix.padStart(1, "0")}`,
      `user_sec02_${suffix}`,
      `hash_sec02_${suffix}`,
      true,
      "online",
      false,
    ],
  );
  if (!row?.id) throw new Error(`Failed to seed user ${suffix}`);
  return row.id;
}

/** Insert a `revealing` trade and return { tradeId, secret }. */
async function insertRevealingTrade(sellerId: string, buyerId: string) {
  const { encryptSecret, generateTradeSecret } = await import(
    "../services/secret.service.js"
  );
  const { secret, secretHash } = generateTradeSecret();
  const { encrypted, nonce } = encryptSecret(secret);
  const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

  const row = await db.getOne<{ id: string }>(
    `INSERT INTO trades
       (seller_id, buyer_id, amount_mxn, amount_stroops, platform_fee_mxn,
        secret_hash, secret_enc, secret_nonce, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      sellerId,
      buyerId,
      500,
      "5000000000",
      4,
      secretHash,
      encrypted,
      nonce,
      "revealing",
      expiresAt,
    ],
  );
  if (!row?.id) throw new Error("Failed to insert trade");
  return { tradeId: row.id, secret };
}

async function assertAppError(
  fn: () => Promise<unknown>,
  expectedCode: string,
  label: string,
) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    ok(
      err instanceof AppError && err.code === expectedCode,
      `${label}: expected AppError(${expectedCode}) but got ${(err as Error)?.constructor?.name} ${(err as any)?.code}`,
    );
  }
  ok(threw, `${label}: expected an error to be thrown but none was`);
}

function claimTokenFrom(qrPayload: string): string {
  const token = new URL(qrPayload.replace("micopay://", "https://"))
    .searchParams.get("claim_token");
  ok(token, "qr_payload must carry a claim_token");
  return token!;
}

// ── Tests ──────────────────────────────────────────────────────────────────

async function testSecretNeverLeavesTheBackend() {
  const sellerId = await createUser("s1");
  const buyerId = await createUser("b1");
  const { tradeId, secret } = await insertRevealingTrade(sellerId, buyerId);

  const result = await getTradeSecret(
    fakeRequest,
    tradeId,
    sellerId,
    "127.0.0.1",
    "test",
  );

  strictEqual(
    (result as Record<string, unknown>).secret,
    undefined,
    "the response must not include the preimage",
  );
  ok(
    !result.qr_payload.includes(secret),
    "the QR payload must not contain the preimage",
  );
  ok(
    result.qr_payload.startsWith(`micopay://release?trade_id=${tradeId}&claim_token=`),
    `unexpected payload shape: ${result.qr_payload}`,
  );
  console.log("  ✓ getTradeSecret: neither the response nor the QR carry the preimage");
}

async function testTokenIsStoredHashedAndBoundedByTheTrade() {
  const sellerId = await createUser("s2");
  const buyerId = await createUser("b2");
  const { tradeId } = await insertRevealingTrade(sellerId, buyerId);

  const { qr_payload, expires_at } = await getTradeSecret(
    fakeRequest,
    tradeId,
    sellerId,
    "127.0.0.1",
    "test",
  );
  const token = claimTokenFrom(qr_payload);

  const row = await db.getOne<{ token_hash: string; trade_id: string }>(
    `SELECT token_hash, trade_id FROM trade_claim_tokens WHERE trade_id = $1`,
    [tradeId],
  );
  ok(row, "the token must exist server-side");
  strictEqual(
    row!.token_hash,
    createHash("sha256").update(token).digest("hex"),
    "only the sha256 of the token may be stored",
  );

  const trade = await db.getOne<{ expires_at: string }>(
    `SELECT expires_at FROM trades WHERE id = $1`,
    [tradeId],
  );
  ok(
    new Date(expires_at) <= new Date(trade!.expires_at),
    "the token must never outlive the trade",
  );
  console.log("  ✓ claim token: stored hashed, expires with (or before) the trade");
}

async function testTokenIsSingleUse() {
  const sellerId = await createUser("s3");
  const buyerId = await createUser("b3");
  const { tradeId } = await insertRevealingTrade(sellerId, buyerId);

  const { qr_payload } = await getTradeSecret(
    fakeRequest,
    tradeId,
    sellerId,
    "127.0.0.1",
    "test",
  );
  const token = claimTokenFrom(qr_payload);

  const first = await merchantConfirmScan(fakeRequest, tradeId, sellerId, token);
  strictEqual(first.trade_id, tradeId, "first scan should succeed");

  await assertAppError(
    () => merchantConfirmScan(fakeRequest, tradeId, sellerId, token),
    "CLAIM_TOKEN_USED",
    "second scan of the same token",
  );
  console.log("  ✓ claim token: the second scan of the same QR is rejected");
}

async function testForeignTokenIsRejected() {
  const sellerId = await createUser("s4");
  const buyerId = await createUser("b4");
  const { tradeId } = await insertRevealingTrade(sellerId, buyerId);

  await assertAppError(
    () => merchantConfirmScan(
      fakeRequest,
      tradeId,
      sellerId,
      randomBytes(32).toString("hex"),
    ),
    "INVALID_CLAIM_TOKEN",
    "scan with a token that was never issued",
  );
  console.log("  ✓ claim token: a token that was never issued is rejected");
}

// ── Runner ─────────────────────────────────────────────────────────────────

async function run() {
  console.log("\nSEC-02 — Opaque one-time QR token regression tests\n");

  await testSecretNeverLeavesTheBackend();
  await testTokenIsStoredHashedAndBoundedByTheTrade();
  await testTokenIsSingleUse();
  await testForeignTokenIsRejected();

  console.log("\nAll SEC-02 claim-token tests passed.\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
