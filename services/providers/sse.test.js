import { afterEach, describe, expect, it, vi } from 'vitest';
import { readSseJson } from './sse.js';

function createSseResponse(chunks) {
    const encoder = new TextEncoder();
    return {
        body: new ReadableStream({
            start(controller) {
                for (const chunk of chunks) {
                    controller.enqueue(encoder.encode(chunk));
                }
                controller.close();
            },
        }),
    };
}

describe('readSseJson', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('ignores malformed stream events while continuing to parse valid events', async () => {
        const events = [];
        const response = createSseResponse([
            'data: {"ok":true}\n',
            'data: {not-json}\n',
            'data: {"done":true}\n',
        ]);

        await readSseJson(response, (event) => {
            events.push(event);
        });

        expect(events).toEqual([{ ok: true }, { done: true }]);
    });

    it('propagates errors from the event callback', async () => {
        const response = createSseResponse(['data: {"ok":true}\n']);

        await expect(
            readSseJson(response, async () => {
                throw new Error('callback failed');
            })
        ).rejects.toThrow('callback failed');
    });

    it('keeps a multi-line event split across chunks as one event', async () => {
        // Regression: pendingData used to reset every chunk with a forced
        // dispatch, so the first fragment was JSON.parsed alone and dropped.
        const events = [];
        const response = createSseResponse(['data: {"a":\ndata: 1}', '\n\n']);

        await readSseJson(response, (event) => {
            events.push(event);
        });

        expect(events).toEqual([{ a: 1 }]);
    });

    it('dispatches single-line events without blank separators per line', async () => {
        const events = [];
        const response = createSseResponse(['data: {"a":1}\ndata: {"b":', '2}\n']);

        await readSseJson(response, (event) => {
            events.push(event);
        });

        expect(events).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('flushes a final event without trailing newline at stream end', async () => {
        const events = [];
        const response = createSseResponse(['data: {"a":1}']);

        await readSseJson(response, (event) => {
            events.push(event);
        });

        expect(events).toEqual([{ a: 1 }]);
    });

    it('throws a business error for an empty response body', async () => {
        await expect(readSseJson({ body: null }, () => {})).rejects.toThrow('Empty response body');
        await expect(readSseJson({}, () => {})).rejects.toThrow('Empty response body');
    });

    it('stops reading when the signal is already aborted', async () => {
        const events = [];
        const response = createSseResponse(['data: {"a":1}\n\n']);

        await readSseJson(
            response,
            (event) => {
                events.push(event);
            },
            AbortSignal.abort()
        );

        expect(events).toEqual([]);
    });

    it('aborts a stalled stream that sends nothing', async () => {
        vi.useFakeTimers();
        const response = {
            body: {
                // Minimal reader without cancel/releaseLock: the abort path
                // must tolerate exotic Response implementations.
                getReader: () => ({
                    read: () => new Promise(() => {}),
                }),
            },
        };

        const promise = readSseJson(response, () => {}, null, { idleTimeoutMs: 1000 });
        const assertion = expect(promise).rejects.toThrow(/stalled/);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('resets the idle clock on every received chunk', async () => {
        vi.useFakeTimers();
        const encoder = new TextEncoder();
        const events = [];
        const pendingReads = [];
        const response = {
            body: {
                getReader: () => ({
                    read: () => new Promise((resolve) => pendingReads.push(resolve)),
                }),
            },
        };

        const promise = readSseJson(
            response,
            (event) => {
                events.push(event);
            },
            null,
            { idleTimeoutMs: 1000 }
        );

        await vi.advanceTimersByTimeAsync(500);
        pendingReads[0]({ done: false, value: encoder.encode('data: {"a":1}\n\n') });
        // 1000ms total elapsed, but only 500ms since the last bytes arrived.
        await vi.advanceTimersByTimeAsync(500);
        pendingReads[1]({ done: true });
        await promise;

        expect(events).toEqual([{ a: 1 }]);
    });
});
