import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { QRCodeSVG } from 'qrcode.react';
import { getSecret, revealTrade, lockTrade, getTrade, TradeData } from '../services/api';
import { ensureTrustline } from '../services/payment';
import { getTradeStateDebugOverride, normalizeTradeState, TradeState } from '../components/TradeStateBadge';
import ErrorBanner from '../components/ErrorBanner';
import SupportLink from '../components/SupportLink';
import { mapApiError, type MappedApiError } from '../utils/apiError';
import { getDemoQrPayload, IS_DEMO_MODE } from '../utils/demoMode';
import { buildTxUrl } from '../utils/stellarExplorer';
import { useCountdown } from '../hooks/useCountdown';

interface QRRevealProps {
    activeTrade: TradeData | null;
    sellerToken: string | null;
    buyerToken: string | null;
    amount: number;
    /** Counterparty shown in the header — who the seller is meeting. */
    counterpartyName?: string | null;
    /** The current (seller) device's own username, shown on the QR card so
     * the counterparty can visually confirm they're scanning the right person's code. */
    ownName?: string | null;
    onBack: () => void;
    onChat: () => void;
    onSuccess: (releaseTxHash: string) => void;
}

const QRReveal = ({ activeTrade, sellerToken, buyerToken, amount, counterpartyName, ownName, onBack, onChat, onSuccess }: QRRevealProps) => {
    const { t } = useTranslation();
    const [qrPayload, setQrPayload] = useState<string | null>(null);
    const [qrExpiresAt, setQrExpiresAt] = useState<string | null>(null);
    const [secretLoaded, setSecretLoaded] = useState(false);
    const [secretLoading, setSecretLoading] = useState(false);
    const [secretError, setSecretError] = useState<MappedApiError | null>(null);
    const [lockTxHash, setLockTxHash] = useState<string | null>(null);
    const [completedTxHash, setCompletedTxHash] = useState<string | null>(null);
    const [tradeState, setTradeState] = useState<TradeState>('locked');

    const loadSecret = useCallback(async () => {
        if (!activeTrade || !sellerToken) return;

        setSecretLoading(true);
        setSecretError(null);

        try {
            // This is the seller's own screen, so drive the whole
            // pending -> locked -> revealing chain here if needed — nothing
            // else in the app triggers the lock/reveal steps on its own.
            if (activeTrade.status === 'pending') {
                const escrowAssetCode = import.meta.env.VITE_ESCROW_ASSET_CODE || 'USDC';
                await ensureTrustline(escrowAssetCode);
                await lockTrade(activeTrade.id, sellerToken);
            }
            // Swallow errors here: if the trade was already revealed (stale
            // local status), the reveal call 409s but getSecret still works.
            await revealTrade(activeTrade.id, sellerToken).catch(() => {});
            const { qr_payload, expires_at } = await getSecret(activeTrade.id, sellerToken);
            setQrPayload(qr_payload);
            setQrExpiresAt(expires_at);
            setSecretLoaded(true);

            const fresh = await getTrade(activeTrade.id, sellerToken).catch(() => null);
            if (fresh?.lock_tx_hash) setLockTxHash(fresh.lock_tx_hash);
        } catch (e) {
            if (IS_DEMO_MODE) {
                setQrPayload(getDemoQrPayload());
                setQrExpiresAt(null);
                setSecretLoaded(true);
            } else {
                setSecretError(mapApiError(e));
                setQrPayload(null);
                setSecretLoaded(false);
            }
        } finally {
            setSecretLoading(false);
        }
    }, [activeTrade, sellerToken]);

    useEffect(() => {
        loadSecret();
    }, [loadSecret]);

    // Only the buyer can call release() — this device is the seller, so poll
    // until the counterparty completes it instead of trying to do it here.
    useEffect(() => {
        if (!activeTrade || !sellerToken || !secretLoaded) return;

        const poll = async () => {
            try {
                const fresh = await getTrade(activeTrade.id, sellerToken);
                if (fresh.status === 'completed' && fresh.release_tx_hash) {
                    setCompletedTxHash(fresh.release_tx_hash);
                }
            } catch {
                // keep polling
            }
        };

        poll();
        const interval = setInterval(poll, 4000);
        return () => clearInterval(interval);
    }, [activeTrade, sellerToken, secretLoaded]);

    useEffect(() => {
        if (completedTxHash) {
            const timer = setTimeout(() => onSuccess(completedTxHash), 1500);
            return () => clearTimeout(timer);
        }
    }, [completedTxHash, onSuccess]);

    useEffect(() => {
        const fallbackState: TradeState = secretLoaded ? 'revealed' : 'locked';
        const backendState = normalizeTradeState(activeTrade?.status, fallbackState);
        setTradeState(getTradeStateDebugOverride(backendState));
    }, [activeTrade?.status, secretLoaded]);



    // UX_MANIFESTO, pantalla QR: "make expiration visible". El código caduca
    // antes que el trade, así que expirado NO significa fondos perdidos —
    // basta con pedir uno nuevo.
    const { label: qrCountdown, expired: qrExpired } = useCountdown(qrExpiresAt);
    const showQr = secretLoaded && qrPayload && !secretError && !qrExpired;

    return (
        <div className="bg-surface font-body text-on-surface min-h-screen">
            {/* Top Navigation */}
            <header className="fixed top-0 left-0 w-full z-50 flex justify-between items-center px-6 py-4 pt-[max(1rem,env(safe-area-inset-top))] backdrop-blur-md bg-white/90 border-b border-outline-variant/20">
                <div className="flex items-center gap-3">
                    <button onClick={onBack} aria-label="Volver" className="p-2 hover:bg-surface-container-low rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary">arrow_back</span>
                    </button>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <h1 className="font-headline font-bold text-lg text-on-surface">{counterpartyName ?? '—'}</h1>
                            <span className="bg-secondary-container text-secondary text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider">{t('qrReveal.verified')}</span>
                        </div>
                    </div>
                </div>
                <button aria-label="Más opciones" className="w-10 h-10 rounded-full bg-surface-container-low flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-primary">
                    <span aria-hidden="true" className="material-symbols-outlined text-primary">more_vert</span>
                </button>
            </header>

            <main className="pt-[calc(6rem+env(safe-area-inset-top))] pb-12 px-6 max-w-md mx-auto">
                {/* Status Banner */}
                <div className="mb-8">
                    <div className="inline-flex items-center gap-2 bg-primary-container/10 border border-primary-container/20 px-4 py-2 rounded-full">
                        <span aria-hidden="true" className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                        <span className="text-primary font-semibold text-sm">
                            {secretLoaded ? t('qrReveal.onchainEscrowLocked') : t('qrReveal.offerAcceptedLocked')}
                        </span>
                    </div>
                </div>

                {/* Chat Preview Section */}
                <section className="mb-10">
                    <div className="bg-surface-container-lowest border border-surface-container-low p-4 rounded-2xl shadow-sm">
                        <div className="flex gap-3 mb-4">
                            <div className="w-10 h-10 rounded-full bg-surface-container-high flex-shrink-0 flex items-center justify-center overflow-hidden">
                                <img
                                    className="w-full h-full object-cover"
                                    alt="Pharmacist"
                                    src="https://lh3.googleusercontent.com/aida-public/AB6AXuBKVHp5dyl0kxM83DVzGyzATg7Y2rWOd2uBB75zzCKjwdx5XBJ1hm2cpi0EmKLMdkS2b7KqgqNnQAO-bISXYa8IukOGxVY7WxThGBL_y_Mh2mQIdpi7A4P4yQFSg89545NSeRagiTRwjV-R0x8HVCIMo_BzpCAriGHdw3jgs8Wtw-D-3iFQYRhj1_1yo_b2o8RrrHMvwhxouUN3a-9SHvBQKrguCmQQV5tKNj1I70aK59bJHEhfMvqnNOvKg6gU9Tc834bGs8Xah50H"
                                />
                            </div>
                            <div>
                                <p className="text-sm font-medium text-on-surface-variant">
                                    <span className="font-bold text-on-surface">{counterpartyName ?? '—'}:</span>&nbsp;Estamos en Av. Juárez 34, a un costado del banco.
                                </p>
                            </div>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={onChat}
                                aria-label="Abrir chat con el agente"
                                className="flex-1 py-2 px-4 rounded-lg border border-primary text-primary font-bold text-sm hover:bg-primary/5 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">chat</span>
                                {t('qrReveal.openChat')}
                            </button>
                            <button aria-label="Ver ubicación del agente" className="flex-1 py-2 px-4 rounded-lg border border-primary text-primary font-bold text-sm hover:bg-primary/5 transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary">
                                <span aria-hidden="true" className="material-symbols-outlined text-sm">location_on</span>
                                {t('qrReveal.location')}
                            </button>
                        </div>
                    </div>
                </section>

                {/* QR Section */}
                <section className="mb-10 text-center">
                    <h2 className="text-[11px] font-bold text-outline-variant uppercase tracking-[0.2em] mb-6">{t('qrReveal.exchangeCode')}</h2>

                    {secretLoading ? (
                        <div className="flex flex-col items-center gap-3 py-12">
                            <div className="relative w-8 h-8">
                                <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
                                <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                            </div>
                            <p className="text-sm font-medium text-outline">{t('qrReveal.generatingCode')}</p>
                        </div>
                    ) : secretError ? (
                        <ErrorBanner
                            variant="blocking"
                            message={secretError.message}
                            action={secretError.action}
                            onRetry={loadSecret}
                            supportTradeId={activeTrade?.id}
                            supportState="QR_REVEAL_SECRET"
                        />
                    ) : qrExpired ? (
                        <div className="flex flex-col items-center gap-4 py-10">
                            <span aria-hidden="true" className="material-symbols-outlined text-outline text-4xl">timer_off</span>
                            <p className="text-sm font-semibold text-on-surface">{t('qrReveal.codeExpired')}</p>
                            <p className="text-xs text-outline max-w-xs">{t('qrReveal.codeExpiredFunds')}</p>
                            <button
                                onClick={loadSecret}
                                className="mt-1 px-5 py-2.5 rounded-full bg-primary text-on-primary text-sm font-bold hover:opacity-90 transition-opacity focus:outline-none focus:ring-2 focus:ring-primary"
                            >
                                {t('qrReveal.newCode')}
                            </button>
                        </div>
                    ) : showQr ? (
                        <div className="bg-surface-container-low p-8 rounded-[32px] inline-block mx-auto mb-6 border border-outline-variant/10 shadow-sm">
                            <QRCodeSVG
                                value={qrPayload}
                                size={224}
                                bgColor="transparent"
                                fgColor="#1A1C1E"
                                level="M"
                                style={{ borderRadius: '12px' }}
                            />
                            <div className="mt-6">
                                <h3 className="font-headline font-extrabold text-xl text-on-surface">{ownName ?? '—'}</h3>
                                <p className="mt-2 font-headline font-black text-2xl text-on-surface">${amount} MXN</p>
                                {qrCountdown && (
                                    <p className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-primary">
                                        <span aria-hidden="true" className="material-symbols-outlined text-[14px]">timer</span>
                                        {t('qrReveal.codeExpiresIn', { time: qrCountdown })}
                                    </p>
                                )}
                                {secretLoaded && (
                                    <p className="text-[10px] text-primary mt-1 font-mono opacity-70">
                                        {t('qrReveal.htlcTestnet')}
                                    </p>
                                )}
                                {lockTxHash && (
                                    <a
                                        href={buildTxUrl(lockTxHash)}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="mt-2 flex items-center justify-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors font-mono"
                                    >
                                        <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                                        {t('qrReveal.viewLockOnExplorer')}
                                    </a>
                                )}
                            </div>
                        </div>
                    ) : null}
                </section>

                {/* Buyer completion status — this device (seller) can only wait */}
                {showQr && (
                    <section className="mb-10 text-center">
                        {completedTxHash ? (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <span aria-hidden="true" className="material-symbols-outlined text-primary text-4xl" style={{ fontVariationSettings: '"FILL" 1' }}>check_circle</span>
                                <p className="text-sm font-semibold text-primary">{t('qrReveal.released')}</p>
                                <a
                                    href={buildTxUrl(completedTxHash)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-primary/70 hover:text-primary transition-colors font-mono"
                                >
                                    <span className="material-symbols-outlined text-[14px]">open_in_new</span>
                                    {t('chatRoom.viewOnStellarTestnet')}
                                </a>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center gap-3 py-4">
                                <div className="relative w-8 h-8">
                                    <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
                                    <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
                                </div>
                                <p className="text-sm font-medium text-outline">{t('qrReveal.waitingForBuyer')}</p>
                            </div>
                        )}
                    </section>
                )}

                <footer className="mt-12 text-center pb-10 space-y-3">
                    <p className="text-[12px] text-outline leading-relaxed px-6 font-medium">
                        {t('qrReveal.autoCancelNotice')}
                    </p>
                    <SupportLink tradeId={activeTrade?.id} state="QR_REVEAL" />
                </footer>
            </main>
        </div>
    );
};

export default QRReveal;
