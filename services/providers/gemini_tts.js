import { generateUUID } from '../../shared/utils/index.js';
import { WEB_CLIENT_CAPABILITIES, assertAuthToken } from './shared/web_auth.js';
import { withFetchTimeout } from './shared/fetch_timeout.js';

const TTS_RPC_ID = 'XqA3Ic';
const TTS_AUDIO_FORMAT_OGG = 2;
const DEFAULT_TTS_LOCALE = 'en-US';

function normalizeText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildTtsHeader() {
    const header = [];
    header[0] = 1;
    header[8] = WEB_CLIENT_CAPABILITIES;
    header[14] = 1;
    header[15] = 1;
    header[16] = generateUUID();
    return JSON.stringify(header);
}

function buildEndpoint(context, sourcePath = '/app') {
    const accountPrefix =
        context.authUser && context.authUser !== '0' ? `/u/${context.authUser}` : '';
    const queryParams = new URLSearchParams({
        rpcids: TTS_RPC_ID,
        'source-path': sourcePath || '/app',
        bl: context.blValue,
        'f.sid': context.fSid,
        hl: context.locale || DEFAULT_TTS_LOCALE,
        _reqid: String(Math.floor(Math.random() * 9000000) + 100000),
        rt: 'c',
    });
    return `https://gemini.google.com${accountPrefix}/_/BardChatUi/data/batchexecute?${queryParams.toString()}`;
}

function buildRequestBody(text, locale, atValue, audioFormat = TTS_AUDIO_FORMAT_OGG) {
    const requestMessage = [null, text, locale, null, audioFormat];
    const rpcRequest = [[[TTS_RPC_ID, JSON.stringify(requestMessage), null, 'generic']]];
    return new URLSearchParams({
        'f.req': JSON.stringify(rpcRequest),
        at: atValue,
    });
}

function getBatchJsonLine(responseText) {
    const text = String(responseText || '');
    // batchexecute 标准前缀是 )]}'\n[[... 需兼容
    const cleaned = text.replace(/^\)\]\}'\n?/, '');
    return cleaned.split('\n').find((line) => line.trim().startsWith('[['));
}

function parseTtsBatchResponse(responseText) {
    if (String(responseText || '').includes('<!DOCTYPE html>')) {
        throw new Error('未登录 (Session expired)');
    }

    const jsonLine = getBatchJsonLine(responseText);
    if (!jsonLine) throw new Error('Gemini TTS response did not contain a batch payload.');

    let rows;
    try {
        rows = JSON.parse(jsonLine);
    } catch (parseError) {
        throw new Error('Gemini TTS batch payload is not valid JSON: ' + parseError.message);
    }

    if (!Array.isArray(rows)) {
        throw new Error('Gemini TTS batch payload is not an array.');
    }

    const ttsRow = rows.find((row) => row?.[0] === 'wrb.fr' && row?.[1] === TTS_RPC_ID);
    if (!ttsRow || typeof ttsRow[2] !== 'string') {
        throw new Error('Gemini TTS response did not contain audio data.');
    }

    let payload;
    try {
        payload = JSON.parse(ttsRow[2]);
    } catch (parseError) {
        throw new Error('Gemini TTS audio payload is not valid JSON: ' + parseError.message);
    }

    const audioBase64 = payload?.[0];
    if (!audioBase64) throw new Error('Gemini TTS returned empty audio data.');
    return audioBase64;
}

export async function fetchGeminiTtsAudio(text, context, options = {}) {
    const normalizedText = normalizeText(text);
    if (!normalizedText) throw new Error('No readable text found.');

    assertAuthToken(context, 'atValue');
    assertAuthToken(context, 'blValue');
    assertAuthToken(context, 'fSid');

    const locale = options.locale || context.locale || DEFAULT_TTS_LOCALE;
    const audioFormat = options.audioFormat || TTS_AUDIO_FORMAT_OGG;
    const endpoint = buildEndpoint({ ...context, locale }, options.sourcePath);
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Same-Domain': '1',
        'x-goog-ext-525001261-jspb': buildTtsHeader(),
        'x-goog-ext-73010989-jspb': '[0]',
        Origin: 'https://gemini.google.com',
        Referer: 'https://gemini.google.com/',
    };
    if (context.authUser && context.authUser !== '0') {
        headers['X-Goog-AuthUser'] = context.authUser;
    }

    const requestTimeout = withFetchTimeout(options.signal);
    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            credentials: 'include',
            headers,
            body: buildRequestBody(normalizedText, locale, context.atValue, audioFormat),
            signal: requestTimeout.signal,
        });

        if (!response.ok) {
            throw new Error(`Gemini TTS network error: ${response.status} ${response.statusText}`);
        }

        return {
            audioBase64: parseTtsBatchResponse(await response.text()),
            mimeType: audioFormat === TTS_AUDIO_FORMAT_OGG ? 'audio/ogg' : 'audio/mpeg',
            locale,
        };
    } finally {
        requestTimeout.dispose();
    }
}

export const GeminiTtsInternals = {
    buildEndpoint,
    buildRequestBody,
    parseTtsBatchResponse,
    TTS_RPC_ID,
    TTS_AUDIO_FORMAT_OGG,
};
