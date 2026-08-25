import { useEffect, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';

import {
  fetchTradeDetail,
  completeTrade,
  cancelTradeRequest,
  refundTradeRequest,
  lockTrade,
  TradeDetailResponse,
} from '../services/api';
import { ensureTrustline } from '../services/payment';
import { errorMessages } from '../constants/errorMessages';
import { readJSON } from '../services/secureStorage';
import { useCountdown } from '../hooks/useCountdown';
import { buildTxUrl } from '../utils/stellarExplorer';
import { mapApiError } from '../utils/apiError';

type TradeDetailData = TradeDetailResponse['trade'] & {
  platform_fee_mxn?: number;
  release_tx_hash?: string | null;
  completed_at?: string | null;
};

interface TradeDetailProps {
  buyerToken: string | null;
  sellerToken: string | null;
  onBack: () => void;
}

async function getStoredUser(): Promise<{ id: string; token: string } | null> {
  try {
    return await readJSON<{ id: string; token: string }>('micopay_user');
  } catch {
    return null;
  }
}

async function getStoredToken(): Promise<string | null> {
  const stored = await getStoredUser();
  return stored?.token ?? null;
}

async function isCurrentUserBuyer(tradeBuyerId: string): Promise<boolean> {
  const stored = await getStoredUser();
  return stored?.id === tradeBuyerId;
}

async function isCurrentUserSeller(tradeSellerId: string): Promise<boolean> {
  const stored = await getStoredUser();
  return stored?.id === tradeSellerId;
}

const TRADE_POLL_INTERVAL = 5000;
const SUPPORT_EMAIL = 'support@micopay.io';

const ACTIVE_STATES = ['pending', 'locked', 'revealing'];

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  pending: { label: 'Pendiente', color: '#f59e0b', icon: 'hourglass_top' },
  locked: { label: 'Bloqueado', color: '#3b82f6', icon: 'lock' },
  revealing: { label: 'Revelando', color: '#8b5cf6', icon: 'qr_code' },
  revealed: { label: 'Revelado', color: '#06b6d4', icon: 'visibility' },
  completed: { label: 'Completado', color: '#22c55e', icon: 'check_circle' },
  cancelled: { label: 'Cancelado', color: '#ef4444', icon: 'cancel' },
  expired: { label: 'Expirado', color: '#6b7280', icon: 'schedule' },
  refunded: { label: 'Reembolsado', color: '#8b5cf6', icon: 'undo' },
};

function TradeStateBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.pending;

  return (
    <div
      className="inline-flex items-center gap-2 px-4 py-2 rounded-full"
      style={{
        background: `${config.color}20`,
        border: `1px solid ${config.color}40`,
      }}
    >
      <span className="material-symbols-outlined text-sm" style={{ color: config.color, fontVariationSettings: '"FILL" 1' }}>
        {config.icon}
      </span>
      <span className="text-sm font-semibold" style={{ color: config.color }}>
        {config.label}
      </span>
    </div>
  );
}

function SupportLink() {
  return (
    <div className="mt-8 text-center">
      <p className="text-sm text-on-surface-variant">
        ¿Necesitas ayuda?{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`} className="text-primary font-semibold hover:underline">
          Contactar soporte
        </a>
      </p>
    </div>
  );
}

// ── State-specific views ────────────────────────────────────────────────────

function PendingView({
  trade,
  onCancel,
  isSeller,
  onLock,
  locking,
  lockError,
}: {
  trade: TradeDetailData;
  onCancel: () => void;
  isSeller: boolean;
  onLock: () => void;
  locking: boolean;
  lockError: string | null;
}) {
  const { label: countdownLabel, expired: countdownExpired } = useCountdown(trade.expires_at ?? null);
  const countdown = countdownExpired ? 'Expirado' : countdownLabel;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-amber-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-amber-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          hourglass_top
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">
        {isSeller ? 'Bloquea los fondos para iniciar' : 'Esperando al vendedor'}
      </h2>
      <p className="text-on-surface-variant mb-6">
        {isSeller
          ? 'Firma con tu llave para bloquear los fondos en el contrato de garantía.'
          : 'El vendedor aún no ha bloqueado los fondos. Tu operación está segura en garantía.'}
      </p>

      <div className="bg-surface-container-low rounded-xl p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Expira en</span>
          <span className="text-sm font-semibold text-primary">{countdown}</span>
        </div>
      </div>

      {lockError && (
        <div className="mb-4 w-full rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
          {lockError}
        </div>
      )}

      {isSeller && (
        <button
          onClick={onLock}
          disabled={locking}
          className="w-full py-3 mb-4 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {locking ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Bloqueando…
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>lock</span>
              Bloquear fondos
            </>
          )}
        </button>
      )}

      <button
        onClick={onCancel}
        disabled={locking}
        className="w-full py-3 rounded-xl border border-error text-error font-semibold hover:bg-error/5 transition-colors disabled:opacity-50"
      >
        Cancelar operación
      </button>
    </div>
  );
}

function LockedView({ trade }: { trade: TradeDetailData }) {

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-blue-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          lock
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Fondos bloqueados</h2>
      <p className="text-on-surface-variant mb-6">
        Los fondos están seguros en el contrato inteligente. Esperando confirmación del vendedor.
      </p>

      {trade.lock_tx_hash && (
        <a
          href={buildTxUrl(trade.lock_tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <button className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity">
        Abrir chat con el vendedor
      </button>
    </div>
  );
}

function RevealingView({ trade }: { trade: TradeDetailData }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-purple-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          qr_code
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Mostrar tu QR</h2>
      <p className="text-on-surface-variant mb-6">
        El vendedor confirmó el pago. Muestra tu código QR para completar la operación.
      </p>

      <button className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity mb-4">
        Ver mi QR de intercambio
      </button>

      <button className="w-full py-3 rounded-xl border border-primary text-primary font-semibold hover:bg-primary/5 transition-colors">
        Abrir chat
      </button>
    </div>
  );
}

function RevealedView({ trade, onComplete, token }: { trade: TradeDetailData; onComplete: () => void; token: string | null }) {
  const [isConfirming, setIsConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // La pantalla sólo avanza a "completado" si el release confirmó de verdad.
  // Antes el catch sólo logueaba y el finally transicionaba igual, así que un
  // release fallido —o la falta de token— se mostraba como éxito
  // (docs/AUDIT_MOBILE_MAINNET.md §4, "honestidad sobre fondos").
  const handleConfirm = async () => {
    if (isConfirming) return;
    setIsConfirming(true);
    setConfirmError(null);
    try {
      const effectiveToken = token ?? (await getStoredToken());
      if (!effectiveToken) throw new Error('NO_TOKEN');
      await completeTrade(trade.id, effectiveToken);
      setTimeout(() => onComplete(), 1500);
    } catch (e) {
      setIsConfirming(false);
      // El motivo lo traduce mapApiError (el mapeo de errores del repo); lo
      // único que se añade es dónde quedó el dinero, que UX_MANIFESTO exige
      // decir en todo estado de error.
      const reason = e instanceof Error && e.message === 'NO_TOKEN'
        ? 'Tu sesión expiró. Vuelve a entrar para confirmar.'
        : mapApiError(e).message;
      setConfirmError(`${reason} El dinero sigue retenido en la garantía.`);
    }
  };

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-cyan-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-cyan-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          visibility
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Confirmar recepción</h2>
      <p className="text-on-surface-variant mb-6">
        ¿Ya recibiste el efectivo? Confirma para liberar los fondos al vendedor.
      </p>

      {confirmError && (
        <div className="w-full mb-4 rounded-xl border border-red-200 bg-red-50 p-4 text-left">
          <p className="text-sm font-semibold text-red-800">No se pudo confirmar</p>
          <p className="mt-1 text-sm text-red-700">{confirmError}</p>
        </div>
      )}

      {!isConfirming ? (
        <button
          onClick={handleConfirm}
          className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>
            {confirmError ? 'refresh' : 'check_circle'}
          </span>
          {confirmError ? 'Reintentar' : 'Ya recibí el efectivo'}
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 py-4">
          <div className="relative w-8 h-8">
            <div className="absolute inset-0 border-4 border-surface-container-high rounded-full"></div>
            <div className="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>
          <p className="text-sm font-medium text-outline">Confirmando intercambio…</p>
        </div>
      )}
    </div>
  );
}

function CompletedView({ trade }: { trade: TradeDetailData }) {

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-green-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          check_circle
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">¡Operación completada!</h2>
      <p className="text-on-surface-variant mb-6">Tu intercambio fue exitoso.</p>

      <div className="bg-surface-container-low rounded-xl p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Fecha</span>
          <span className="text-sm text-on-surface">
            {trade.completed_at ? new Date(trade.completed_at).toLocaleString('es-MX') : '-'}
          </span>
        </div>
      </div>

      {trade.release_tx_hash && (
        <a
          href={buildTxUrl(trade.release_tx_hash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <Link
        to="/"
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

function CancelledView() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          cancel
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Operación cancelada</h2>
      <p className="text-on-surface-variant mb-6">
        Esta operación fue cancelada. Tus fondos están seguros.
      </p>

      <Link
        to="/"
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

/**
 * Shown both for the (currently unreachable — the backend never persists
 * status='expired') 'expired' state and for a 'cancelled' trade that still
 * has real on-chain funds pending refund (lock_tx_hash set, release_tx_hash
 * unset). See docs/AUDIT_MOBILE_MAINNET.md finding B3.
 */
function ExpiredView({ canRefund, onRefund, refunding, trade, title, description }: {
  canRefund: boolean;
  onRefund: () => void;
  refunding: boolean;
  trade: TradeDetailData;
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-gray-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          schedule
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{title}</h2>
      <p className="text-on-surface-variant mb-6">{description}</p>

      <div className="bg-surface-container-low rounded-xl p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
      </div>

      {/* Either participant may trigger the refund — the contract always pays
          out to the seller (whoever locked funds) regardless of who calls it. */}
      {canRefund ? (
        <button
          onClick={onRefund}
          disabled={refunding}
          className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {refunding ? (
            <>
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
              Procesando reembolso…
            </>
          ) : (
            <>
              <span className="material-symbols-outlined" style={{ fontVariationSettings: '"FILL" 1' }}>undo</span>
              Recuperar fondos
            </>
          )}
        </button>
      ) : (
        <Link
          to="/"
          className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
        >
          Volver al inicio
        </Link>
      )}
    </div>
  );
}

function RefundedView({ trade }: { trade: TradeDetailData }) {
  const refundTxHash = trade.release_tx_hash;

  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-purple-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-purple-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          undo
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">Fondos reembolsados</h2>
      <p className="text-on-surface-variant mb-6">
        Los fondos fueron devueltos exitosamente. El tiempo para completar la operación había expirado.
      </p>

      <div className="bg-surface-container-low rounded-xl p-4 w-full mb-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm text-on-surface-variant">Monto</span>
          <span className="font-bold text-on-surface">${trade.amount_mxn} MXN</span>
        </div>
        <div className="flex justify-between items-center">
          <span className="text-sm text-on-surface-variant">Comisión</span>
          <span className="text-sm text-on-surface">${trade.platform_fee_mxn} MXN</span>
        </div>
      </div>

      {refundTxHash && (
        <a
          href={buildTxUrl(refundTxHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary text-sm font-semibold hover:underline mb-6 flex items-center gap-1"
        >
          Ver transacción de reembolso en Stellar
          <span className="material-symbols-outlined text-sm">open_in_new</span>
        </a>
      )}

      <Link
        to="/"
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>
    </div>
  );
}

// ── Error views ─────────────────────────────────────────────────────────────

function NotFoundError() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          search_off
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.generic.fallback.title}</h2>
      <p className="text-on-surface-variant mb-2">La operación que buscas no existe o fue eliminada.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.generic.fallback.action}</p>

      <Link
        to="/"
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>

      <SupportLink />
    </div>
  );
}

function ForbiddenError() {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-red-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          lock_person
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.auth.unauthorized.title}</h2>
      <p className="text-on-surface-variant mb-2">No tienes permiso para ver esta operación. Solo los participantes pueden acceder.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.auth.unauthorized.action}</p>

      <Link
        to="/"
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity text-center"
      >
        Volver al inicio
      </Link>

      <SupportLink />
    </div>
  );
}

function NetworkError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="w-16 h-16 rounded-full bg-orange-100 flex items-center justify-center mb-6">
        <span className="material-symbols-outlined text-orange-600 text-3xl" style={{ fontVariationSettings: '"FILL" 1' }}>
          wifi_off
        </span>
      </div>
      <h2 className="text-2xl font-bold text-on-surface mb-2">{errorMessages.network.offline.title}</h2>
      <p className="text-on-surface-variant mb-2">No se pudo conectar al servidor. Verifica tu conexión e intenta de nuevo.</p>
      <p className="text-sm text-on-surface-variant mb-6">{errorMessages.network.offline.action}</p>

      <button
        onClick={onRetry}
        className="w-full py-3 rounded-xl bg-primary text-white font-semibold hover:opacity-90 transition-opacity mb-4"
      >
        Reintentar
      </button>

      <SupportLink />
    </div>
  );
}

// ── Refund confirmation dialog ─────────────────────────────────────────────

function RefundConfirmDialog({
  open,
  amount,
  fee,
  onClose,
  onConfirm,
  submitting,
  error,
}: {
  open: boolean;
  amount: number;
  fee: number;
  onClose: () => void;
  onConfirm: () => void;
  submitting: boolean;
  error: string | null;
}) {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-end sm:items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="refund-title"
    >
      <div className="w-full max-w-md rounded-2xl bg-surface p-6 shadow-xl border border-outline-variant/20">
        <h2 id="refund-title" className="font-headline text-lg font-bold text-on-surface">
          Recuperar fondos
        </h2>
        <p className="mt-3 text-sm text-on-surface-variant leading-relaxed">
          El intercambio expiró. Al recuperar los fondos se ejecutará el reembolso en la
          blockchain de Stellar. Esta operación tiene un costo de gas fee en XLM.
        </p>

        <div className="mt-4 bg-surface-container-low rounded-xl p-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-on-surface-variant">Monto a recuperar</span>
            <span className="font-bold text-on-surface">${amount} MXN</span>
          </div>
          <div className="flex justify-between items-center mb-2">
            <span className="text-sm text-on-surface-variant">Comisión de la operación</span>
            <span className="text-sm text-on-surface">${fee} MXN</span>
          </div>
          <div className="flex justify-between items-center pt-2 border-t border-outline-variant/20">
            <span className="text-sm font-semibold text-on-surface-variant">Total devuelto</span>
            <span className="font-bold text-primary">${amount} MXN</span>
          </div>
          <p className="mt-3 text-xs text-on-surface-variant">
            * Se aplicará un gas fee en XLM por la transacción en Stellar. Los fondos en MXN
            serán devueltos a tu cuenta.
          </p>
        </div>

        {error && (
          <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            <p>{error}</p>
            <p className="mt-2 text-xs">
              <a href="mailto:soporte@micopay.app" className="font-semibold underline">
                Contactar soporte
              </a>
            </p>
          </div>
        )}

        <div className="mt-6 flex gap-2 justify-end">
          <button
            type="button"
            className="rounded-lg px-4 py-2 text-sm font-semibold text-primary hover:bg-surface-container-low"
            onClick={onClose}
            disabled={submitting}
          >
            Cancelar
          </button>
          <button
            type="button"
            disabled={submitting}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            onClick={onConfirm}
          >
            {submitting ? 'Procesando…' : 'Sí, recuperar fondos'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────

function TradeDetailContent({ buyerToken, sellerToken, onBack }: TradeDetailProps) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [trade, setTrade] = useState<TradeDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<'not_found' | 'forbidden' | 'network' | null>(null);
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const [isRefunding, setIsRefunding] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [isBuyer, setIsBuyer] = useState(false);
  const [isSeller, setIsSeller] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const [lockError, setLockError] = useState<string | null>(null);

  useEffect(() => {
    if (trade?.buyer_id) {
      isCurrentUserBuyer(trade.buyer_id).then(setIsBuyer);
    }
    if (trade?.seller_id) {
      isCurrentUserSeller(trade.seller_id).then(setIsSeller);
    }
  }, [trade?.buyer_id, trade?.seller_id]);

  const fetchTrade = useCallback(async () => {
    if (!id) return;

    const effectiveToken = (buyerToken ?? sellerToken) ?? (await getStoredToken());
    if (!effectiveToken) {
      navigate('/');
      return;
    }

    try {
      const data = await fetchTradeDetail(id, effectiveToken);
      setTrade(data.trade as TradeDetailData);
      setError(null);
    } catch (e: any) {
      const status = e?.response?.status;
      if (status === 404) {
        setError('not_found');
      } else if (status === 403) {
        setError('forbidden');
      } else {
        setError('network');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate, buyerToken, sellerToken]);

  // Fetch on mount
  useEffect(() => {
    fetchTrade();
  }, [fetchTrade]);

  // Poll for active states
  useEffect(() => {
    if (!trade || !ACTIVE_STATES.includes(trade.status)) return;

    const interval = setInterval(fetchTrade, TRADE_POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [trade?.status, fetchTrade]);

  // Handle cancel
  const handleCancel = async () => {
    if (!trade) return;

    const effectiveToken = (buyerToken ?? sellerToken) ?? (await getStoredToken());
    if (!effectiveToken) return;

    try {
      await cancelTradeRequest(trade.id, effectiveToken);
      fetchTrade(); // Refresh trade state
    } catch (e) {
      console.error('Failed to cancel trade', e);
    }
  };

  // Handle complete (navigate to success)
  const handleComplete = () => {
    fetchTrade(); // Refresh to get completed state
  };

  // Handle lock (seller signs lock() with their own device key)
  const handleLock = async () => {
    if (!trade || isLocking) return;
    const effectiveToken = (buyerToken ?? sellerToken) ?? (await getStoredToken());
    if (!effectiveToken) return;

    setIsLocking(true);
    setLockError(null);
    try {
      // Lazily create the trustline for whatever asset this escrow deployment
      // settles in — a no-op if it already exists. Configurable because the
      // same contract code can be deployed with different token_ids (e.g.
      // MXNe on one environment, USDC on another); hardcoding the asset code
      // here would silently create the wrong trustline if pointed at a
      // differently-configured escrow.
      const escrowAssetCode = import.meta.env.VITE_ESCROW_ASSET_CODE || 'USDC';
      await ensureTrustline(escrowAssetCode);
      await lockTrade(trade.id, effectiveToken);
      fetchTrade(); // Refresh to get locked state
    } catch (e: any) {
      setLockError(e?.response?.data?.message || e?.message || 'No se pudo bloquear los fondos. Intenta de nuevo.');
    } finally {
      setIsLocking(false);
    }
  };

  // Handle refund
  const handleRefundConfirm = async () => {
    if (!trade) return;
    const token = buyerToken ?? sellerToken ?? await getStoredToken();
    if (!token) return;

    setIsRefunding(true);
    setRefundError(null);
    try {
      await refundTradeRequest(trade.id, token);
      setShowRefundConfirm(false);
      fetchTrade();
    } catch (e: any) {
      setRefundError(e.message || 'Error al procesar el reembolso. Intenta de nuevo.');
    } finally {
      setIsRefunding(false);
    }
  };

  const handleRefundClick = () => {
    setRefundError(null);
    setShowRefundConfirm(true);
  };

  const handleCloseRefundConfirm = () => {
    if (!isRefunding) {
      setShowRefundConfirm(false);
      setRefundError(null);
    }
  };

  // Loading state
  if (loading) {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center">
        <div className="text-center">
          <div className="w-10 h-10 border-4 border-surface-container-high border-t-primary rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-on-surface-variant text-sm">Cargando operación…</p>
        </div>
      </div>
    );
  }

  // Error states
  if (error === 'not_found') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <NotFoundError />
      </div>
    );
  }

  if (error === 'forbidden') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <ForbiddenError />
      </div>
    );
  }

  if (error === 'network') {
    return (
      <div className="min-h-screen bg-surface-container-lowest flex items-center justify-center px-6">
        <NetworkError onRetry={fetchTrade} />
      </div>
    );
  }

  if (!trade) {
    return null;
  }

  // Render state-specific view
  const renderStateView = () => {
    switch (trade.status) {
      case 'pending':
        return (
          <PendingView
            trade={trade}
            onCancel={handleCancel}
            isSeller={isSeller}
            onLock={handleLock}
            locking={isLocking}
            lockError={lockError}
          />
        );
      case 'locked':
        return <LockedView trade={trade} />;
      case 'revealing':
        return <RevealingView trade={trade} />;
      case 'revealed':
        return <RevealedView trade={trade} onComplete={handleComplete} token={buyerToken ?? sellerToken} />;
      case 'completed':
        return <CompletedView trade={trade} />;
      case 'cancelled':
        // A cancelled trade can still have real funds sitting in escrow —
        // cancelling only stops the app-level flow, it doesn't itself settle
        // on-chain (see docs/AUDIT_MOBILE_MAINNET.md finding B3). A backend
        // sweep auto-refunds these once the contract timeout passes, but we
        // also surface a manual "Recuperar fondos" retry here so the user
        // isn't just waiting on a background job with no visible feedback.
        if (trade.lock_tx_hash && !trade.release_tx_hash) {
          return (
            <ExpiredView
              canRefund={isBuyer || isSeller}
              onRefund={handleRefundClick}
              refunding={isRefunding}
              trade={trade}
              title="Reembolso pendiente"
              description="Esta operación fue cancelada. Tus fondos siguen en el contrato y se liberan automáticamente — también puedes recuperarlos ahora."
            />
          );
        }
        return <CancelledView />;
      case 'expired':
        return (
          <ExpiredView
            canRefund={isBuyer || isSeller}
            onRefund={handleRefundClick}
            refunding={isRefunding}
            trade={trade}
            title="Operación expirada"
            description="El tiempo para completar esta operación ha expirado."
          />
        );
      case 'refunded':
        return <RefundedView trade={trade} />;
      default:
        return (
          <PendingView
            trade={trade}
            onCancel={handleCancel}
            isSeller={isSeller}
            onLock={handleLock}
            locking={isLocking}
            lockError={lockError}
          />
        );
    }
  };

  return (
    <div className="min-h-screen bg-surface-container-lowest font-body text-on-surface">
      {/* TopAppBar */}
      <header className="sticky top-0 z-50 bg-surface-container-lowest/80 backdrop-blur-md border-b border-surface-container pt-[max(0px,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 hover:bg-surface-container-low rounded-full transition-colors text-primary"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div>
              <h1 className="font-headline font-bold text-lg text-on-surface">Detalle de operación</h1>
              <p className="text-xs text-on-surface-variant font-mono truncate max-w-[200px]">
                ID: {trade.id.substring(0, 12)}…
              </p>
            </div>
          </div>
          <TradeStateBadge status={trade.status} />
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-md mx-auto px-6 py-8">
        {renderStateView()}

        {/* Support link visible in all states */}
        {trade.status !== 'completed' && trade.status !== 'cancelled' && trade.status !== 'expired' && trade.status !== 'refunded' && (
          <SupportLink />
        )}
      </main>

      {/* Refund confirmation dialog — 'expired' is currently unreachable
          (the backend never persists that status), so this also covers a
          'cancelled' trade with funds still pending refund (see B3 above). */}
      {(trade.status === 'expired' || (trade.status === 'cancelled' && trade.lock_tx_hash && !trade.release_tx_hash)) && (
        <RefundConfirmDialog
          open={showRefundConfirm}
          amount={trade.amount_mxn}
          fee={trade.platform_fee_mxn ?? 0}
          onClose={handleCloseRefundConfirm}
          onConfirm={handleRefundConfirm}
          submitting={isRefunding}
          error={refundError}
        />
      )}
    </div>
  );
}

export default function TradeDetail(props: TradeDetailProps) {
  return <TradeDetailContent {...props} />;
}
