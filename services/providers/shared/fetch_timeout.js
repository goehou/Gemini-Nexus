// Overall timeout for one-shot fetches (uploads, TTS, auth-style calls).
// Streaming requests use the idle timeout in sse.js instead: a long reasoning
// run is legitimate traffic, so only silence counts as a stall.
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;

/**
 * Combines an upstream abort signal with an overall timeout. The returned
 * signal aborts when either fires; call dispose() to clear the timer once
 * the request settles. Tolerates a missing upstream signal.
 *
 * @param {AbortSignal|null|undefined} inputSignal
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, dispose: () => void }}
 */
export function withFetchTimeout(inputSignal, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort(new DOMException(`Fetch timed out after ${timeoutMs}ms`, 'TimeoutError'));
    }, timeoutMs);

    const dispose = () => clearTimeout(timer);

    if (inputSignal) {
        if (inputSignal.aborted) {
            dispose();
            controller.abort(inputSignal.reason);
        } else {
            const onAbort = () => {
                dispose();
                controller.abort(inputSignal.reason);
            };
            inputSignal.addEventListener('abort', onAbort, { once: true });
        }
    }

    return { signal: controller.signal, dispose };
}
