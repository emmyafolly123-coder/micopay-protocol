import { useEffect, useState } from 'react';

export interface Countdown {
  /** Tiempo restante ya formateado: "1h 20m" o "4m 32s". Vacío si expiró. */
  label: string;
  expired: boolean;
}

/**
 * Cuenta regresiva hasta `expiresAt` (ISO). Tick de 1 s.
 *
 * UX_MANIFESTO exige que la expiración sea visible en las pantallas de dinero
 * ("make expiration visible" en QR/claim; "timeouts, delays, and refunds must
 * be visible"). El copy de cada estado lo pone la pantalla, no el hook.
 */
export function useCountdown(expiresAt: string | null): Countdown {
  const [state, setState] = useState<Countdown>({ label: '', expired: false });

  useEffect(() => {
    if (!expiresAt) {
      setState({ label: '', expired: false });
      return;
    }

    const tick = () => {
      const diff = new Date(expiresAt).getTime() - Date.now();
      if (diff <= 0) {
        setState({ label: '', expired: true });
        return;
      }
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      const s = Math.floor((diff % 60_000) / 1000);
      setState({ label: h > 0 ? `${h}h ${m}m` : `${m}m ${s}s`, expired: false });
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt]);

  return state;
}
