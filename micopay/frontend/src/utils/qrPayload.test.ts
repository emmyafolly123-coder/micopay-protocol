import { describe, it, expect, vi } from 'vitest';
import { parseQRPayload } from './qrPayload';

const TRADE_ID = '550e8400-e29b-41d4-a716-446655440000';
const CLAIM_TOKEN_64 = 'deadbeef'.repeat(8);
const HTLC_TX_HASH = 'a'.repeat(64);

describe('parseQRPayload', () => {
  // ── Release format ─────────────────────────────────────────────────────
  describe('micopay://release', () => {
    it('parses a valid release QR', () => {
      const raw = `micopay://release?trade_id=${TRADE_ID}&claim_token=${CLAIM_TOKEN_64}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.type).toBe('release');
        if (result.payload.type === 'release') {
          expect(result.payload.tradeId).toBe(TRADE_ID);
          expect(result.payload.claimToken).toBe(CLAIM_TOKEN_64);
        }
      }
    });

    it('normalizes claim token hex to lowercase', () => {
      const upperToken = 'DEADBEEF'.repeat(8);
      const raw = `micopay://release?trade_id=${TRADE_ID}&claim_token=${upperToken}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(true);
      if (result.ok && result.payload.type === 'release') {
        expect(result.payload.claimToken).toBe(CLAIM_TOKEN_64);
      }
    });

    it('returns error when trade_id is missing', () => {
      const raw = `micopay://release?claim_token=${CLAIM_TOKEN_64}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('ID de trade');
      }
    });

    it('returns error when trade_id is not a UUID', () => {
      const raw = `micopay://release?trade_id=abc-123&claim_token=${CLAIM_TOKEN_64}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('UUID');
      }
    });

    it('returns error when claim token is missing', () => {
      const raw = `micopay://release?trade_id=${TRADE_ID}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('código de cobro');
      }
    });

    it('rejects malformed claim token (non-hex or wrong length)', () => {
      const raw = `micopay://release?trade_id=${TRADE_ID}&claim_token=ZZZ`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('64 caracteres');
      }
    });

    // SEC-02: el formato viejo llevaba el preimage HTLC en la URL. Un QR así ya
    // no debe abrir nada, aunque el hex sea válido.
    it('rejects the legacy secret= payload', () => {
      const raw = `micopay://release?trade_id=${TRADE_ID}&secret=${CLAIM_TOKEN_64}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('código de cobro');
      }
    });
  });

  // ── Claim format ───────────────────────────────────────────────────────
  describe('micopay://claim', () => {
    it('parses a valid claim QR', () => {
      const raw = `micopay://claim?request_id=mcr-req456&amount_mxn=500&htlc=${HTLC_TX_HASH}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.type).toBe('claim');
        if (result.payload.type === 'claim') {
          expect(result.payload.requestId).toBe('mcr-req456');
          expect(result.payload.amountMxn).toBe(500);
          expect(result.payload.htlc).toBe(HTLC_TX_HASH);
        }
      }
    });

    it('returns error when request_id is missing', () => {
      const raw = 'micopay://claim?amount_mxn=500';
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('ID de solicitud');
      }
    });

    it('rejects malformed htlc reference', () => {
      const raw = 'micopay://claim?request_id=mcr-req456&amount_mxn=500&htlc=0xhash';
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('HTLC');
      }
    });

    it('rejects invalid amount_mxn', () => {
      const raw = `micopay://claim?request_id=mcr-req456&amount_mxn=not-a-number&htlc=${HTLC_TX_HASH}`;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('monto MXN');
      }
    });
  });

  // ── MICOPAY: legacy format ─────────────────────────────────────────────
  describe('MICOPAY: legacy format', () => {
    it('rejects legacy format outside demo mode', () => {
      const raw = 'MICOPAY:DEMO:mock_secret_for_ui_preview';
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('legacy MICOPAY');
      }
    });

    it('parses MICOPAY:DEMO:value in demo mode', async () => {
      vi.stubEnv('VITE_DEMO_MODE', 'true');
      vi.resetModules();
      const { parseQRPayload: parseDemo } = await import('./qrPayload');
      const raw = 'MICOPAY:DEMO:mock_secret_for_ui_preview';
      const result = parseDemo(raw);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.type).toBe('demo');
        if (result.payload.type === 'demo') {
          expect(result.payload.subtype).toBe('DEMO');
          expect(result.payload.value).toBe('mock_secret_for_ui_preview');
        }
      }
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('returns error for incomplete MICOPAY format in demo mode', async () => {
      vi.stubEnv('VITE_DEMO_MODE', 'true');
      vi.resetModules();
      const { parseQRPayload: parseDemo } = await import('./qrPayload');
      const raw = 'MICOPAY:DEMO';
      const result = parseDemo(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('incompleto');
      }
      vi.unstubAllEnvs();
      vi.resetModules();
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────
  describe('edge cases', () => {
    it('returns error for null input', () => {
      const result = parseQRPayload(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('vacío');
      }
    });

    it('returns error for empty string', () => {
      const result = parseQRPayload('');
      expect(result.ok).toBe(false);
    });

    it('returns error for whitespace-only string', () => {
      const result = parseQRPayload('   ');
      expect(result.ok).toBe(false);
    });

    it('returns error for unknown format', () => {
      const result = parseQRPayload('https://example.com/whatever');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('no reconocido');
      }
    });

    it('returns error for unrecognized micopay action', () => {
      const raw = 'micopay://unknown?foo=bar';
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('no reconocida');
      }
    });

    it('trims whitespace before parsing', () => {
      const raw = `  micopay://release?trade_id=${TRADE_ID}&claim_token=${CLAIM_TOKEN_64}  `;
      const result = parseQRPayload(raw);
      expect(result.ok).toBe(true);
    });
  });
});
