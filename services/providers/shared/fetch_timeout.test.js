import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FETCH_TIMEOUT_MS, withFetchTimeout } from './fetch_timeout.js';

describe('withFetchTimeout', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('aborts after the timeout when nothing settles', () => {
        vi.useFakeTimers();
        const { signal, dispose } = withFetchTimeout(null, 50);

        expect(signal.aborted).toBe(false);
        vi.advanceTimersByTime(50);

        expect(signal.aborted).toBe(true);
        expect(String(signal.reason)).toMatch(/timed out/);
        dispose();
    });

    it('follows an upstream abort immediately', () => {
        vi.useFakeTimers();
        const upstream = new AbortController();
        const { signal, dispose } = withFetchTimeout(upstream.signal, 60000);

        upstream.abort(new Error('user cancelled'));

        expect(signal.aborted).toBe(true);
        expect(signal.reason?.message).toBe('user cancelled');
        dispose();
    });

    it('adopts an already-aborted upstream signal', () => {
        const upstream = new AbortController();
        upstream.abort();

        const { signal, dispose } = withFetchTimeout(upstream.signal, 60000);

        expect(signal.aborted).toBe(true);
        dispose();
    });

    it('dispose cancels the timeout', () => {
        vi.useFakeTimers();
        const { signal, dispose } = withFetchTimeout(null, 50);

        dispose();
        vi.advanceTimersByTime(5000);

        expect(signal.aborted).toBe(false);
    });

    it('exposes a sane default timeout', () => {
        expect(DEFAULT_FETCH_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
    });
});
