import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createRateLimiter } from '../middleware/rateLimit.middleware.js';
import { config } from '../config.js';
import * as tradeService from '../services/trade.service.js';

const tradeRateLimit = createRateLimiter({
  windowMs: config.tradeRateLimitWindowMs,
  max: config.tradeRateLimitMax,
  keyGenerator: (req) => req.user?.id || req.ip,
});

export async function tradeRoutes(app: FastifyInstance) {
  // All trade routes require authentication
  app.addHook('preHandler', authMiddleware);

  /**
   * POST /trades
   * Creates a trade between the caller and a counterparty. The caller is the
   * buyer by default (matches "buy crypto with cash" / deposit flow, where the
   * counterparty-merchant locks funds as seller). Pass `role: 'seller'` for
   * the reverse direction ("convert crypto to cash" / cashout flow), where the
   * caller is the one giving up crypto — the escrow contract only lets the
   * seller side lock funds and reveal the HTLC secret, so the caller must be
   * seller_id there, not buyer_id.
   */
  app.post('/trades', {
    preHandler: [tradeRateLimit],
    schema: {
      body: {
        type: 'object',
        required: ['counterparty_id', 'amount_mxn'],
        properties: {
          counterparty_id: { type: 'string', format: 'uuid' },
          amount_mxn: { type: 'integer', minimum: 100, maximum: 50000 },
          role: { type: 'string', enum: ['buyer', 'seller'], default: 'buyer' },
        },
        additionalProperties: false,
      },
    },
  }, async (request, reply) => {
    const { counterparty_id, amount_mxn, role = 'buyer' } = request.body as {
      counterparty_id: string;
      amount_mxn: number;
      role?: 'buyer' | 'seller';
    };
    const callerId = request.user.id;
    const sellerId = role === 'seller' ? callerId : counterparty_id;
    const buyerId = role === 'seller' ? counterparty_id : callerId;

    const trade = await tradeService.createTrade({
      request,
      sellerId,
      buyerId,
      amountMxn: amount_mxn,
    });

    // Don't expose encrypted secret fields in response
    const { secret_enc, secret_nonce, ...safeTrade } = trade;

    reply.status(201);
    return { trade: safeTrade };
  });

  /**
   * GET /trades/active
   * List active trades for the authenticated user.
   */
  app.get('/trades/active', async (request) => {
    const trades = await tradeService.getActiveTrades(request.user.id);
    const safeTrades = trades.map(({ secret_enc, secret_nonce, ...t }: any) => t);
    return { trades: safeTrades };
  });

  /**
   * GET /trades/history
   * All trades (active + completed) for the authenticated user, newest first.
   */
  app.get('/trades/history', async (request) => {
    const { status, page, limit } = request.query as { status?: string; page?: string; limit?: string };
    const trades = await tradeService.getTradeHistory(
      request.user.id,
      status,
      page ? parseInt(page) : 1,
      limit ? parseInt(limit) : 20
    );
    return { trades };
  });

  /**
   * GET /trades/:id
   * Get trade detail (only for participants).
   */
  app.get('/trades/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { trade, merchant_unavailable, seller_username, buyer_username } =
      await tradeService.getTradeDetailForParticipant(id, request.user.id);

    const { secret_enc, secret_nonce, ...safeTrade } = trade;
    return { trade: safeTrade, merchant_unavailable, seller_username, buyer_username };
  });

  /**
   * POST /trades/:id/lock/prepare
   * Seller-only. Returns an unsigned lock() XDR for the seller to sign
   * client-side with their own key (the contract requires seller.require_auth()).
   */
  app.post('/trades/:id/lock/prepare', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.prepareLockTrade(request, id, request.user.id);
  });

  /**
   * POST /trades/:id/lock
   * Seller-only. Submits the seller-signed lock() XDR and returns the tx hash.
   */
  app.post('/trades/:id/lock', {
    schema: {
      body: {
        type: 'object',
        properties: {
          signed_xdr: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { signed_xdr } = (request.body as { signed_xdr?: string } | undefined) ?? {};
    return tradeService.lockTrade(request, id, request.user.id, signed_xdr);
  });

  /**
   * POST /trades/:id/reveal
   * Seller confirms cash was received. Enables secret access.
   */
  app.post('/trades/:id/reveal', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.revealTrade(request, id, request.user.id);
  });

  /**
   * GET /trades/:id/secret
   * Seller gets the HTLC secret to show QR to buyer.
   * Only available in 'revealing' state.
   */
  app.get('/trades/:id/secret', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.getTradeSecret(
      request,
      id,
      request.user.id,
      request.ip,
      request.headers['user-agent'] || 'unknown',
    );
  });

  /**
   * POST /trades/:id/complete/prepare
   * Buyer-only. Returns an unsigned release() XDR for the buyer to sign
   * client-side with their own key (the contract requires buyer.require_auth()).
   */
  app.post('/trades/:id/complete/prepare', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.prepareReleaseTrade(request, id, request.user.id);
  });

  /**
   * POST /trades/:id/complete
   * Buyer confirms cash received. Submits the buyer-signed release() XDR and returns the tx hash.
   */
  app.post('/trades/:id/complete', {
    schema: {
      body: {
        type: 'object',
        properties: {
          signed_xdr: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { signed_xdr } = (request.body as { signed_xdr?: string } | undefined) ?? {};
    return tradeService.completeTrade(request, id, request.user.id, signed_xdr);
  });

  /**
   * POST /trades/:id/cancel
   *
   * Returns `{ status, refund_expected, lock_tx_hash }` for client copy (#20). Errors use `{ error, message }`
   * (`ConflictError`, `ForbiddenError`, …) from the global Fastify error handler.
   */
  app.post('/trades/:id/cancel', async (request) => {
    const { id } = request.params as { id: string };
    const { reason } = (request.body as { reason?: string } | undefined) ?? {};
    return tradeService.cancelTrade(request, id, request.user.id, reason);
  });

  /**
   * POST /trades/:id/refund
   *
   * Buyer triggers on-chain refund for an expired trade. Calls refund() on the Soroban contract
   * and transitions the trade to 'refunded' status. Returns `{ status, refund_tx_hash }`.
   * Errors use `{ error, message }` via the global Fastify error handler.
   */
  app.post('/trades/:id/refund', async (request) => {
    const { id } = request.params as { id: string };
    return tradeService.refundTrade(request, id, request.user.id);
  });

  /**
   * GET /trades/:id/audit
   * Ordered trade transition audit trail for support/ops.
   */
  app.get('/trades/:id/audit', async (request) => {
    const { id } = request.params as { id: string };
    const audit = await tradeService.getTradeAuditTrail(id, request.user.id);
    return { audit };
  });

  /**
   * GET /audit/lookup?request_id=<uuid>
   * Look up audit events by correlation ID. Useful for support when a user
   * reports a support code — support can find the request_id from logs and
   * query this endpoint to see exactly what happened.
   */
  app.get('/audit/lookup', {
    schema: {
      querystring: {
        type: 'object',
        required: ['request_id'],
        properties: {
          request_id: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (request) => {
    const { request_id } = request.query as { request_id: string };
    const events = await tradeService.lookupAuditByRequestId(request_id);
    return { audit: events };
  });

  /**
   * POST /trades/:id/merchant-confirm
   * El comercio escanea el QR del usuario. Valida trade, participante, estado y
   * expiración, y quema el `claim_token` del QR (SEC-02) para que un mismo
   * código no sirva dos veces. Devuelve el resumen para la pantalla de
   * confirmación — no mueve fondos.
   */
  app.post('/trades/:id/merchant-confirm', {
    schema: {
      body: {
        type: 'object',
        required: ['claim_token'],
        properties: {
          claim_token: { type: 'string', pattern: '^[0-9a-fA-F]{64}$' },
        },
        additionalProperties: false,
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { claim_token } = request.body as { claim_token: string };
    return tradeService.merchantConfirmScan(request, id, request.user.id, claim_token);
  });

  /**
   * GET /merchants/me/trades
   * List incoming trades for the authenticated merchant, filtered by state.
   * Returns trades where merchant is the seller, newest first.
   */
  app.get('/merchants/me/trades', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          state: {
            type: 'string',
            enum: ['all', 'pending', 'locked', 'revealing', 'completed', 'cancelled', 'expired', 'refunded'],
            default: 'all'
          },
        },
      },
    },
  }, async (request) => {
    const { state } = request.query as { state?: string };
    const trades = await tradeService.getMerchantTrades(request.user.id, state || 'all');
    return { trades };
  });
}
