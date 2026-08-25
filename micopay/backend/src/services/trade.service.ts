import db from '../db/schema.js';
import { config } from '../config.js';
import pino from 'pino';
import { generateTradeSecret, encryptSecret, decryptSecret } from './secret.service.js';
import { createHash, randomBytes } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { prepareLockTx, submitLockTx, prepareReleaseTx, submitReleaseTx, callRefundOnChain, verifyLockOnChain, assertNotReplayed } from './stellar.service.js';
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  AuthError,
  ValidationError,
  TradeStateError,
  MerchantLimitError,
} from '../utils/errors.js';
import {
  getTradeAuditTrail as getTradeAuditTrailRows,
  getAuditEventsByRequestId,
  insertTradeAuditEvent,
} from '../db/audit-log.model.js';
import {
  assertCanCreateTrade,
  assertCanCancelTrade,
  recordTradeCancelled,
} from './abuse.service.js';
import { assertKycTierSufficient } from './kyc-gate.service.js';
import { sendTradeNotificationToMerchant } from './push.service.js';

const logger = pino({ name: 'trade.service' });

// --- Trade lifecycle ---

/** Trade states where the buyer still depends on the merchant before cash handoff / release (#31). */
const MERCHANT_DEPENDENT_STATUSES = ['pending', 'locked', 'revealing'] as const;

async function getSellerMerchantRow(sellerId: string) {
  return db.getOne<{ username: string; merchant_available: boolean | null }>(
    'SELECT username, merchant_available FROM users WHERE id = $1',
    [sellerId],
  );
}

function isMerchantUnavailableForTrade(
  trade: { status: string },
  sellerRow: { merchant_available: boolean | null } | null,
) {
  if (!MERCHANT_DEPENDENT_STATUSES.includes(trade.status as (typeof MERCHANT_DEPENDENT_STATUSES)[number])) {
    return false;
  }
  return sellerRow?.merchant_available === false;
}

/** Extract the correlation ID attached by requestId middleware. */
function getRequestId(request: FastifyRequest): string | undefined {
  return (request as any).requestId;
}

const STROOPS_PER_MXN = 10_000_000; // 7 decimals
const PLATFORM_FEE_PERCENT = 0.8; // 0.8% platform fee
const DEFAULT_TIMEOUT_MINUTES = 120; // 2 hours
const UNKNOWN_STATE = 'unknown';
/** SEC-02: TTL corto del token del QR. Nunca sobrepasa `trades.expires_at`. */
const CLAIM_TOKEN_TTL_MINUTES = 15;

interface TransitionFailureContext {
  tradeId: string;
  fromState: string;
  toState: string;
  actor: string;
  metadata?: Record<string, unknown>;
}

function transitionFailureMetadata(error: unknown, metadata: Record<string, unknown> = {}) {
  if (error instanceof Error) {
    return {
      ...metadata,
      success: false,
      reason: error.message,
      error_name: error.name,
    };
  }

  return {
    ...metadata,
    success: false,
    reason: String(error),
    error_name: 'UnknownError',
  };
}

async function logTransitionFailure(context: TransitionFailureContext, error: unknown) {
  try {
    await insertTradeAuditEvent({
      tradeId: context.tradeId,
      fromState: context.fromState,
      toState: context.toState,
      actor: context.actor,
      metadata: transitionFailureMetadata(error, context.metadata),
    });
  } catch (auditError) {
    logger.error({ err: auditError, category: 'trade.lifecycle', trade_id: context.tradeId }, '[audit_log] Failed to persist failed transition');
  }
}

const DAILY_CAP_RESET_NOTE = 'Daily cap usage resets at 00:00 UTC.';

function getUtcDayRange(date = new Date()) {
  const start = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0,
    0,
    0,
    0,
  ));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

async function validateAgainstMerchantLimits(sellerId: string, amountMxn: number) {
  const merchantConfig = await db.getOne(
    `SELECT user_id, min_trade_mxn, max_trade_mxn, daily_cap_mxn
     FROM merchant_configs
     WHERE user_id = $1`,
    [sellerId],
  );

  const minTrade = merchantConfig?.min_trade_mxn ?? 100;
  const maxTrade = merchantConfig?.max_trade_mxn ?? 50000;
  const dailyCap = merchantConfig?.daily_cap_mxn ?? 250000;

  if (amountMxn < minTrade || amountMxn > maxTrade) {
    throw new MerchantLimitError(
      `Trade amount must be between merchant limits: ${minTrade} and ${maxTrade} MXN`,
    );
  }

  const { start, end } = getUtcDayRange();
  const todayTrades = await db.getMany<{ amount_mxn: number }>(
    `SELECT amount_mxn
     FROM trades
     WHERE seller_id = $1
       AND created_at >= $2
       AND created_at < $3
       AND status IN ('pending', 'locked', 'revealing', 'completed')`,
    [sellerId, start.toISOString(), end.toISOString()],
  );

  const todayVolume = todayTrades.reduce((sum, t) => sum + Number(t.amount_mxn || 0), 0);
  const projectedVolume = todayVolume + amountMxn;

  if (projectedVolume > dailyCap) {
    throw new MerchantLimitError(
      `Daily merchant cap exceeded (${projectedVolume}/${dailyCap} MXN). ${DAILY_CAP_RESET_NOTE}`,
    );
  }
}

export interface CreateTradeInput {
  request: FastifyRequest;
  sellerId: string;
  buyerId: string;
  amountMxn: number;
}

export async function createTrade(input: CreateTradeInput) {
  const { request, sellerId, buyerId, amountMxn } = input;
  request.log.info({ seller_id: sellerId, buyer_id: buyerId, amount_mxn: amountMxn, category: 'trade.lifecycle' }, '[trade] Creating trade');

  if (amountMxn < 100 || amountMxn > 50000) {
    throw new ValidationError(
      'INVALID_AMOUNT',
      'El monto debe ser entre 100 y 50,000 MXN',
      'amount_mxn must be between 100 and 50,000'
    );
  }

  if (sellerId === buyerId) {
    throw new ValidationError(
      'INVALID_PARTICIPANTS',
      'No puedes crear un intercambio contigo mismo',
      'Cannot trade with yourself',
    );
  }

  await assertCanCreateTrade({ request, buyerId, sellerId, amountMxn });

  // #314: tiered KYC gate. The buyer is the funds-moving party for a P2P
  // transfer; audit-only until config.kycGateEnabled is turned on.
  await assertKycTierSufficient({ userId: buyerId, operationType: 'p2p_transfer', amountMxn });

  const seller = await db.getOne<{ id: string; stellar_address: string }>(
    'SELECT id, stellar_address FROM users WHERE id = $1',
    [sellerId],
  );
  if (!seller) {
    throw new NotFoundError('USER_NOT_FOUND', 'El usuario vendedor no existe', 'Seller not found');
  }

  const buyer = await db.getOne<{ id: string; stellar_address: string; username: string | null }>(
    'SELECT id, stellar_address, username FROM users WHERE id = $1',
    [buyerId],
  );
  if (!buyer) {
    throw new NotFoundError('USER_NOT_FOUND', 'El usuario comprador no existe', 'Buyer not found');
  }

  await validateAgainstMerchantLimits(sellerId, amountMxn);

  // Generate HTLC secret
  const { secret, secretHash } = generateTradeSecret();

  // Calculate amounts
  const amountStroops = BigInt(amountMxn) * BigInt(STROOPS_PER_MXN);
  const platformFeeMxn = Math.ceil(amountMxn * PLATFORM_FEE_PERCENT / 100);

  // Encrypt and store secret immediately (Option A from spec)
  const { encrypted, nonce } = encryptSecret(secret);

  const expiresAt = new Date(Date.now() + DEFAULT_TIMEOUT_MINUTES * 60 * 1000);

  const result = await db.getOne(
    `INSERT INTO trades
      (seller_id, buyer_id, amount_mxn, amount_stroops, platform_fee_mxn,
       secret_hash, secret_enc, secret_nonce, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
     RETURNING *`,
    [
      sellerId,
      buyerId,
      amountMxn,
      amountStroops.toString(),
      platformFeeMxn,
      secretHash,
      encrypted,
      nonce,
      expiresAt,
    ],
  );

  await insertTradeAuditEvent({
    tradeId: result.id,
    fromState: UNKNOWN_STATE,
    toState: 'pending',
    actor: buyerId,
    requestId: getRequestId(request),
    metadata: {
      success: true,
      amount_mxn: amountMxn,
      seller_id: sellerId,
      buyer_id: buyerId,
    },
  });

  // Fire-and-forget — push failure must never fail trade creation
  const buyerUsername = buyer.username || buyer.stellar_address || 'Usuario';
  sendTradeNotificationToMerchant(sellerId, {
    tradeId: result.id,
    amount: `${amountMxn.toLocaleString('es-MX')} MXN`,
    buyerUsername,
  }).catch((err: unknown) => {
    logger.error({ err, trade_id: result.id, category: 'trade.lifecycle' }, '[trade] Push notification failed silently');
  });

  return result;
}


export async function getTradeById(tradeId: string, userId: string) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');

  // Only seller or buyer can view
  if (trade.seller_id !== userId && trade.buyer_id !== userId) {
    throw new AuthError('UNAUTHORIZED_ACCESS', 'No tienes permiso para ver este intercambio', 'Not a participant of this trade', 403);
  }

  return trade;
}

/** Trade row for API plus flags for merchant-unavailable UX (issue #31). */
export async function getTradeDetailForParticipant(tradeId: string, userId: string) {
  const trade = await getTradeById(tradeId, userId);
  const seller = await getSellerMerchantRow(trade.seller_id);
  const merchant_unavailable = isMerchantUnavailableForTrade(trade, seller);
  const buyer = await db.getOne<{ username: string | null }>(
    'SELECT username FROM users WHERE id = $1',
    [trade.buyer_id],
  );

  return {
    trade,
    merchant_unavailable,
    seller_username: seller?.username ?? null,
    buyer_username: buyer?.username ?? null,
  };
}

export async function getActiveTrades(userId: string) {
  return db.getMany(
    `SELECT * FROM trades
     WHERE (seller_id = $1 OR buyer_id = $1)
       AND status IN ('pending', 'locked', 'revealing')
     ORDER BY created_at DESC`,
    [userId],
  );
}

export async function getTradeHistory(userId: string, status?: string, page = 1, limit = 20) {
  const trades = await db.getMany(
    `SELECT id, status, amount_mxn, platform_fee_mxn, lock_tx_hash, release_tx_hash,
            created_at, completed_at, seller_id, buyer_id, expires_at
     FROM trades
     WHERE (seller_id = $1 OR buyer_id = $1)
     ORDER BY created_at DESC`,
    [userId],
  );

  let filtered = trades;
  const now = new Date();

  if (status && status !== 'all') {
    if (status === 'expired') {
      filtered = trades.filter(t =>
        !['completed', 'cancelled'].includes(t.status) &&
        new Date(t.expires_at) < now
      );
    } else {
      filtered = trades.filter(t => t.status === status);
    }
  }

  // Fetch usernames to provide merchant info
  const allUsers = await db.getMany('SELECT id, username FROM users');
  const userMap = Object.fromEntries(allUsers.map(u => [u.id, u.username]));

  const mapped = filtered.map(t => {
    const isBuyer = t.buyer_id === userId;
    const otherPartyId = isBuyer ? t.seller_id : t.buyer_id;
    return {
      ...t,
      direction: isBuyer ? 'cash-in' : 'cash-out',
      merchant_username: userMap[otherPartyId] || 'Usuario Micopay',
    };
  });

  const offset = (page - 1) * limit;
  return mapped.slice(offset, offset + limit);
}

/**
 * Build the unsigned lock() transaction for the seller to sign with their own key.
 * Backend never holds or needs the seller's secret key.
 */
export async function prepareLockTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('Trade not found');
  if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can lock');
  if (trade.status !== 'pending') throw new ConflictError(`Trade is ${trade.status}, expected pending`);

  if (config.mockStellar) {
    return { mock: true as const };
  }

  const seller = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
  const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [trade.buyer_id]);
  if (!seller) throw new NotFoundError('Seller not found');
  if (!buyer) throw new NotFoundError('Buyer not found');

  const { xdr, networkPassphrase } = await prepareLockTx({
    request,
    sellerAddress: seller.stellar_address,
    buyerAddress: buyer.stellar_address,
    amountStroops: BigInt(trade.amount_stroops),
    platformFeeMxn: trade.platform_fee_mxn,
    secretHash: trade.secret_hash,
  });

  return { xdr, network_passphrase: networkPassphrase };
}

export async function lockTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
  signedXdr?: string,
) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Locking trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can lock');
    if (trade.status !== 'pending') throw new ConflictError(`Trade is ${trade.status}, expected pending`);

    let lockTxHash: string;
    let stellarTradeId: string;

    if (!config.mockStellar) {
      // Real on-chain lock — the seller already signed the XDR client-side.
      if (!signedXdr) {
        throw new BadRequestError('SIGNED_XDR_REQUIRED', 'Falta la transacción firmada.', 'signed_xdr is required when MOCK_STELLAR=false');
      }
      const seller = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
      const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [trade.buyer_id]);
      if (!seller) throw new NotFoundError('Seller not found');
      if (!buyer) throw new NotFoundError('Buyer not found');

      const result = await submitLockTx({
        request,
        signedXdr,
        sellerAddress: seller.stellar_address,
        buyerAddress: buyer.stellar_address,
        amountStroops: BigInt(trade.amount_stroops),
        platformFeeMxn: trade.platform_fee_mxn,
        secretHash: trade.secret_hash,
      });
      lockTxHash = result.txHash;
      stellarTradeId = result.txHash;
    } else {
      // Mock mode — generate placeholder hashes
      const verified = await verifyLockOnChain(
        request,
        `mock_${Date.now()}`,
        trade.seller_id,
        BigInt(trade.amount_stroops),
      );
      if (!verified) throw new BadRequestError('Could not verify lock on-chain');
      lockTxHash = `mock_${Date.now()}`;
      stellarTradeId = lockTxHash;
    }

    await assertNotReplayed(lockTxHash, 'trade/lock', userId);

    // Compute contract_trade_id = sha256(secret_hash_bytes), matching compute_trade_id()
    // in the Soroban contract. Stored for O(1) lookup when on-chain events arrive.
    const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
    const contractTradeId = createHash('sha256').update(secretHashBytes).digest('hex');

    await db.execute(
      `UPDATE trades
       SET status = 'locked',
           stellar_trade_id = $2,
           lock_tx_hash = $3,
           locked_at = NOW(),
           contract_trade_id = $4
       WHERE id = $1`,
      [tradeId, stellarTradeId, lockTxHash, contractTradeId],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'locked',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        lock_tx_hash: lockTxHash,
        stellar_trade_id: stellarTradeId,
      },
    });

    return { status: 'locked', lock_tx_hash: lockTxHash };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'locked',
      actor: userId,
    }, error);
    throw error;
  }
}

export async function revealTrade(request: FastifyRequest, tradeId: string, userId: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Revealing trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.seller_id !== userId) throw new ForbiddenError('Only the seller can reveal');
    if (trade.status !== 'locked') throw new ConflictError(`Trade is ${trade.status}, expected locked`);

    await db.execute(
      `UPDATE trades
       SET status = 'revealing', reveal_requested_at = NOW()
       WHERE id = $1`,
      [tradeId],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'revealing',
      actor: userId,
      requestId: getRequestId(request),
      metadata: { success: true },
    });

    return { status: 'revealing' };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'revealing',
      actor: userId,
    }, error);
    throw error;
  }
}

export async function getTradeSecret(request: FastifyRequest, tradeId: string, userId: string, ip: string, userAgent: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Secret accessed');
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('TRADE_NOT_FOUND', 'El intercambio no existe', 'Trade not found');

  // Only seller can see the secret
  if (trade.seller_id !== userId) {
    throw new AuthError('UNAUTHORIZED_ACTION', 'Solo el vendedor puede ver el secreto', 'Only the seller can access the secret', 403);
  }

  // Only in revealing state
  if (trade.status !== 'revealing') {
    throw new TradeStateError('INVALID_STATE', `El intercambio no está en estado de revelación (actual: ${trade.status})`, `Trade is ${trade.status}, must be revealing`);
  }

  // Check not expired
  if (new Date(trade.expires_at) < new Date()) {
    throw new TradeStateError('TRADE_EXPIRED', 'El intercambio ha expirado', 'Trade has expired');
  }

  // SEC-02: el preimage ya no sale del backend. El QR lleva un token opaco de
  // un solo uso; quien libera on-chain sigue siendo el backend, que descifra el
  // secreto por su cuenta en prepareReleaseTrade/completeTrade.
  const claimToken = randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Math.min(
    Date.now() + CLAIM_TOKEN_TTL_MINUTES * 60 * 1000,
    new Date(trade.expires_at).getTime(),
  ));

  await db.execute(
    `INSERT INTO trade_claim_tokens (token_hash, trade_id, issued_to, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [hashClaimToken(claimToken), tradeId, userId, tokenExpiresAt],
  );

  // Log access
  await db.execute(
    `INSERT INTO secret_access_log (trade_id, user_id, ip_address, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [tradeId, userId, ip, userAgent],
  );

  const qrPayload = `micopay://release?trade_id=${tradeId}&claim_token=${claimToken}`;

  return {
    qr_payload: qrPayload,
    expires_at: tokenExpiresAt.toISOString(),
    expires_in: Math.max(0, Math.floor((tokenExpiresAt.getTime() - Date.now()) / 1000)),
  };
}

/** El token en claro nunca se persiste — mismo principio que `trades.secret_hash`. */
function hashClaimToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Marca un token de QR como usado. El UPDATE filtra por `consumed_at IS NULL`,
 * así que bajo concurrencia solo un escaneo puede ganarlo; el SELECT posterior
 * confirma quién fue.
 */
async function consumeClaimToken(tradeId: string, claimToken: string, consumedBy: string) {
  const tokenHash = hashClaimToken(claimToken);
  const selectToken = `SELECT consumed_at, consumed_by, expires_at FROM trade_claim_tokens
     WHERE token_hash = $1 AND trade_id = $2`;

  const before = await db.getOne<{
    consumed_at: string | null;
    consumed_by: string | null;
    expires_at: string;
  }>(selectToken, [tokenHash, tradeId]);

  if (!before) {
    throw new NotFoundError(
      'INVALID_CLAIM_TOKEN',
      'Este código QR no es válido para esta operación',
      `No claim token matching trade ${tradeId}`,
    );
  }

  // `?? null`: el store in-memory omite las columnas que nunca se escribieron,
  // así que un token virgen llega con `consumed_at` undefined, no null.
  if ((before.consumed_at ?? null) !== null) {
    throw new ConflictError(
      'CLAIM_TOKEN_USED',
      'Este código QR ya fue usado',
      `Claim token for trade ${tradeId} was already consumed`,
    );
  }

  if (new Date(before.expires_at) < new Date()) {
    throw new TradeStateError(
      'CLAIM_TOKEN_EXPIRED',
      'Este código QR expiró. Pide al usuario que genere uno nuevo',
      `Claim token for trade ${tradeId} expired at ${before.expires_at}`,
    );
  }

  await db.execute(
    `UPDATE trade_claim_tokens
     SET consumed_at = NOW(), consumed_by = $3
     WHERE token_hash = $1 AND trade_id = $2 AND consumed_at IS NULL`,
    [tokenHash, tradeId, consumedBy],
  );

  // Dos escaneos simultáneos pasan los checks de arriba; solo uno gana el
  // UPDATE (`consumed_at IS NULL`). Releer dice cuál fue.
  const after = await db.getOne<{ consumed_by: string | null }>(selectToken, [tokenHash, tradeId]);
  if (after?.consumed_by !== consumedBy) {
    throw new ConflictError(
      'CLAIM_TOKEN_USED',
      'Este código QR ya fue usado',
      `Claim token for trade ${tradeId} was consumed by another scan`,
    );
  }
}

/**
 * Build the unsigned release() transaction for the buyer to sign with their own key.
 * Backend never holds or needs the buyer's secret key.
 */
export async function prepareReleaseTrade(request: FastifyRequest, tradeId: string, userId: string) {
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) throw new NotFoundError('Trade not found');
  if (trade.buyer_id !== userId) throw new ForbiddenError('Only the buyer can complete');
  if (trade.status !== 'revealing') {
    throw new ConflictError(`Trade is ${trade.status}, expected revealing`);
  }

  if (config.mockStellar) {
    return { mock: true as const };
  }

  const buyer = await db.getOne('SELECT stellar_address FROM users WHERE id = $1', [userId]);
  if (!buyer) throw new NotFoundError('Buyer not found');

  const secret = decryptSecret(trade.secret_enc, trade.secret_nonce);
  const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
  const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();
  const secretBytes = Buffer.from(secret, 'hex');

  const { xdr, networkPassphrase } = await prepareReleaseTx({
    request,
    buyerAddress: buyer.stellar_address,
    tradeIdBytes,
    secretBytes,
  });

  return { xdr, network_passphrase: networkPassphrase };
}

export async function completeTrade(request: FastifyRequest, tradeId: string, userId: string, signedXdr?: string) {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Completing trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');

    fromState = trade.status;
    if (trade.buyer_id !== userId) throw new ForbiddenError('Only the buyer can complete');
    if (trade.status !== 'revealing') {
      throw new ConflictError(`Trade is ${trade.status}, expected revealing`);
    }

    let releaseTxHash: string;

    if (!config.mockStellar) {
      // Real on-chain release — the buyer already signed the XDR client-side.
      if (!signedXdr) {
        throw new BadRequestError('SIGNED_XDR_REQUIRED', 'Falta la transacción firmada.', 'signed_xdr is required when MOCK_STELLAR=false');
      }
      const secret = decryptSecret(trade.secret_enc, trade.secret_nonce);
      const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
      const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();
      const secretBytes = Buffer.from(secret, 'hex');

      const result = await submitReleaseTx({ request, signedXdr, tradeIdBytes, secretBytes });
      releaseTxHash = result.txHash;
    } else {
      releaseTxHash = `mock_release_${Date.now()}`;
    }

    await assertNotReplayed(releaseTxHash, 'trade/complete', userId);

    // Clear encrypted secret from DB now that release is confirmed on-chain
    await db.execute(
      `UPDATE trades
       SET status = 'completed',
           release_tx_hash = $2,
           completed_at = NOW(),
           secret_enc = NULL,
           secret_nonce = NULL
       WHERE id = $1`,
      [tradeId, releaseTxHash],
    );

    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'completed',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        release_tx_hash: releaseTxHash,
      },
    });

    // Update merchant reputation after successful trade completion
    try {
      await updateMerchantReputation(trade.seller_id);
    } catch (reputationError) {
      logger.warn(
        { trade_id: tradeId, seller_id: trade.seller_id },
        '[reputation] Failed to update merchant reputation (non-critical)'
      );
    }

    return { status: 'completed', release_tx_hash: releaseTxHash };
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'completed',
      actor: userId,
    }, error);
    throw error;
  }
}

// ── Reputation calculation ───────────────────────────────────────────────────

/**
 * Calculate and update merchant reputation from trade history.
 * Queries micopay backend's trades table for completed trades.
 */
async function updateMerchantReputation(userId: string): Promise<void> {
  // Query micopay backend for trade statistics
  const result = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'completed') as completed_trades,
      COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled_trades,
      COUNT(*) as total_trades,
      AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) / 60) FILTER (WHERE status = 'completed') as avg_time_minutes,
      SUM(amount_mxn) FILTER (WHERE status = 'completed') as total_volume_mxn
    FROM trades
    WHERE seller_id = $1
  `, [userId]);

  const stats = result.rows[0];

  if (!stats) {
    // No trades yet - reset to defaults
    await db.query(`
      UPDATE merchants
      SET trades_completed = 0,
          completion_rate = 0,
          avg_time_minutes = 0,
          tier = 'espora',
          total_volume_usdc = 0,
          last_trade_at = NULL,
          updated_at = NOW()
      WHERE user_id = $1
    `, [userId]);
    return;
  }

  const completedTrades = parseInt(stats.completed_trades) || 0;
  const cancelledTrades = parseInt(stats.cancelled_trades) || 0;
  const totalTrades = parseInt(stats.total_trades) || 0;
  const avgTimeMinutes = stats.avg_time_minutes ? Math.round(parseFloat(stats.avg_time_minutes)) : 0;
  const totalVolumeMXN = parseFloat(stats.total_volume_mxn) || 0;

  // Convert MXN to USDC (approximate: 1 USDC ≈ 17 MXN)
  const totalVolumeUSDC = totalVolumeMXN / 17;

  // Calculate completion rate
  const completionRate = totalTrades > 0 ? completedTrades / totalTrades : 0;

  // Determine tier
  const tier = getTier(completedTrades, completionRate);

  // Get last trade timestamp
  const lastTradeResult = await db.query(`
    SELECT updated_at FROM trades 
    WHERE seller_id = $1 AND status = 'completed'
    ORDER BY updated_at DESC LIMIT 1
  `, [userId]);

  const lastTradeAt = lastTradeResult.rows[0]?.updated_at || null;

  // Update merchant record
  await db.query(`
    UPDATE merchants
    SET trades_completed = $1,
        completion_rate = $2,
        avg_time_minutes = $3,
        tier = $4,
        total_volume_usdc = $5,
        last_trade_at = $6,
        updated_at = NOW()
    WHERE user_id = $7
  `, [
    completedTrades,
    completionRate,
    avgTimeMinutes,
    tier,
    totalVolumeUSDC,
    lastTradeAt,
    userId,
  ]);
}

// ── Tier definitions ─────────────────────────────────────────────────────────
const TIERS = [
  { name: "maestro", minTrades: 100, minCompletion: 0.95 },
  { name: "experto", minTrades: 30, minCompletion: 0.88 },
  { name: "activo", minTrades: 10, minCompletion: 0.80 },
  { name: "espora", minTrades: 0, minCompletion: 0.0 },
] as const;

function getTier(tradesCompleted: number, completionRate: number): typeof TIERS[number]["name"] {
  return TIERS.find(
    (t) => tradesCompleted >= t.minTrades && completionRate >= t.minCompletion
  )?.name ?? "espora";
}

/** Response shape for POST /trades/:id/cancel — drives refund copy on the client (#20). */
export interface CancelTradeResult {
  status: 'cancelled';
  refund_expected: boolean;
  lock_tx_hash: string | null;
}

async function finalizeTradeCancellation(tradeId: string) {
  await db.execute(
    `UPDATE trades
     SET status = 'cancelled',
         secret_enc = NULL,
         secret_nonce = NULL
     WHERE id = $1`,
    [tradeId],
  );
}

export async function cancelTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
  reason?: string,
): Promise<CancelTradeResult> {
  let fromState = UNKNOWN_STATE;

  const audit = async (result: CancelTradeResult) => {
    await insertTradeAuditEvent({
      tradeId,
      fromState,
      toState: 'cancelled',
      actor: userId,
      requestId: getRequestId(request),
      metadata: {
        success: true,
        cancel_reason: reason ?? null,
        refund_expected: result.refund_expected,
        lock_tx_hash: result.lock_tx_hash,
      },
    });
  };

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');
    fromState = trade.status;

    if (trade.seller_id !== userId && trade.buyer_id !== userId) {
      throw new ForbiddenError('Not a participant of this trade');
    }

    await assertCanCancelTrade(userId);

    const lockTx: string | null = trade.lock_tx_hash ?? null;

    const finishCancel = async (result: CancelTradeResult) => {
      await audit(result);
      await recordTradeCancelled({
        tradeId,
        sellerId: trade.seller_id,
        cancelledBy: userId,
      });
      return result;
    };

    if (trade.status === 'pending') {
      await finalizeTradeCancellation(tradeId);
      const result: CancelTradeResult = { status: 'cancelled', refund_expected: false, lock_tx_hash: lockTx };
      return finishCancel(result);
    }

    if (trade.status === 'locked') {
      if (trade.buyer_id === userId) {
        await finalizeTradeCancellation(tradeId);
        const result: CancelTradeResult = {
          status: 'cancelled',
          refund_expected: Boolean(lockTx),
          lock_tx_hash: lockTx,
        };
        return finishCancel(result);
      }
      if (trade.seller_id === userId) {
        const seller = await getSellerMerchantRow(trade.seller_id);
        if (!isMerchantUnavailableForTrade(trade, seller)) {
          throw new ForbiddenError(
            'Only the buyer may cancel a locked trade before reveal. Pause merchant availability if you need to unwind as the agent.',
          );
        }
        await finalizeTradeCancellation(tradeId);
        const result: CancelTradeResult = {
          status: 'cancelled',
          refund_expected: Boolean(lockTx),
          lock_tx_hash: lockTx,
        };
        return finishCancel(result);
      }
      throw new ForbiddenError('Not a participant of this trade');
    }

    if (trade.status === 'revealing') {
      const seller = await getSellerMerchantRow(trade.seller_id);
      if (!isMerchantUnavailableForTrade(trade, seller)) {
        throw new ConflictError(
          'Cannot cancel while the trade is in handoff. Wait for completion, or cancel only if the merchant is temporarily unavailable.',
        );
      }
      await finalizeTradeCancellation(tradeId);
      const result: CancelTradeResult = {
        status: 'cancelled',
        refund_expected: Boolean(lockTx),
        lock_tx_hash: lockTx,
      };
      return finishCancel(result);
    }

    throw new ConflictError(`Cannot cancel trade in status ${trade.status}.`);
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'cancelled',
      actor: userId,
      metadata: { cancel_reason: reason ?? null },
    }, error);
    throw error;
  }
}

/**
 * Response shape for POST /trades/:id/refund.
 */
export interface RefundTradeResult {
  status: 'refunded';
  refund_tx_hash: string;
}

/**
 * Shared on-chain refund execution, used by both the user-triggered
 * `refundTrade` and the automatic `sweepPendingRefunds` background job.
 * The contract's `refund()` is permissionless and always pays out to
 * `trade.seller` (whoever originally locked the funds) regardless of who
 * calls it — `actorUserId` only identifies who/what triggered the call for
 * the replay-guard and audit trail, not who receives the funds.
 */
async function executeRefundOnChain(
  request: Pick<FastifyRequest, 'log'>,
  tradeId: string,
  trade: { status: string; secret_hash: string },
  actorUserId: string,
  extraMetadata: Record<string, unknown> = {},
): Promise<RefundTradeResult> {
  let refundTxHash: string;

  if (!config.mockStellar) {
    const secretHashBytes = Buffer.from(trade.secret_hash, 'hex');
    const tradeIdBytes = createHash('sha256').update(secretHashBytes).digest();

    const result = await callRefundOnChain({ request, tradeIdBytes });
    refundTxHash = result.txHash;
  } else {
    refundTxHash = `mock_refund_${Date.now()}`;
  }

  await assertNotReplayed(refundTxHash, 'trade/refund', actorUserId);

  await db.execute(
    `UPDATE trades
     SET status = 'refunded',
         release_tx_hash = $2,
         completed_at = NOW()
     WHERE id = $1`,
    [tradeId, refundTxHash],
  );

  await insertTradeAuditEvent({
    tradeId,
    fromState: trade.status,
    toState: 'refunded',
    actor: actorUserId,
    metadata: {
      success: true,
      refund_tx_hash: refundTxHash,
      ...extraMetadata,
    },
  });

  return { status: 'refunded', refund_tx_hash: refundTxHash };
}

export async function refundTrade(
  request: FastifyRequest,
  tradeId: string,
  userId: string,
): Promise<RefundTradeResult> {
  request.log.info({ trade_id: tradeId, user_id: userId, category: 'trade.lifecycle' }, '[trade] Refunding trade');
  let fromState = UNKNOWN_STATE;

  try {
    const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
    if (!trade) throw new NotFoundError('Trade not found');
    fromState = trade.status;

    // Either participant may trigger the refund — the contract's refund() is
    // permissionless and always pays out to trade.seller (whoever locked the
    // funds), so it doesn't matter which side of the trade calls this. This
    // matters most for the cashout flow, where the caller who locked their
    // own crypto is `seller_id`, not `buyer_id`.
    if (trade.seller_id !== userId && trade.buyer_id !== userId) {
      throw new ForbiddenError('Not a participant of this trade');
    }

    if (!trade.lock_tx_hash) {
      throw new ConflictError('No hay fondos en cadena para reembolsar en este intercambio');
    }

    if (new Date(trade.expires_at) > new Date()) {
      throw new TradeStateError(
        'TRADE_NOT_EXPIRED',
        'El intercambio aún no ha expirado. Espera a que venza el tiempo.',
        `Trade ${tradeId} has not expired yet (expires at ${trade.expires_at})`
      );
    }

    // 'cancelled' is deliberately allowed through here: cancelling a
    // locked/revealing trade (see cancelTrade below) no longer implies the
    // on-chain funds have been settled — it only stops the app-level flow.
    // Only 'completed' (buyer already released) and 'refunded' (already
    // settled) are terminal on-chain states that make a refund() call moot.
    if (['completed', 'refunded'].includes(trade.status)) {
      throw new ConflictError(`No se puede reembolsar un intercambio en estado ${trade.status}`);
    }

    return await executeRefundOnChain(request, tradeId, trade, userId);
  } catch (error) {
    await logTransitionFailure({
      tradeId,
      fromState,
      toState: 'refunded',
      actor: userId,
    }, error);
    throw error;
  }
}

/**
 * Background safety net (see docs/AUDIT_MOBILE_MAINNET.md finding B3):
 * cancelling a 'locked'/'revealing' trade only stops the app-level flow —
 * the contract's refund() requires its on-chain timeout to have passed, so a
 * cancelled trade can be left with real funds still sitting in escrow with
 * no further app-driven trigger. This scans for exactly that situation and
 * settles it automatically, so a user is never depending on remembering to
 * manually retry a refund. Safe to call repeatedly — each trade is only
 * refunded once (replay-guarded by `assertNotReplayed` + the `release_tx_hash
 * IS NULL` filter). Errors are per-trade and non-fatal so one bad trade can't
 * block the rest of the sweep.
 */
export async function sweepPendingRefunds(
  request: Pick<FastifyRequest, 'log'>,
): Promise<{ swept: number; failed: number }> {
  // No `mockStellar` early-return here — `executeRefundOnChain` already
  // branches on it per-trade (mock hash vs real on-chain call), same as
  // `refundTrade`. Skipping the whole sweep in mock mode would leave
  // mock-mode 'cancelled' trades permanently stuck, unlike production.
  const candidates = await db.getMany<{
    id: string; status: string; secret_hash: string; seller_id: string; expires_at: string;
  }>(
    `SELECT id, status, secret_hash, seller_id, expires_at FROM trades
     WHERE status = 'cancelled'
       AND lock_tx_hash IS NOT NULL
       AND release_tx_hash IS NULL
       AND expires_at < NOW()`,
  );

  let swept = 0;
  let failed = 0;

  for (const trade of candidates) {
    // Defense in depth: don't rely solely on the SQL-level expiry filter —
    // re-check in application code before ever calling on-chain refund().
    // The contract itself would reject an early call (TimeoutNotReached),
    // but failing fast here avoids a wasted RPC round-trip either way.
    if (new Date(trade.expires_at) > new Date()) continue;
    try {
      // Attribute the audit trail to the seller (the actual funds recipient)
      // since there's no HTTP-authenticated actor for a background sweep.
      await executeRefundOnChain(request, trade.id, trade, trade.seller_id, {
        triggered_by: 'refund_sweep',
      });
      swept++;
    } catch (err) {
      failed++;
      logger.error(
        { err, trade_id: trade.id, category: 'trade.lifecycle' },
        '[refund-sweep] Failed to auto-refund cancelled trade',
      );
    }
  }

  return { swept, failed };
}

export async function getTradeAuditTrail(tradeId: string, userId: string) {
  await getTradeById(tradeId, userId);

  const events = await getTradeAuditTrailRows(tradeId);
  return events.map((event) => ({
    ...event,
    timestamp: event.occurred_at,
  }));
}

/** Look up audit events by correlation / request ID (support use-case). */
export async function lookupAuditByRequestId(requestId: string) {
  const events = await getAuditEventsByRequestId(requestId);
  return events.map((event) => ({
    ...event,
    timestamp: event.occurred_at,
  }));
}

export async function getMerchantTrades(merchantId: string, state: string = 'all') {
  const statusValues = state === 'all'
    ? ['pending', 'locked', 'revealing', 'completed', 'cancelled', 'refunded']
    : [state];

  const trades = await db.getMany(
    `SELECT
       t.id,
       t.seller_id,
       t.buyer_id,
       t.amount_mxn,
       t.status,
       t.created_at,
       u.username as buyer_handle
     FROM trades t
     JOIN users u ON t.buyer_id = u.id
     WHERE t.seller_id = $1
       AND t.status = ANY($2)
     ORDER BY t.created_at DESC`,
    [merchantId, statusValues],
  );

  return trades;
}

/**
 * Merchant QR scan confirmation endpoint (issue #70).
 *
 * Called when the merchant scans a buyer's QR code. Validates:
 *   1. The trade exists
 *   2. The scanning user is a participant (seller) in the trade
 *   3. The trade has not expired
 *   4. The trade is in the correct state for the scanned QR type
 *
 * Returns a summary suitable for a merchant confirmation screen.
 */
export interface MerchantConfirmResult {
  trade_id: string;
  status: string;
  amount_mxn: number;
  platform_fee_mxn: number;
  buyer_handle: string;
  expires_at: string;
  expired: boolean;
  created_at: string;
  lock_tx_hash: string | null;
  release_tx_hash: string | null;
}

export async function merchantConfirmScan(
  request: FastifyRequest,
  tradeId: string,
  merchantId: string,
  claimToken: string,
): Promise<MerchantConfirmResult> {
  request.log.info(
    { trade_id: tradeId, merchant_id: merchantId, category: 'trade.lifecycle' },
    '[trade] Merchant QR scan confirmation',
  );

  // 1. Trade must exist
  const trade = await db.getOne('SELECT * FROM trades WHERE id = $1', [tradeId]);
  if (!trade) {
    throw new NotFoundError(
      'TRADE_NOT_FOUND',
      'El intercambio no existe o el QR es inválido',
      `Trade ${tradeId} not found`,
    );
  }

  // 2. Scanning user must be the seller (merchant) for this trade
  if (trade.seller_id !== merchantId) {
    throw new ForbiddenError(
      'NOT_PARTICIPANT',
      'No eres participante de este intercambio',
      `User ${merchantId} is not the seller of trade ${tradeId}`,
    );
  }

  // 3. Trade must not already be completed or cancelled
  if (trade.status === 'completed') {
    throw new ConflictError(
      'TRADE_ALREADY_COMPLETED',
      'Este intercambio ya fue completado',
      `Trade ${tradeId} is already completed`,
    );
  }

  if (trade.status === 'cancelled') {
    throw new ConflictError(
      'TRADE_CANCELLED',
      'Este intercambio fue cancelado',
      `Trade ${tradeId} is cancelled`,
    );
  }

  // 4. Check expiry
  const expired = new Date(trade.expires_at) < new Date();
  if (expired) {
    throw new TradeStateError(
      'TRADE_EXPIRED',
      'Este intercambio ha expirado',
      `Trade ${tradeId} expired at ${trade.expires_at}`,
    );
  }

  // 5. El QR debe traer un token vivo y sin usar (SEC-02). Se quema aquí, ya
  //    validado el trade, para que un QR contra un trade inválido no lo gaste.
  await consumeClaimToken(tradeId, claimToken, merchantId);

  // Fetch buyer info for display
  const buyer = await db.getOne<{ username: string }>(
    'SELECT username FROM users WHERE id = $1',
    [trade.buyer_id],
  );

  return {
    trade_id: trade.id,
    status: trade.status,
    amount_mxn: Number(trade.amount_mxn),
    platform_fee_mxn: Number(trade.platform_fee_mxn ?? 0),
    buyer_handle: buyer?.username ?? 'Usuario MicoPay',
    expires_at: trade.expires_at,
    expired: false,
    created_at: trade.created_at,
    lock_tx_hash: trade.lock_tx_hash ?? null,
    release_tx_hash: trade.release_tx_hash ?? null,
  };
}
