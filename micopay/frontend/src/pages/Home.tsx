import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../components/Logo';
import ErrorBanner from '../components/ErrorBanner';
import {
  getTradeHistory,
  getMerchantTrades,
  getXlmMxnRate,
  TradeHistoryItem,
  getCurrentUser,
} from '../services/api';
import { mapApiError, type MappedApiError } from '../utils/apiError';
import { useWalletBalance } from '../hooks/useWalletBalance';
import { getPendingSignatureRequests, SignatureRequest } from '../services/signRequestService';

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";

const STATUS_COLOR: Record<string, string> = {
  completed: "text-[#1D9E75]",
  locked: "text-primary",
  revealing: "text-primary",
  pending: "text-outline",
  cancelled: "text-error",
  refunded: "text-outline",
};

interface HomeProps {
  onNavigateCashout: () => void;
  onNavigateDeposit: () => void;
  onNavigateHistory?: () => void;
  token: string | null;
  merchantToken: string | null;
  onNavigateInbox: () => void;
  username?: string | null;
}

const Home = ({
  onNavigateCashout,
  onNavigateDeposit,
  onNavigateHistory,
  token,
  merchantToken,
  onNavigateInbox,
  username: usernameProp,
}: HomeProps) => {
  const [trades, setTrades] = useState<TradeHistoryItem[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [xlmMxnRate, setXlmMxnRate] = useState<number | null>(null);
  const [rateLoading, setRateLoading] = useState(true);
  const [rateError, setRateError] = useState(false);
  const [historyError, setHistoryError] = useState<MappedApiError | null>(null);
  const [pendingError, setPendingError] = useState<MappedApiError | null>(null);

  const {
    balance: mxneBalance,
    xlmBalance,
    stellarAddress: rawStellarAddress,
    loading: balanceLoading,
    error: walletBalanceError,
    refresh: loadBalance,
    tokens,
    usdMxnRate,
  } = useWalletBalance();

  const stellarAddress = rawStellarAddress || "";

  const [showBalanceError, setShowBalanceError] = useState(false);

  useEffect(() => {
    if (walletBalanceError) {
      setShowBalanceError(true);
    } else {
      setShowBalanceError(false);
    }
  }, [walletBalanceError]);

  const loadHistory = useCallback(() => {
    if (!token) return;
    setHistoryError(null);
    getTradeHistory(token)
      .then(setTrades)
      .catch((e) => {
        setHistoryError(mapApiError(e));
        setTrades([]);
      });
  }, [token]);

  const loadPendingCount = useCallback(() => {
    if (!merchantToken) return;
    setPendingError(null);
    getMerchantTrades(merchantToken, 'pending')
      .then((items) => setPendingCount(items.length))
      .catch((e) => setPendingError(mapApiError(e)));
  }, [merchantToken]);

  const [pendingSignRequests, setPendingSignRequests] = useState<SignatureRequest[]>([]);

  useEffect(() => {
    if (!token) return;
    getPendingSignatureRequests(token)
      .then((requests) => setPendingSignRequests(requests))
      .catch(() => setPendingSignRequests([]));
  }, [token]);

  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    loadPendingCount();
  }, [loadPendingCount]);

  useEffect(() => {
    let cancelled = false;
    setRateLoading(true);
    setRateError(false);
    getXlmMxnRate()
      .then((data) => {
        if (!cancelled) {
          setXlmMxnRate(data.rate);
          setRateLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRateError(true);
          setRateLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, []);

  const MXN_PEGGED = new Set(['MXNE', 'MXNe', 'CETES', 'GTOKEN', 'MXN']);

  // Sin cotización no se muestra un monto: un FX inventado sobre dinero real da
  // cifras equivocadas (docs/AUDIT_MOBILE_MAINNET.md §3).
  const ratesReady = xlmMxnRate != null && usdMxnRate != null && !rateError;

  const totalMxn = ratesReady
    ? tokens.reduce((sum, t) => {
        if (t.code === 'XLM') return sum + t.balance * xlmMxnRate!;
        if (t.code === 'USDC') return sum + t.balance * usdMxnRate!;
        if (MXN_PEGGED.has(t.code)) return sum + t.balance;
        return sum;
      }, 0)
    : null;

  const mxnBalance = balanceLoading || rateLoading || totalMxn == null
    ? "—"
    : `$${totalMxn.toLocaleString("es-MX", { maximumFractionDigits: 2 })} MXN`;

  // Per-asset MXN value for the XLM row (its own value, not the grand total).
  const rawXlm = tokens.find((t) => t.code === 'XLM')?.balance ?? 0;
  const xlmMxnValue = balanceLoading || rateLoading || rateError || xlmMxnRate == null
    ? "—"
    : `$${(rawXlm * xlmMxnRate).toLocaleString("es-MX", { maximumFractionDigits: 2 })} MXN`;

  const today = new Date().toLocaleDateString("es-MX", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  const { t } = useTranslation();

  const [availability, setAvailabilityState] = useState<
    "online" | "offline" | "paused"
  >("online");

  const username = usernameProp || '';

  useEffect(() => {
    if (!merchantToken) return;
    getCurrentUser(merchantToken)
      .then((user: any) => {
        const status = user.verification_status;
        setAvailabilityState(
          status === "verified"
            ? "online"
            : status === "paused"
              ? "paused"
              : "offline",
        );
      })
      .catch(() => {});
  }, [merchantToken]);

  return (
    <div className="bg-surface text-on-surface font-body min-h-screen flex flex-col">
      {/* TopAppBar */}
      <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-md bg-white/90">
        <Logo />
        <div className="flex items-center gap-4">
          <button
            onClick={onNavigateInbox}
            className="relative p-2 rounded-full hover:bg-surface-container-low transition-colors"
          >
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-primary"
            >
              notifications
            </span>
            {pendingCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-error text-white text-[10px] font-bold w-5 h-5 rounded-full flex items-center justify-center">
                {pendingCount}
              </span>
            )}
          </button>
          <div className="w-10 h-10 rounded-full border-2 border-primary-container bg-surface-container-low flex items-center justify-center">
            <svg
              fill="none"
              height="20"
              viewBox="0 0 24 24"
              width="20"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="7" cy="7" r="3" stroke="#1A2830" strokeWidth="2" />
              <circle cx="17" cy="17" r="3" stroke="#1D9E75" strokeWidth="2" />
              <path
                d="M10 10L14 14"
                stroke="#00694C"
                strokeLinecap="round"
                strokeWidth="2"
              />
            </svg>
          </div>
        </div>
      </header>

      <main className="flex-1 mt-[5.5rem] px-6 pb-32" style={{ paddingTop: 'max(0px, env(safe-area-inset-top))' }}>
        {availability === "paused" && (
          <div className="mb-6 bg-error/10 border border-error/20 rounded-2xl p-4 flex items-center gap-3">
            <span className="material-symbols-outlined text-error">
              pause_circle
            </span>
            <div className="flex-1">
              <p className="text-sm font-bold text-error">
                {t('home.operationsPaused')}
              </p>
              <p className="text-[11px] text-error/80">
                {t('home.operationsPausedDesc')}
              </p>
            </div>
          </div>
        )}
        {/* Pending Signature Requests Banner */}
        {pendingSignRequests.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-center justify-between shadow-sm">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-700">
                <span className="material-symbols-outlined text-xl">gavel</span>
              </div>
              <div>
                <p className="text-sm font-bold text-amber-900">
                  {t('signatureApproval.externalRequestHeader')}
                </p>
                <p className="text-xs text-amber-700">
                  {pendingSignRequests.length} {t('signatureApproval.requestSourceLabel').toLowerCase()}
                </p>
              </div>
            </div>
            <a
              href={`/#/sign-request/${pendingSignRequests[0].id}`}
              className="px-3.5 py-2 bg-amber-600 hover:bg-amber-700 text-white rounded-xl text-xs font-bold transition-colors"
            >
              {t('signatureApproval.title')}
            </a>
          </div>
        )}

        {/* Saludo */}
        <section className="mb-8">
          <h1 className="font-headline font-extrabold text-3xl text-on-surface leading-tight mb-1">
            {t('home.greeting', { name: username || '...' })}
          </h1>
          <p className="text-on-surface-variant font-medium opacity-70 capitalize">
            {today}
          </p>
        </section>

        {showBalanceError && walletBalanceError ? (
          <ErrorBanner
            message={walletBalanceError.message || "Error al cargar el balance"}
            action="retry"
            onRetry={loadBalance}
            onDismiss={() => setShowBalanceError(false)}
            supportState="HOME_BALANCE"
            className="mb-4"
          />
        ) : null}

        {/* Balance Card */}
        <div onClick={loadBalance} className="bg-primary rounded-[24px] p-6 relative overflow-hidden mb-8 shadow-xl shadow-primary/20 active:opacity-80 cursor-pointer">
          <div className="absolute -right-8 -bottom-8 opacity-20 pointer-events-none text-white">
            <svg
              fill="none"
              height="180"
              viewBox="0 0 24 24"
              width="180"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle
                cx="7"
                cy="7"
                r="3"
                stroke="#D4E4EC"
                strokeWidth="1.5"
              ></circle>
              <circle
                cx="17"
                cy="17"
                r="3"
                stroke="#D4E4EC"
                strokeWidth="1.5"
              ></circle>
              <path d="M10 10L14 14" stroke="#D4E4EC" strokeWidth="1.5"></path>
            </svg>
          </div>
          <div className="flex justify-between items-start relative z-10 mb-6">
            <p className="text-[10px] font-bold tracking-[0.15em] text-white/70 uppercase">
              {t('home.totalValue')}
            </p>
            <div className="flex items-center justify-center bg-white/10 rounded-full p-1">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-white text-sm"
              >
                rocket_launch
              </span>
            </div>
          </div>
          <div className="relative z-10 mb-4">
            <h2 className="text-[36px] font-headline font-extrabold text-white tracking-tight">
              {balanceLoading ? t('home.loadingBalance') : walletBalanceError ? "--" : mxnBalance}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              <span className="w-2.5 h-2.5 rounded-full bg-[#5DCAA5] animate-pulse shadow-[0_0_8px_#5DCAA5]"></span>
              <p className="text-[#5DCAA5] text-sm font-bold">
                {walletBalanceError
                  ? t('home.notAvailable')
                  : balanceLoading
                    ? t('home.loadingBalanceStatus')
                    : t('home.stellarTestnet')}
              </p>
            </div>
          </div>
        </div>

        {/* Activos */}
        <section className="mb-8">
          <h2 className="text-[11px] font-bold text-outline-variant uppercase tracking-[0.15em] mb-4">
            {t('home.assets')}
          </h2>
          <div className="bg-white rounded-[20px] border border-outline-variant/10 shadow-sm divide-y divide-outline-variant/10">
            {/* XLM */}
            <div className="flex items-center gap-4 p-4">
              <div className="w-10 h-10 rounded-full bg-[#7B61FF]/10 flex items-center justify-center flex-shrink-0">
                <span className="text-[#7B61FF] font-black text-sm">XLM</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface text-sm">
                  Stellar Lumens
                </p>
                <p className="text-[11px] text-outline truncate font-mono">
                  {stellarAddress
                    ? `${stellarAddress.substring(0, 8)}…${stellarAddress.slice(-6)}`
                    : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-on-surface text-sm">
                  {xlmBalance ?? "—"} XLM
                </p>
                <p className="text-[11px] text-outline">{xlmMxnValue}</p>
              </div>
            </div>
            {/* MXNE */}
            <div className={`flex items-center gap-4 p-4 ${balanceLoading ? 'opacity-40' : ''}`}>
              <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <span className="text-primary font-black text-xs">MXNE</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface text-sm">
                  Peso Digital (MXNE)
                </p>
                <p className="text-[11px] text-outline truncate font-mono">
                  {stellarAddress
                    ? `${stellarAddress.substring(0, 8)}…${stellarAddress.slice(-6)}`
                    : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-on-surface text-sm">
                  {balanceLoading ? "—" : walletBalanceError ? "--" : mxneBalance}
                </p>
              </div>
            </div>
            {/* USDC */}
            <div className={`flex items-center gap-4 p-4 ${balanceLoading ? 'opacity-40' : ''}`}>
              <div className="w-10 h-10 rounded-full bg-[#2775CA]/10 flex items-center justify-center flex-shrink-0">
                <span className="text-[#2775CA] font-black text-xs">USDC</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-on-surface text-sm">
                  USD Coin
                </p>
                <p className="text-[11px] text-outline truncate font-mono">
                  {stellarAddress
                    ? `${stellarAddress.substring(0, 8)}…${stellarAddress.slice(-6)}`
                    : "—"}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-on-surface text-sm">
                  {balanceLoading
                    ? "—"
                    : walletBalanceError
                      ? "--"
                      : `${(tokens.find((t) => t.code === 'USDC')?.balance ?? 0).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDC`}
                </p>
              </div>
            </div>
          </div>
        </section>

        {pendingError ? (
          <ErrorBanner
            message={pendingError.message}
            action={pendingError.action}
            onRetry={loadPendingCount}
            onDismiss={() => setPendingError(null)}
            supportState="HOME_PENDING"
            className="mb-4"
          />
        ) : null}

        {/* Actividad */}
        <section className="mb-8">
          <h2 className="text-[11px] font-bold text-outline-variant uppercase tracking-[0.15em] mb-4">
            {t('home.recentActivity')}
          </h2>

          {historyError ? (
            <ErrorBanner
              message={historyError.message}
              action={historyError.action}
              onRetry={loadHistory}
              onDismiss={() => setHistoryError(null)}
              supportState="HOME_HISTORY"
            />
          ) : trades.length === 0 ? (
            <div className="bg-white rounded-[20px] border border-outline-variant/10 shadow-sm p-6 text-center">
              <span
                aria-hidden="true"
                className="material-symbols-outlined text-outline-variant text-3xl mb-2 block"
              >
                receipt_long
              </span>
              <p className="text-sm text-outline font-medium">
                {t('home.noTransactions')}
              </p>
            </div>
          ) : (
            <div className="bg-white rounded-[20px] border border-outline-variant/10 shadow-sm divide-y divide-outline-variant/10">
              {trades.map((trade) => {
                const s = {
                  label: t(`home.status.${trade.status}`, { defaultValue: trade.status }),
                  color: STATUS_COLOR[trade.status] ?? "text-outline",
                };
                const date = new Date(trade.created_at).toLocaleString(
                  "es-MX",
                  {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  },
                );
                return (
                  <div key={trade.id} className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                          <span
                            aria-hidden="true"
                            className="material-symbols-outlined text-primary text-base"
                          >
                            swap_horiz
                          </span>
                        </div>
                        <div>
                          <p className="font-bold text-on-surface text-sm">
                            ${trade.amount_mxn.toLocaleString("es-MX")} MXN
                          </p>
                          <p className="text-[11px] text-outline">{date}</p>
                        </div>
                      </div>
                      <span className={`text-[11px] font-bold ${s.color}`}>
                        {s.label}
                      </span>
                    </div>

                    {/* TX links */}
                    <div className="flex flex-col gap-1 pl-12">
                      {trade.lock_tx_hash &&
                        !trade.lock_tx_hash.startsWith("mock") && (
                          <a
                            href={`${EXPLORER}/${trade.lock_tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-primary font-mono flex items-center gap-1 hover:underline"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[12px]"
                            >
                              lock
                            </span>
                            lock · {trade.lock_tx_hash.substring(0, 14)}…
                          </a>
                        )}
                      {trade.release_tx_hash &&
                        !trade.release_tx_hash.startsWith("mock") && (
                          <a
                            href={`${EXPLORER}/${trade.release_tx_hash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[11px] text-[#1D9E75] font-mono flex items-center gap-1 hover:underline"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[12px]"
                            >
                              lock_open
                            </span>
                            release · {trade.release_tx_hash.substring(0, 14)}…
                          </a>
                        )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Network indicator */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <span className="text-base" style={{ filter: 'grayscale(1) sepia(1) saturate(5) hue-rotate(-50deg) brightness(0.9)' }} aria-hidden="true">🍄</span>
          <span className="text-xs font-semibold text-on-surface-variant tracking-wide">
            Red Micopay
          </span>
        </div>

        {/* CTAs */}
        <div className="flex flex-col items-center gap-4">
          <button
            onClick={onNavigateCashout}
            aria-label={t('home.cashout')}
            className="w-full h-[56px] bg-gradient-to-r from-primary to-primary-container text-white font-bold rounded-xl shadow-md active:scale-95 transition-all duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              payments
            </span>
            {t('home.cashout')}
          </button>
          <button
            onClick={onNavigateDeposit}
            aria-label={t('home.deposit')}
            className="w-full h-[56px] bg-gradient-to-r from-[#1D9E75] to-[#14815F] text-white font-bold rounded-xl shadow-md active:scale-95 transition-all duration-200 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <span aria-hidden="true" className="material-symbols-outlined">
              add_circle
            </span>
            {t('home.deposit')}
          </button>
          <p className="text-sm text-on-surface-variant font-medium opacity-60">
            {t('home.findNearby')}
          </p>
        </div>
      </main>
    </div>
  );
};

export default Home;
