-- SEC-02 (docs/security-reports/SEC-02-htlc-secret-en-qr.md, severidad Alta):
-- el QR dejaba viajar el preimage HTLC en la query string
-- (`micopay://release?trade_id=...&secret=...`), lo que permite liberar el
-- escrow directamente contra el contrato sin pasar por la app.
--
-- El QR ahora lleva un token opaco de un solo uso. Solo se guarda su sha256
-- (mismo principio que `trades.secret_hash`): el token en claro nunca se
-- persiste. `consumed_at` da el marcado atómico — el UPDATE de consumo filtra
-- por `consumed_at IS NULL`, así que dos escaneos concurrentes no pueden ganar
-- los dos.
CREATE TABLE IF NOT EXISTS trade_claim_tokens (
  token_hash   VARCHAR(64) PRIMARY KEY,
  trade_id     UUID NOT NULL REFERENCES trades(id),
  issued_to    UUID NOT NULL REFERENCES users(id),
  expires_at   TIMESTAMPTZ NOT NULL,
  consumed_at  TIMESTAMPTZ,
  consumed_by  UUID REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_claim_tokens_trade
  ON trade_claim_tokens (trade_id);
