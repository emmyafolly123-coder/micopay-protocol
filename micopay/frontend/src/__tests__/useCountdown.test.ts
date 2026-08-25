import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCountdown } from '../hooks/useCountdown';

afterEach(() => {
  vi.useRealTimers();
});

describe('useCountdown', () => {
  it('counts down while there is time left', () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    const { result } = renderHook(() => useCountdown(expiresAt));

    expect(result.current.expired).toBe(false);
    expect(result.current.label).toBe('5m 0s');

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(result.current.label).toBe('4m 0s');
    expect(result.current.expired).toBe(false);
  });

  it('flips to expired when the deadline passes', () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 2_000).toISOString();

    const { result } = renderHook(() => useCountdown(expiresAt));
    expect(result.current.expired).toBe(false);

    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(result.current.expired).toBe(true);
    expect(result.current.label).toBe('');
  });

  it('reports hours for long windows', () => {
    vi.useFakeTimers();
    const expiresAt = new Date(Date.now() + 2 * 3_600_000).toISOString();

    const { result } = renderHook(() => useCountdown(expiresAt));

    expect(result.current.label).toBe('2h 0m');
  });

  it('stays idle without a deadline', () => {
    const { result } = renderHook(() => useCountdown(null));

    expect(result.current).toEqual({ label: '', expired: false });
  });
});
