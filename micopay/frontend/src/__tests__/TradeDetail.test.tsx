import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import TradeDetail from '../pages/TradeDetail';

const mockGetTrade = vi.fn();
const mockCompleteTrade = vi.fn();

// Mock the API module
vi.mock('../services/api', () => ({
  fetchTradeDetail: vi.fn(async (id, token) => {
    const trade = await mockGetTrade(id, token);
    return { trade, merchant_unavailable: false, seller_username: 'seller-username' };
  }),
  completeTrade: (...args: unknown[]) => mockCompleteTrade(...args),
  cancelTradeRequest: vi.fn(),
  refundTradeRequest: vi.fn(),
  lockTrade: vi.fn(),
}));

vi.mock('../services/payment', () => ({
  ensureTrustline: vi.fn(),
}));

// La sesión vive en secure storage (Keychain/Keystore en nativo) bajo la clave
// `micopay_user` con shape plano — no en `localStorage.micopay_users`, que era
// el artefacto de doble identidad del demo (SEC-22, SEC-26 y el fix del
// interceptor 401 en docs/AUDIT_MOBILE_MAINNET.md §2).
const mockReadJSON = vi.fn(async () => ({ id: 'buyer-1', token: 'mock-token' }));

vi.mock('../services/secureStorage', () => ({
  readJSON: (...args: unknown[]) => mockReadJSON(...(args as [])),
  writeJSON: vi.fn(),
  removeKey: vi.fn(),
}));

// Robust localStorage mock for tests
const store: Record<string, string> = {};
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store[key] || null),
  setItem: vi.fn((key: string, value: string) => { store[key] = value.toString(); }),
  removeItem: vi.fn((key: string) => { delete store[key]; }),
  clear: vi.fn(() => { for (const k in store) { delete store[k]; } }),
  key: vi.fn((index: number) => Object.keys(store)[index] || null),
  length: 0,
};
Object.defineProperty(mockLocalStorage, 'length', {
  get: () => Object.keys(store).length,
});
global.localStorage = mockLocalStorage as any;
if (global.window) {
  Object.defineProperty(global.window, 'localStorage', {
    value: mockLocalStorage,
    writable: true,
  });
}


const createMockTrade = (status: string) => ({
  id: 'trade-123',
  status,
  secret_hash: 'abc123',
  amount_mxn: 500,
  platform_fee_mxn: 4,
  lock_tx_hash: status !== 'pending' ? 'mock_lock_hash' : null,
  release_tx_hash: status === 'completed' ? 'mock_release_hash' : null,
  created_at: '2024-01-01T10:00:00Z',
  completed_at: status === 'completed' ? '2024-01-01T10:30:00Z' : null,
  expires_at: '2024-01-01T12:00:00Z',
  seller_id: 'seller-1',
  buyer_id: 'buyer-1',
});

const renderWithRouter = (route: string = '/trade/trade-123') => {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route path="/trade/:id" element={<TradeDetail />} />
        <Route path="/login" element={<div>Login Page</div>} />
        <Route path="/" element={<div>Home Page</div>} />
      </Routes>
    </MemoryRouter>
  );
};

describe('TradeDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('Route registration', () => {
    it('should render TradeDetail when navigating to /trade/:id', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/test-trade-id');

      await waitFor(() => {
        expect(screen.getByText(/cargando operación/i)).toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByText(/detalle de operación/i)).toBeInTheDocument();
      });
    });

    it('should correctly read trade ID from URL params', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/unique-trade-456');

      await waitFor(() => {
        expect(mockGetTrade).toHaveBeenCalledWith('unique-trade-456', 'mock-token');
      });
    });
  });

  describe('State rendering', () => {
    it('should render pending state with cancel button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Pendiente')).toBeInTheDocument();
        expect(screen.getByText(/esperando al vendedor/i)).toBeInTheDocument();
        expect(screen.getByText(/cancelar operación/i)).toBeInTheDocument();
      });
    });

    it('should render locked state with chat button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('locked'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Bloqueado')).toBeInTheDocument();
        expect(screen.getByText(/fondos bloqueados/i)).toBeInTheDocument();
        expect(screen.getByText(/abrir chat con el vendedor/i)).toBeInTheDocument();
      });
    });

    it('should render revealing state with QR button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('revealing'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Revelando')).toBeInTheDocument();
        expect(screen.getByText(/mostrar tu qr/i)).toBeInTheDocument();
        expect(screen.getByText(/ver mi qr de intercambio/i)).toBeInTheDocument();
      });
    });

    it('should render revealed state with confirm button', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('revealed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Revelado')).toBeInTheDocument();
        expect(screen.getByText(/confirmar recepción/i)).toBeInTheDocument();
        expect(screen.getByText(/ya recibí el efectivo/i)).toBeInTheDocument();
      });
    });

    it('should render completed state with summary', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('completed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Completado')).toBeInTheDocument();
        expect(screen.getByText(/operación completada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should render cancelled state when no funds were ever locked', async () => {
      mockGetTrade.mockResolvedValue({
        ...createMockTrade('cancelled'),
        lock_tx_hash: null,
      });

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Cancelado')).toBeInTheDocument();
        expect(screen.getByText(/operación cancelada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    // Finding B3 de docs/AUDIT_MOBILE_MAINNET.md: cancelar un trade ya
    // bloqueado dejaba los fondos atrapados sin ruta de recuperación. Ahora esa
    // combinación (lock sin release) ofrece el refund a cualquiera de los dos
    // participantes.
    it('should offer refund for a cancelled trade with funds still locked', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('cancelled'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/reembolso pendiente/i)).toBeInTheDocument();
        expect(screen.getByText(/recuperarlos ahora/i)).toBeInTheDocument();
        expect(screen.getByText(/recuperar fondos/i)).toBeInTheDocument();
      });
    });

    it('should render expired state', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('expired'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText('Expirado')).toBeInTheDocument();
        expect(screen.getByText(/expirada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });
  });

  // docs/AUDIT_MOBILE_MAINNET.md §4: "RevealedView muestra éxito aunque
  // completeTrade falle". La pantalla no debe declarar liberados unos fondos
  // que siguen en el contrato.
  describe('Confirmación de recepción', () => {
    it('does not report success when the release fails', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('revealed'));
      mockCompleteTrade.mockRejectedValue(new Error('on-chain release failed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/ya recibí el efectivo/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/ya recibí el efectivo/i));

      await waitFor(() => {
        expect(screen.getByText(/no se pudo confirmar/i)).toBeInTheDocument();
      });

      // Sigue diciendo dónde está el dinero y deja reintentar.
      expect(screen.getByText(/sigue retenido en la garantía/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /reintentar/i })).toBeInTheDocument();
      expect(screen.queryByText(/operación completada/i)).not.toBeInTheDocument();
    });

    it('confirms when the release succeeds', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('revealed'));
      mockCompleteTrade.mockResolvedValue({ status: 'completed', release_tx_hash: 'hash' });

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/ya recibí el efectivo/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText(/ya recibí el efectivo/i));

      await waitFor(() => {
        expect(mockCompleteTrade).toHaveBeenCalledWith('trade-123', 'mock-token');
      });
      expect(screen.queryByText(/no se pudo confirmar/i)).not.toBeInTheDocument();
    });
  });

  describe('Error handling', () => {
    it('should show 404 screen when trade is not found', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/Algo salió mal/i)).toBeInTheDocument();
        expect(screen.getByText(/La operación que buscas no existe o fue eliminada/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should show 403 screen when user is not a participant', async () => {
      const error = new Error('Forbidden');
      (error as any).response = { status: 403 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/no tienes acceso/i)).toBeInTheDocument();
        expect(screen.getByText(/no tienes permiso para ver esta operación/i)).toBeInTheDocument();
        expect(screen.getByText(/volver al inicio/i)).toBeInTheDocument();
      });
    });

    it('should show network error with retry button on connection failure', async () => {
      const error = new Error('Network error');
      (error as any).response = { status: 500 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/sin conexión/i)).toBeInTheDocument();
        expect(screen.getByText(/reintentar/i)).toBeInTheDocument();
      });
    });
  });

  describe('Auth recovery', () => {
    it('should redirect to home when not authenticated', async () => {
      mockReadJSON.mockResolvedValueOnce(null as never);

      renderWithRouter('/trade/trade-123');

      await waitFor(() => {
        expect(screen.getByText('Home Page')).toBeInTheDocument();
      });
    });

    it('should not redirect when user is authenticated', async () => {
        mockGetTrade.mockResolvedValue(createMockTrade('pending'));

      renderWithRouter('/trade/trade-123');

      await waitFor(() => {
        expect(screen.getByText(/detalle de operación/i)).toBeInTheDocument();
        expect(screen.queryByText('Home Page')).not.toBeInTheDocument();
      });
    });
  });

  describe('Support link visibility', () => {
    const states = ['pending', 'locked', 'revealing', 'revealed'];

    states.forEach((state) => {
      it(`should show support link in ${state} state`, async () => {
        mockGetTrade.mockResolvedValue(createMockTrade(state));

        renderWithRouter();

        await waitFor(() => {
          expect(screen.getByText(/¿necesitas ayuda\?/i)).toBeInTheDocument();
          expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
        });
      });
    });

    it('should not show support link in completed state', async () => {
      mockGetTrade.mockResolvedValue(createMockTrade('completed'));

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/operación completada/i)).toBeInTheDocument();
        expect(screen.queryByText(/¿necesitas ayuda\?/i)).not.toBeInTheDocument();
      });
    });

    it('should show support link in 404 error state', async () => {
      const error = new Error('Not found');
      (error as any).response = { status: 404 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
      });
    });

    it('should show support link in 403 error state', async () => {
      const error = new Error('Forbidden');
      (error as any).response = { status: 403 };
      mockGetTrade.mockRejectedValue(error);

      renderWithRouter();

      await waitFor(() => {
        expect(screen.getByText(/contactar soporte/i)).toBeInTheDocument();
      });
    });
  });
});
