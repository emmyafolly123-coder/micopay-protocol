/**
 * QR payload parser for MicoPay protocol QR codes.
 *
 * Supported formats:
 *   - micopay://release?trade_id=<uuid>&claim_token=<hex64>
 *   - micopay://claim?request_id=<id>&amount_mxn=<number>&htlc=<hash>
 *   - MICOPAY:<type>:<value>  (legacy demo format — demo builds only)
 *
 * Returns a typed result or an error describing what went wrong.
 */

import { IS_DEMO_MODE } from './demoMode';
import { isHex64, isHtlcReference, isRequestId, isUuid } from './qrValidation';

export interface QRPayloadRelease {
  type: 'release';
  tradeId: string;
  /**
   * Token opaco de un solo uso. El preimage HTLC ya no viaja en el QR — ver
   * docs/security-reports/SEC-02-htlc-secret-en-qr.md.
   */
  claimToken: string;
}

export interface QRPayloadClaim {
  type: 'claim';
  requestId: string;
  amountMxn: number;
  htlc: string;
}

export interface QRPayloadDemo {
  type: 'demo';
  subtype: string;
  value: string;
}

export type ParsedQRPayload = QRPayloadRelease | QRPayloadClaim | QRPayloadDemo;

export interface QRParseSuccess {
  ok: true;
  payload: ParsedQRPayload;
}

export interface QRParseError {
  ok: false;
  error: string;
}

export type QRParseResult = QRParseSuccess | QRParseError;

function parseAmountMxn(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return 0;
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return amount;
}

/**
 * Parse a raw QR string into a typed payload object.
 */
export function parseQRPayload(raw: string | null | undefined): QRParseResult {
  if (!raw || raw.trim().length === 0) {
    return { ok: false, error: 'El código QR está vacío' };
  }

  const trimmed = raw.trim();

  // ── micopay:// deep-link format ──────────────────────────────────────────
  if (trimmed.startsWith('micopay://')) {
    try {
      // Replace micopay:// with https:// so URL constructor can parse it
      const url = new URL(trimmed.replace('micopay://', 'https://'));
      const action = url.hostname; // 'release' or 'claim'

      if (action === 'release') {
        const tradeId = url.searchParams.get('trade_id');
        const claimToken = url.searchParams.get('claim_token');

        if (!tradeId) {
          return { ok: false, error: 'El QR no contiene un ID de trade válido' };
        }
        if (!isUuid(tradeId)) {
          return { ok: false, error: 'El ID de trade no tiene un formato UUID válido' };
        }
        if (!claimToken) {
          return { ok: false, error: 'El QR no contiene el código de cobro' };
        }
        if (!isHex64(claimToken)) {
          return {
            ok: false,
            error: 'El código de cobro debe ser una cadena hexadecimal de 64 caracteres',
          };
        }

        return {
          ok: true,
          payload: { type: 'release', tradeId, claimToken: claimToken.toLowerCase() },
        };
      }

      if (action === 'claim') {
        const requestId = url.searchParams.get('request_id');
        const amountMxnStr = url.searchParams.get('amount_mxn');
        const htlc = url.searchParams.get('htlc');

        if (!requestId) {
          return { ok: false, error: 'El QR de claim no contiene un ID de solicitud' };
        }
        if (!isRequestId(requestId)) {
          return { ok: false, error: 'El ID de solicitud no tiene un formato válido' };
        }

        const amountMxn = parseAmountMxn(amountMxnStr);
        if (amountMxn === null) {
          return { ok: false, error: 'El monto MXN del QR no es válido' };
        }

        const htlcValue = htlc ?? '';
        if (htlcValue && !isHtlcReference(htlcValue, IS_DEMO_MODE)) {
          return {
            ok: false,
            error: 'La referencia HTLC debe ser un hash de 64 caracteres hexadecimales',
          };
        }

        return {
          ok: true,
          payload: {
            type: 'claim',
            requestId,
            amountMxn,
            htlc: htlcValue,
          },
        };
      }

      return { ok: false, error: `Acción QR no reconocida: "${action}"` };
    } catch {
      return { ok: false, error: 'No se pudo analizar el enlace del QR' };
    }
  }

  // ── MICOPAY:<subtype>:<value> legacy demo format (demo builds only) ───────
  if (trimmed.startsWith('MICOPAY:')) {
    if (!IS_DEMO_MODE) {
      return {
        ok: false,
        error: 'El formato legacy MICOPAY ya no es compatible. Usa un QR micopay:// válido.',
      };
    }

    const parts = trimmed.split(':');
    if (parts.length >= 3) {
      return {
        ok: true,
        payload: {
          type: 'demo',
          subtype: parts[1],
          value: parts.slice(2).join(':'),
        },
      };
    }
    return { ok: false, error: 'Formato MICOPAY incompleto' };
  }

  return { ok: false, error: 'Código QR no reconocido. Se espera un QR de MicoPay válido.' };
}
