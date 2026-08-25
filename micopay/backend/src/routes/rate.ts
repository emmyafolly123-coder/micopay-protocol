import type { FastifyInstance } from 'fastify';
import { UpstreamError } from '../utils/errors.js';

const CACHE_TTL_MS = 60_000;
const TIMEOUT_MS = 5_000;

interface CacheEntry {
  rate: number;
  source: string;
  fetchedAt: string;
}

const caches: Record<string, CacheEntry | null> = {};

/** @internal — exposed for testing */
export function __resetCache(): void {
  for (const key of Object.keys(caches)) delete caches[key];
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

const j = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json', 'User-Agent': 'micopay/1.0' } }).then(
    (r) => {
      if (!r.ok) throw new Error(`${url} → ${r.status}`);
      return r.json() as Promise<any>;
    },
  );

/** USD→MXN from er-api (open, no key). */
async function getUsdMxn(): Promise<number> {
  const d = await j('https://open.er-api.com/v6/latest/USD');
  const v = Number(d?.rates?.MXN);
  if (!(v > 0)) throw new Error('er-api MXN missing');
  return v;
}

/**
 * Live XLM→MXN sources, ordered by reliability from a US datacenter egress
 * (Render). Coinbase/Kraken allow US/cloud IPs; Binance geo-blocks them;
 * CoinGecko rate-limits them. First source that returns a valid rate wins.
 */
const SOURCES: Array<() => Promise<CacheEntry>> = [
  // Coinbase XLM-USD × er-api USD-MXN
  async () => {
    const d = await j('https://api.coinbase.com/v2/prices/XLM-USD/spot');
    const xlmUsd = Number(d?.data?.amount);
    if (!(xlmUsd > 0)) throw new Error('coinbase bad');
    return { rate: round(xlmUsd * (await getUsdMxn())), source: 'coinbase+erapi', fetchedAt: new Date().toISOString() };
  },
  // Kraken XLMUSD × er-api USD-MXN
  async () => {
    const d = await j('https://api.kraken.com/0/public/Ticker?pair=XLMUSD');
    const xlmUsd = parseFloat(d?.result?.XXLMZUSD?.c?.[0]);
    if (!(xlmUsd > 0)) throw new Error('kraken bad');
    return { rate: round(xlmUsd * (await getUsdMxn())), source: 'kraken+erapi', fetchedAt: new Date().toISOString() };
  },
  // CoinGecko direct XLM→MXN
  async () => {
    const d = await j('https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=mxn');
    const rate = Number(d?.stellar?.mxn);
    if (!(rate > 0)) throw new Error('coingecko bad');
    return { rate, source: 'coingecko', fetchedAt: new Date().toISOString() };
  },
  // Binance XLMUSDT × er-api (may be geo-blocked)
  async () => {
    const d = await j('https://api.binance.com/api/v3/ticker/price?symbol=XLMUSDT');
    const xlmUsd = parseFloat(d?.price);
    if (!(xlmUsd > 0)) throw new Error('binance bad');
    return { rate: round(xlmUsd * (await getUsdMxn())), source: 'binance+erapi', fetchedAt: new Date().toISOString() };
  },
];

/**
 * USDC→MXN. USDC is USD-pegged but can drift, so the first source prices the
 * peg itself (USDC-USD) instead of assuming 1:1. Same egress ordering as XLM:
 * Coinbase first, CoinGecko last (it rate-limits datacenter IPs).
 */
const USDC_SOURCES: Array<() => Promise<CacheEntry>> = [
  // Coinbase USDC-USD × er-api USD-MXN
  async () => {
    const d = await j('https://api.coinbase.com/v2/prices/USDC-USD/spot');
    const usdcUsd = Number(d?.data?.amount);
    if (!(usdcUsd > 0)) throw new Error('coinbase usdc bad');
    return { rate: round(usdcUsd * (await getUsdMxn())), source: 'coinbase+erapi', fetchedAt: new Date().toISOString() };
  },
  // er-api USD-MXN, assuming the peg holds
  async () => {
    return { rate: round(await getUsdMxn()), source: 'erapi', fetchedAt: new Date().toISOString() };
  },
  // CoinGecko direct USDC→MXN
  async () => {
    const d = await j('https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=mxn');
    const rate = Number(d?.['usd-coin']?.mxn);
    if (!(rate > 0)) throw new Error('coingecko usdc bad');
    return { rate, source: 'coingecko', fetchedAt: new Date().toISOString() };
  },
];

/**
 * Cache → live sources → stale cache → 503.
 *
 * Nunca se inventa un tipo de cambio: `docs/AUDIT_MOBILE_MAINNET.md` §3 ("los
 * fallbacks deben mostrar '—' y deshabilitar el submit, no inventar un número")
 * y `src/tests/rateCache.test.ts`, que exige 503 `RATE_FETCH_FAILED` cuando no
 * hay fuente viva ni caché. El estimado fijo que había aquí (3.2 MXN/XLM)
 * contradecía ambos.
 */
async function resolveRate(
  pair: string,
  sources: Array<() => Promise<CacheEntry>>,
  request: { log: { warn: (obj: unknown, msg: string) => void } },
) {
  const cached = caches[pair];
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
    return cached;
  }

  for (const source of sources) {
    try {
      const fresh = await source();
      caches[pair] = fresh;
      return fresh;
    } catch (err) {
      request.log.warn({ err: err instanceof Error ? err.message : err, category: 'rate', pair }, '[rate] source failed, trying next');
    }
  }

  if (cached) return { ...cached, stale: true };

  throw new UpstreamError(
    'RATE_FETCH_FAILED',
    'No pudimos obtener el tipo de cambio. Intenta de nuevo en un momento.',
    `No live source returned a ${pair} rate and there is no cached value`,
    503,
  );
}

export async function rateRoutes(app: FastifyInstance) {
  app.get('/rate/xlm-mxn', async (request) => resolveRate('xlm-mxn', SOURCES, request));

  app.get('/rate/usdc-mxn', async (request) => resolveRate('usdc-mxn', USDC_SOURCES, request));
}
