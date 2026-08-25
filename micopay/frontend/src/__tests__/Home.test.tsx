import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import Home from '../pages/Home';
import * as api from '../services/api';
import { useWalletBalance } from '../hooks/useWalletBalance';

vi.mock('../services/api', () => ({
  getTradeHistory: vi.fn(),
  getCurrentUser: vi.fn(),
  getMerchantTrades: vi.fn(),
  getXlmMxnRate: vi.fn(),
}));

vi.mock('../hooks/useWalletBalance', () => ({
  useWalletBalance: vi.fn(),
}));

const mockGetTradeHistory = vi.mocked(api.getTradeHistory);
const mockGetCurrentUser = vi.mocked(api.getCurrentUser);
const mockGetMerchantTrades = vi.mocked(api.getMerchantTrades);
const mockGetXlmMxnRate = vi.mocked(api.getXlmMxnRate);
const mockUseWalletBalance = vi.mocked(useWalletBalance);

function createProps(overrides = {}) {
  return {
    onNavigateCashout: vi.fn(),
    onNavigateDeposit: vi.fn(),
    onNavigateHistory: vi.fn(),
    token: 'buyer-token',
    merchantToken: 'merchant-token',
    onNavigateInbox: vi.fn(),
    // El saludo sale de esta prop; sin ella Home muestra "Hola, ..." y el
    // assert de render no encuentra el nombre.
    username: 'juan',
    ...overrides,
  };
}

describe('Home — pending-trades badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletBalance.mockReturnValue({
      balance: '250.00 MXNe',
      xlmBalance: '250.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: 18.5,
    });
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });
  });

  it('calls getMerchantTrades with merchantToken and "pending"', async () => {
    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalledWith('merchant-token', 'pending');
    });
  });

  it('does NOT call getMerchantTrades when merchantToken is null', async () => {
    render(<Home {...createProps({ merchantToken: null })} />);

    await waitFor(() => {
      expect(mockUseWalletBalance).toHaveBeenCalled();
    });

    expect(mockGetMerchantTrades).not.toHaveBeenCalled();
  });

  it('shows the badge with the correct count when there are pending trades', async () => {
    mockGetMerchantTrades.mockResolvedValue([
      { id: 't1', buyer_handle: 'alice', amount_mxn: 100, status: 'pending', created_at: '2024-06-01T10:00:00Z' },
      { id: 't2', buyer_handle: 'bob', amount_mxn: 200, status: 'pending', created_at: '2024-06-01T11:00:00Z' },
    ]);

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('does NOT show the badge when there are zero pending trades', async () => {
    mockGetMerchantTrades.mockResolvedValue([]);

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalled();
    });

    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('handles API error gracefully — no badge, no crash', async () => {
    mockGetMerchantTrades.mockRejectedValue(new Error('Network error'));

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(mockGetMerchantTrades).toHaveBeenCalled();
    });

    expect(screen.getByText(/hola, juan/i)).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

describe('Home — XLM→MXN rate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseWalletBalance.mockReturnValue({
      balance: '250.00 MXNe',
      xlmBalance: '250.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      tokens: [{ code: 'XLM', balance: 250 }],
      usdMxnRate: 18.5,
    });
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
  });

  it('displays MXN value computed with the fetched rate', async () => {
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText(/4,605/).length).toBeGreaterThanOrEqual(1);
    });
  });

  // Antes se mostraba un estimado con tilde (~ balance × 20). docs/AUDIT_MOBILE_MAINNET.md
  // §3 lo prohíbe: sin cotización se muestra "—", nunca un FX inventado.
  it('shows an em dash instead of an invented rate when the fetch fails', async () => {
    mockGetXlmMxnRate.mockRejectedValue(new Error('Network error'));

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/~5,000/)).not.toBeInTheDocument();
  });
});

describe('Home — non-custodial wallet balance states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetTradeHistory.mockResolvedValue([]);
    mockGetCurrentUser.mockResolvedValue({ verification_status: 'verified' } as any);
    mockGetMerchantTrades.mockResolvedValue([]);
    mockGetXlmMxnRate.mockResolvedValue({ rate: 18.42, source: 'coingecko', fetchedAt: '2026-06-25T12:00:00Z' });
  });

  it('shows 0.00 MXNe when the account is not funded (Horizon 404)', async () => {
    mockUseWalletBalance.mockReturnValue({
      balance: '0.00 MXNe',
      xlmBalance: '0.00',
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: null,
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: 18.5,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('0.00 MXNe').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows loading state when Horizon is loading', async () => {
    mockUseWalletBalance.mockReturnValue({
      balance: null,
      xlmBalance: null,
      stellarAddress: null,
      loading: true,
      error: null,
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: 18.5,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('Cargando balance…').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows fallback "--" when Horizon returns error', async () => {
    mockUseWalletBalance.mockReturnValue({
      balance: null,
      xlmBalance: null,
      stellarAddress: 'GA7ABCDEF12345',
      loading: false,
      error: new Error('Horizon connection failed'),
      refresh: vi.fn(),
      tokens: [],
      usdMxnRate: 18.5,
    });

    render(<Home {...createProps()} />);

    await waitFor(() => {
      expect(screen.getAllByText('--').length).toBeGreaterThanOrEqual(1);
    });
  });
});
