export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120000;

async function readWithIdleTimeout(reader, idleTimeoutMs, onIdleTimeout) {
    const readPromise = reader.read();
    if (!(idleTimeoutMs > 0)) return readPromise;
    let idleTimer = null;
    try {
        await Promise.race([
            readPromise.then(
                () => 'settled',
                () => 'settled'
            ),
            new Promise((_, reject) => {
                idleTimer = setTimeout(() => {
                    onIdleTimeout();
                    reject(new Error(`SSE stream stalled: no data for ${idleTimeoutMs}ms`));
                }, idleTimeoutMs);
            }),
        ]);
        return await readPromise;
    } finally {
        if (idleTimer) clearTimeout(idleTimer);
    }
}

export async function readSseJson(response, onEvent, signal, options = {}) {
    if (!response?.body) {
        throw new Error('Empty response body: cannot read SSE stream');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    const MAX_BUFFER = 5 * 1024 * 1024;
    // Streams may legitimately run for minutes (long reasoning), so only
    // silence counts as a stall. Any received bytes reset the idle clock,
    // including keep-alive comments and incomplete lines.
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SSE_IDLE_TIMEOUT_MS;
    let cancelled = false;
    const onAbort = () => {
        cancelled = true;
        try {
            reader.cancel?.()?.catch?.(() => {});
        } catch {}
    };
    if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
    }
    // Accumulates multi-data lines per event (SSE spec). Hoisted out of the
    // read loop so an event split across TCP chunks is not lost: only a blank
    // line (the SSE event boundary) or end-of-stream force a dispatch.
    let pendingData = [];
    const emitJsonLine = async (text) => {
        if (!text || text === '[DONE]') return false;
        let eventPayload;
        try {
            eventPayload = JSON.parse(text);
        } catch {
            return false;
        }
        await onEvent(eventPayload);
        return true;
    };
    const dispatch = async () => {
        if (pendingData.length === 0) return;
        const dataStr = pendingData.join('\n');
        pendingData = [];
        if (await emitJsonLine(dataStr)) return;
        // Best effort: one malformed line must not poison a valid event
        // buffered after it without a blank separator — retry line by line.
        if (dataStr.includes('\n')) {
            for (const line of dataStr.split('\n')) {
                await emitJsonLine(line);
            }
        }
    };
    const isCompleteJson = (text) => {
        try {
            JSON.parse(text);
            return true;
        } catch {
            return false;
        }
    };
    try {
        while (true) {
            if (cancelled) break;
            const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs, onAbort);
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            if (buffer.length > MAX_BUFFER) {
                throw new Error('SSE buffer overflow');
            }

            const lines = buffer.split(/\r\n|\n|\r/);
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed === '') {
                    await dispatch();
                    continue;
                }
                if (trimmed.startsWith(':')) continue; // comment / keep-alive
                if (trimmed.startsWith('data:')) {
                    const dataStr = trimmed.replace(/^data:\s?/, '');
                    // Senders that omit blank-line separators stream one JSON
                    // event per data line. A new data line therefore closes the
                    // previous event — but only when it already parses as whole
                    // JSON, so multi-line events split across chunks keep
                    // accumulating instead of being dropped as fragments.
                    if (pendingData.length > 0 && isCompleteJson(pendingData.join('\n'))) {
                        await dispatch();
                    }
                    pendingData.push(dataStr);
                    continue;
                }
                // ignore event/id/retry for generic JSON streaming
                if (
                    trimmed.startsWith('event:') ||
                    trimmed.startsWith('id:') ||
                    trimmed.startsWith('retry:')
                ) {
                    continue;
                }
            }
        }
        // A final event without a trailing blank line awaits dispatch.
        await dispatch();
        // Flush remaining buffer if it contains a final data: without trailing newline
        const tail = buffer.trim();
        if (tail.startsWith('data:')) {
            const dataStr = tail.replace(/^data:\s?/, '');
            if (dataStr && dataStr !== '[DONE]') {
                try {
                    const eventPayload = JSON.parse(dataStr);
                    await onEvent(eventPayload);
                } catch {}
            }
        } else if (tail) {
            try {
                const eventPayload = JSON.parse(tail);
                await onEvent(eventPayload);
            } catch {}
        }
    } finally {
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
            reader.releaseLock();
        } catch {}
    }
}
