import axios from 'axios';
import { extractApiErrorPayload, toApiError } from '../utils/apiError';
import { signChallenge, getPublicKey, signTransactionXdr } from '../lib/keystore';
import { removeKey } from './secureStorage';
import { PLATFORM_FEE_PERCENT } from '../constants/trade';


const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

const http = axios.create({ baseURL: BASE_URL });

function authHeaders(token: string) {
  return { headers: { Authorization: `Bearer ${token}` } };
}

// ─── DeFi: KYC (hosted flows — Etherfuse for CETES onboarding, Didit for #314's
// tiered gate; both share the same POST start / GET status polling contract) ──

export type KYCProvider = 'etherfuse' | 'didit';
export type KYCStatus = 'pending' | 'approved' | 'rejected';

export interface KYCStatusResponse {
  status: KYCStatus;
  reason?: string | null;
}

/**
 * Generates a short-lived (≈15 min) onboarding URL.
 * URL must be generated at button touch (not earlier).
 */
export async function startKYC(
  token: string,
  provider: KYCProvider = 'etherfuse',
): Promise<{ onboardingUrl: string }> {
  const res = await http.post('/defi/kyc/start', {}, { ...authHeaders(token), params: { provider } });
  return res.data;
}

/**
 * Poll KYC verification status.
 */
export async function getKYCStatus(
  token: string,
  provider: KYCProvider = 'etherfuse',
): Promise<KYCStatusResponse> {
  const res = await http.get('/defi/kyc/status', { ...authHeaders(token), params: { provider } });
  return res.data;
}


export interface UserData {
  id: string;
  username: string;
  token: string;
}

export interface CurrentUserProfile {
  id: string;
  username: string;
  stellar_address: string;
  phone_hash?: string | null;
  deleted_at?: string | null;
  wallet_type?: string | null;
  created_at?: string;
  /** Completed trades (reputation) — computed by GET /users/me */
  trades_completed?: number;
  /** Completion rate (%) over terminal trades, null if no history */
  completion_rate?: number | null;
  /** Reputation tier: Nuevo | Bronce | Plata | Oro */
  reputation_tier?: string;
}

export interface TradeData {
  id: string;
  status: string;
  secret_hash: string;
  amount_mxn: number;
  lock_tx_hash?: string | null;
  release_tx_hash?: string | null;
}

export interface TradeDetailResponse {
  trade: TradeData & {
    lock_tx_hash?: string | null;
    release_tx_hash?: string | null;
    platform_fee_mxn?: number;
    seller_id?: string;
    buyer_id?: string;
    created_at?: string;
    completed_at?: string | null;
    expires_at?: string;
  };
  merchant_unavailable: boolean;
  seller_username: string | null;
  buyer_username: string | null;
}

export async function fetchTradeDetail(tradeId: string, buyerToken: string): Promise<TradeDetailResponse> {
  const res = await http.get(`/trades/${tradeId}`, authHeaders(buyerToken));
  return res.data;
}

/** Mirrors backend `CancelTradeResult` after POST /trades/:id/cancel (#20). */
export interface CancelTradeResponse {
  status: 'cancelled';
  refund_expected: boolean;
  lock_tx_hash: string | null;
}

export async function cancelTradeRequest(tradeId: string, buyerToken: string): Promise<CancelTradeResponse> {
  try {
    const res = await http.post(`/trades/${tradeId}/cancel`, {}, authHeaders(buyerToken));
    return res.data as CancelTradeResponse;
  } catch (e: unknown) {
    throw toApiError(extractApiErrorPayload(e));
  }
}

export async function patchMerchantAvailability(
    token: string,
    merchant_available: boolean,
): Promise<{ merchant_available: boolean }> {
  const res = await http.patch('/users/me', { merchant_available }, authHeaders(token));
  return res.data.user;
}

/**
 * Registers a new user. The backend requires proof that this device holds
 * stellar_address's private key (same challenge/response dance as login) —
 * otherwise anyone could register someone else's public Stellar address
 * before they do. See docs/AUDIT_MOBILE_MAINNET.md, "Registro sin prueba de
 * posesión de llave".
 *
 * `phoneHash` stays optional and is forwarded untouched: it belongs to the
 * anti-abuse controls added in #319 and is unrelated to key possession.
 */
export async function registerUser(username: string, phoneHash?: string): Promise<UserData> {
  // No fallback address here: a synthetic address whose key we do not hold
  // could never sign the challenge, so it would fail server-side anyway.
  const stellar_address = await getPublicKey();
  if (!stellar_address) {
    throw new Error('No device keypair found — generateAndStoreKeypair() must run before registerUser()');
  }

  const challengeRes = await fetch(`${BASE_URL}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address }),
  });
  const challengeData = await challengeRes.json();
  const challenge: string | undefined = challengeData.challenge;
  if (!challenge) throw new Error(`Auth challenge failed (${challengeRes.status}): ${challengeData.error ?? 'no challenge'}`);

  const signature = await signChallenge(challenge);

  const body: Record<string, string> = { username, stellar_address, challenge, signature };
  if (phoneHash) {
    body.phone_hash = phoneHash;
  }
  const res = await http.post("/users/register", body);
  return { ...res.data.user, token: res.data.token };
}

export async function getAuthToken(username: string): Promise<string> {
  const stellar_address = await getPublicKey();
  if (!stellar_address) {
    throw new Error('No device keypair found — generateAndStoreKeypair() must run before getAuthToken()');
  }

  // Step 1: request a one-time challenge from the server
  const challengeRes = await fetch(`${BASE_URL}/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address }),
  });
  const challengeData = await challengeRes.json();
  const challenge: string | undefined = challengeData.challenge;
  if (!challenge) throw new Error(`Auth challenge failed (${challengeRes.status}): ${challengeData.error ?? 'no challenge'}`);

  // Step 2: sign with the device keypair — private key never leaves the device
  const signature = await signChallenge(challenge);

  // Step 3: exchange challenge + signature for a JWT
  const tokenRes = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stellar_address, challenge, signature }),
  });
  const tokenData = await tokenRes.json();
  const token: string | undefined = tokenData.token;
  if (!token) throw new Error(tokenData.error ?? `Auth failed (${tokenRes.status})`);

  return token;
}

/**
 * Creates a trade between the caller and a counterparty.
 * `role` is the caller's role in the escrow: 'buyer' (default — the caller
 * receives crypto, e.g. depositing cash for crypto) or 'seller' (the caller
 * gives up crypto, e.g. cashing out — the escrow contract requires the
 * seller to be the one who locks funds and reveals the HTLC secret).
 */
export async function createTrade(
    counterpartyId: string,
    amountMxn: number,
    callerToken: string,
    role: 'buyer' | 'seller' = 'buyer',
): Promise<TradeData> {
  try {
    const res = await http.post(
        '/trades',
        { counterparty_id: counterpartyId, amount_mxn: amountMxn, role },
        authHeaders(callerToken),
    );
    return res.data.trade;
  } catch (e: unknown) {
    throw toApiError(extractApiErrorPayload(e));
  }
}

export async function getTrade(
    tradeId: string,
    token: string,
): Promise<TradeData> {
  const res = await http.get(`/trades/${tradeId}`, authHeaders(token));
  return res.data.trade;
}

/**
 * Locks the trade on-chain. The seller's own device key signs the lock()
 * call locally (the contract requires seller.require_auth()) — the backend
 * only ever sees the already-signed transaction.
 */
export async function lockTrade(
    tradeId: string,
    sellerToken: string,
): Promise<{ lock_tx_hash: string }> {
  const prepareRes = await http.post(
      `/trades/${tradeId}/lock/prepare`,
      {},
      authHeaders(sellerToken),
  );
  const prepared = prepareRes.data as { mock: true } | { xdr: string; network_passphrase: string };
  const signedXdr = 'mock' in prepared ? undefined : await signTransactionXdr(prepared.xdr, prepared.network_passphrase);

  const res = await http.post(
      `/trades/${tradeId}/lock`,
      signedXdr ? { signed_xdr: signedXdr } : {},
      authHeaders(sellerToken),
  );
  return { lock_tx_hash: res.data.lock_tx_hash };
}

export async function revealTrade(
    tradeId: string,
    sellerToken: string,
): Promise<void> {
  await http.post(
      `/trades/${tradeId}/reveal`,
      undefined,
      authHeaders(sellerToken),
  );
}

/**
 * Devuelve el QR de cobro del vendedor. El payload lleva un token opaco de un
 * solo uso, no el preimage HTLC (SEC-02).
 */
export async function getSecret(
    tradeId: string,
    sellerToken: string,
): Promise<{ qr_payload: string; expires_at: string; expires_in: number }> {
  const res = await http.get(
      `/trades/${tradeId}/secret`,
      authHeaders(sellerToken),
  );
  return res.data;
}

export interface CompleteTradeResponse {
  status: string;
  release_tx_hash: string;
}

/**
 * Releases the trade on-chain. The buyer's own device key signs the release()
 * call locally (the contract requires buyer.require_auth()) — the backend
 * only ever sees the already-signed transaction.
 */
export async function completeTrade(
    tradeId: string,
    buyerToken: string,
): Promise<CompleteTradeResponse> {
  const prepareRes = await http.post(`/trades/${tradeId}/complete/prepare`, {}, authHeaders(buyerToken));
  const prepared = prepareRes.data as { mock: true } | { xdr: string; network_passphrase: string };
  const signedXdr = 'mock' in prepared ? undefined : await signTransactionXdr(prepared.xdr, prepared.network_passphrase);

  const res = await http.post(`/trades/${tradeId}/complete`, signedXdr ? { signed_xdr: signedXdr } : {}, authHeaders(buyerToken));
  return res.data;
}

export interface RefundTradeResponse {
  status: 'refunded';
  refund_tx_hash: string;
}

export async function refundTradeRequest(tradeId: string, token: string): Promise<RefundTradeResponse> {
  try {
    const res = await http.post(`/trades/${tradeId}/refund`, {}, authHeaders(token));
    return res.data as RefundTradeResponse;
  } catch (e: unknown) {
    const { message } = extractApiErrorPayload(e);
    throw new Error(message);
  }
}

export interface TradeHistoryItem {
  id: string;
  status: string;
  amount_mxn: number;
  platform_fee_mxn: number;
  lock_tx_hash: string | null;
  release_tx_hash: string | null;
  created_at: string;
  completed_at: string | null;
  seller_id: string;
  buyer_id: string;
}

export interface MerchantTrade {
  id: string;
  buyer_handle: string;
  amount_mxn: number;
  status: string;
  created_at: string;
}

export async function getMerchantTrades(
    token: string,
    state: string = 'all',
): Promise<MerchantTrade[]> {
  const res = await http.get(`/merchants/me/trades?state=${state}`, authHeaders(token));
  return res.data.trades;
}

export async function getTradeHistory(
    token: string,
): Promise<TradeHistoryItem[]> {
  const res = await http.get("/trades/history", authHeaders(token));
  return res.data.trades;
}

export async function getCurrentUser(
    token: string,
): Promise<CurrentUserProfile> {
  const res = await http.get("/users/me", authHeaders(token));
  return res.data.user;
}

export async function deleteAccount(
    token: string,
    username: string,
): Promise<{ status: string }> {
  const res = await http.post(
      "/users/me/delete",
      { username },
      authHeaders(token),
  );
  return res.data;
}

export async function getAccountBalance(): Promise<{
  xlm: string;
  address: string;
}> {
  const res = await http.get("/account/balance");
  return res.data;
}

export type Availability = 'online' | 'offline' | 'paused';

export async function setAvailability(availability: Availability, token: string): Promise<void> {
  await http.patch('/users/me/availability', { availability }, authHeaders(token));
}

// ─── DeFi: CETES ──────────────────────────────────────────────────────────

export interface CETESRate {
  apy: number;
  xlmPerUsdc: number;
  cetesIssuer: string;
  cesPriceMxn: number;
  network: string;
  note: string;
}

export interface CETESTxResult {
  hash: string;
  status: string;
  simulated: boolean;
  amount: string;
  sourceAsset?: string;
  cetesReceived?: string;
  destReceived?: string;
  explorerUrl: string;
  note?: string;
}

export interface XlmMxnRate {
  rate: number;
  source: string;
  fetchedAt: string;
  /** true cuando se sirvió la última cotización conocida porque las fuentes fallaron. */
  stale?: boolean;
}

export async function getXlmMxnRate(): Promise<XlmMxnRate> {
  const res = await http.get('/rate/xlm-mxn');
  return res.data;
}

/**
 * USDC→MXN desde el backend (multi-fuente + caché). El frontend nunca debe
 * llevar un FX literal: si esto falla, la UI muestra "—"
 * (docs/AUDIT_MOBILE_MAINNET.md §3).
 */
export async function getUsdcMxnRate(): Promise<XlmMxnRate> {
  const res = await http.get('/rate/usdc-mxn');
  return res.data;
}

export async function getCETESRate(amount = "100"): Promise<CETESRate> {
  const res = await http.get(`/defi/cetes/rate?amount=${amount}`);
  return res.data;
}

export async function buyCETES(
    amount: string,
    sourceAsset: "XLM" | "USDC" | "MXNe",
): Promise<CETESTxResult> {
  const res = await http.post("/defi/cetes/buy", { amount, sourceAsset });
  return res.data;
}

export async function sellCETES(
    amount: string,
    destAsset: "XLM" | "USDC" | "MXNe",
): Promise<CETESTxResult> {
  const res = await http.post("/defi/cetes/sell", { amount, destAsset });
  return res.data;
}

// ─── DeFi: Blend ──────────────────────────────────────────────────────────

export interface BlendPoolAsset {
  code: string;
  supplyApy: number;
  borrowApy: number;
  liquidity: number;
}

export interface BlendPool {
  id: string;
  name: string;
  tvl: number;
  assets: BlendPoolAsset[];
}

export interface BlendPoolsResponse {
  pools: BlendPool[];
  network: string;
  simulated: boolean;
}

export interface BlendTxResult {
  hash: string;
  status: string;
  simulated: boolean;
  amount: string;
  asset: string;
  explorerUrl: string;
  note?: string;
}

export async function getBlendPools(): Promise<BlendPoolsResponse> {
  const res = await http.get("/defi/blend/pools");
  return res.data;
}

export async function blendSupply(
    amount: string,
    asset: string,
    collateral = false,
): Promise<BlendTxResult> {
  const res = await http.post("/defi/blend/supply", {
    amount,
    asset,
    collateral,
  });
  return res.data;
}

export async function blendBorrow(
    amount: string,
    asset: string,
): Promise<BlendTxResult> {
  const res = await http.post("/defi/blend/borrow", { amount, asset });
  return res.data;
}

export interface MerchantConfig {
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
}

export interface UserProfile {
  id: string;
  username: string;
  stellar_address: string;
  wallet_type?: string;
  rate_percent?: number;
  min_trade_mxn?: number;
  max_trade_mxn?: number;
  daily_cap_mxn?: number;
  kyc_status?: string;
  clabe?: string;
}

export async function getMyProfile(token: string): Promise<UserProfile> {
  const res = await http.get('/users/me', authHeaders(token));
  return res.data.user;
}

export async function getMerchantConfig(token: string): Promise<MerchantConfig> {
  const res = await http.get('/merchants/me/config', authHeaders(token));
  return res.data.config;
}

export async function updateMerchantConfig(token: string, config: MerchantConfig): Promise<MerchantConfig> {
  const res = await http.put('/merchants/me/config', config, authHeaders(token));
  return res.data.config;
}

type QueueFn = (type: string, payload: unknown) => Promise<string>;

export async function updateMerchantConfigWithOfflineSupport(
  token: string,
  config: MerchantConfig,
  queueFn: QueueFn,
): Promise<{ config: MerchantConfig; queued: boolean }> {
  try {
    const updated = await updateMerchantConfig(token, config);
    return { config: updated, queued: false };
  } catch {
    await queueFn('config', { config });
    return { config, queued: true };
  }
}

export async function updateMerchantAvailabilityWithOfflineSupport(
  token: string,
  available: boolean,
  queueFn: QueueFn,
): Promise<{ queued: boolean }> {
  try {
    await patchMerchantAvailability(token, available);
    return { queued: false };
  } catch {
    await queueFn('availability', { available });
    return { queued: true };
  }
}

// ─── Merchant discovery (#102) ────────────────────────────────────────────

/** Mirrors backend `AvailableMerchant` from GET /merchants/available. */
export interface AvailableMerchant {
  seller_id: string;
  username: string;
  rate_percent: number;
  min_trade_mxn: number;
  max_trade_mxn: number;
  daily_cap_mxn: number;
  latitude: number;
  longitude: number;
  address_text: string | null;
  distance_km: number;
  /** Payout the buyer receives for the requested amount. */
  payout_mxn: number;
  /** Reputation: fraction 0..1 of completed trades (optional) */
  completion_rate?: number;
  /** Total completed trades (optional) */
  trades_completed?: number;
  /** Reputation tier (optional) */
  tier?: string;
  /** Optional seller type flag coming from API (e.g. 'business' | 'individual') */
  seller_type?: string;
  /** Backwards-compatible boolean marker for business sellers (optional) */
  is_business?: boolean;
  /** Platform fee (%) for this merchant. Falls back to PLATFORM_FEE_PERCENT if absent. */
  platform_fee_pct?: number;
}

/**
 * Effective-fee guardrail. Validations V-1/V-3/V-7/V-8 found a universal ceiling:
 * users abandon MicoPay when the *total* cost exceeds ~5%. The UI warns above this
 * threshold. Kept here (not hardcoded in components) so it can be tuned centrally.
 */
export const MAX_EFFECTIVE_FEE_PERCENT = 5;

/**
 * Total effective cost the user pays = provider commission + platform fee.
 * `platformPct` defaults to the shared `PLATFORM_FEE_PERCENT` constant because the
 * `/merchants/available` response does not (yet) carry a per-merchant platform fee.
 */
export function effectiveFeePercent(
  providerPct: number,
  platformPct: number = PLATFORM_FEE_PERCENT,
): number {
  return providerPct + platformPct;
}

export interface MerchantsAvailableQuery {
  lat: number;
  lng: number;
  radius_km: number;
  amount_mxn: number;
  flow?: 'cashout' | 'deposit';
}

/**
 * Public endpoint: find merchants near the caller that can handle the amount.
 * No auth required.
 */
export async function getMerchantsAvailable(
  query: MerchantsAvailableQuery,
): Promise<AvailableMerchant[]> {
  const params: Record<string, string | number> = {
    lat: query.lat,
    lng: query.lng,
    radius_km: query.radius_km,
    amount_mxn: query.amount_mxn,
  };
  if (query.flow) params.flow = query.flow;

  const res = await http.get('/merchants/available', { params });
  return res.data.merchants;
}

// ─── Merchant QR scan confirmation (issue #70) ────────────────────────────

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

/**
 * Merchant scans a QR containing a trade_id and calls the backend to validate
 * that the trade exists, the merchant is a participant, and the trade state is valid.
 */
export async function merchantConfirmScan(
  tradeId: string,
  claimToken: string,
  token: string,
): Promise<MerchantConfirmResult> {
  try {
    const res = await http.post(
      `/trades/${tradeId}/merchant-confirm`,
      { claim_token: claimToken },
      authHeaders(token),
    );
    return res.data as MerchantConfirmResult;
  } catch (e: unknown) {
    const { message } = extractApiErrorPayload(e);
    throw new Error(message);
  }
}

// ─── DeFi: SPEI Onramp / Offramp (Etherfuse) ─────────────────────────────

export interface RampQuote {
  quoteId: string;
  type: 'onramp' | 'offramp';
  exchangeRate: string;
  sourceAmount: string;
  destinationAmount: string;
  expiresAt: string;
}

export interface RampOrder {
  orderId: string;
  depositClabe?: string;
  depositAmount?: string;
  depositBankName?: string;
  depositAccountHolder?: string;
  withdrawAnchorAccount?: string;
  withdrawMemo?: string;
  withdrawMemoType?: string;
}

export interface RampOrderStatus {
  orderId: string;
  status: 'pending' | 'funded' | 'completed' | 'failed';
  type: 'onramp' | 'offramp';
  stellarTxHash?: string;
}

export interface BankAccountResult {
  bankAccountId: string;
  clabe: string;
}

export async function getRampQuote(
  type: 'onramp' | 'offramp',
  sourceAmount: string,
  token: string,
): Promise<RampQuote> {
  const res = await http.post(
    '/defi/ramp/quote',
    { type, sourceAsset: 'MXN', targetAsset: 'CETES', sourceAmount },
    authHeaders(token),
  );
  return res.data as RampQuote;
}

/**
 * Creates a ramp order (SPEI onramp deposit instructions, or offramp anchor
 * account+memo). `bankAccountId` is resolved server-side from the caller's
 * onboarded Etherfuse profile — the backend ignores it if sent, so it is not
 * a parameter here. `useAnchor` (offramp only) requests anchor-rail withdraw
 * instructions instead of a raw wallet payout.
 */
export async function createRampOrder(
  quoteId: string,
  token: string,
  useAnchor = true,
): Promise<RampOrder> {
  const res = await http.post(
    '/defi/ramp/order',
    { quoteId, useAnchor },
    authHeaders(token),
  );
  return res.data as RampOrder;
}

export async function getRampOrderStatus(
  orderId: string,
  token: string,
): Promise<RampOrderStatus> {
  const res = await http.get(`/defi/ramp/order/${orderId}`, authHeaders(token));
  return res.data as RampOrderStatus;
}

export async function regenerateRampOrderTx(orderId: string, token: string): Promise<RampOrder> {
  const res = await http.post(`/defi/ramp/order/${orderId}/regenerate_tx`, {}, authHeaders(token));
  return res.data as RampOrder;
}

// Global 401 handler: clear the persisted session and bounce to login.
http.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      removeKey('micopay_user');
      window.location.href = '/#/login';
    }
    return Promise.reject(error);
  }
);
