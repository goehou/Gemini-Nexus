(function () {
    const MAX_UTTERANCE_LENGTH = 180;
    const PAGE_TEXT_LIMIT = 20000;
    const GEMINI_TTS_TEXT_LIMIT = 5000;

    function getStrings() {
        return window.GeminiToolbarStrings || {};
    }

    function normalizeText(text) {
        return String(text || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function splitText(text) {
        const normalized = normalizeText(text);
        if (!normalized) return [];

        const chunks = [];
        const sentences = normalized.match(/[^。！？.!?]+[。！？.!?]?/g) || [normalized];
        let current = '';

        for (const sentence of sentences) {
            const next = current ? `${current} ${sentence.trim()}` : sentence.trim();
            if (next.length <= MAX_UTTERANCE_LENGTH) {
                current = next;
                continue;
            }

            if (current) chunks.push(current);
            if (sentence.length <= MAX_UTTERANCE_LENGTH) {
                current = sentence.trim();
                continue;
            }

            for (let index = 0; index < sentence.length; index += MAX_UTTERANCE_LENGTH) {
                chunks.push(sentence.slice(index, index + MAX_UTTERANCE_LENGTH).trim());
            }
            current = '';
        }

        if (current) chunks.push(current);
        return chunks.filter(Boolean);
    }

    function getPageText() {
        const clone = document.body?.cloneNode(true);
        if (!clone) return '';

        clone
            .querySelectorAll('script, style, noscript, svg, canvas, iframe')
            .forEach((node) => node.remove());

        return normalizeText(clone.innerText || clone.textContent || '').slice(0, PAGE_TEXT_LIMIT);
    }

    function hasHan(text) {
        return /[\u4e00-\u9fff]/.test(String(text || ''));
    }

    function resolveTtsLocale(text) {
        const raw = String(navigator.language || 'zh-CN').toLowerCase();
        // 文本含中文一律用普通话 zh-CN，避免 zh-HK / yue 被误判为粤语
        if (hasHan(text)) return 'zh-CN';
        if (raw.startsWith('zh') || raw.startsWith('yue')) return 'zh-CN';
        // 非中文环境按浏览器语言透传，兜底 zh-CN
        return navigator.language || 'zh-CN';
    }

    function pickMandarinVoice(speechSynthesis, preferredLang) {
        try {
            const voices = speechSynthesis?.getVoices?.() || [];
            if (!voices.length) return null;
            const isCantoneseVoice = (v) =>
                /粤语|cantonese|yue|sin-ji|hong kong|hk|mo/i.test(`${v.name} ${v.lang}`);
            const isMandarinVoice = (v) =>
                /普通话|mandarin|cmn-hans|zh-cn|ting-ting|google.*普通话/i.test(
                    `${v.name} ${v.lang}`
                );
            // 1. 精确 zh-CN 且非粤语
            let voice = voices.find((v) => v.lang === 'zh-CN' && !isCantoneseVoice(v));
            if (voice) return voice;
            // 2. 任何普通话特征的 voice
            voice = voices.find((v) => isMandarinVoice(v) && !isCantoneseVoice(v));
            if (voice) return voice;
            // 3. 任意 zh 但排除粤语
            voice = voices.find(
                (v) =>
                    String(v.lang || '')
                        .toLowerCase()
                        .startsWith('zh') && !isCantoneseVoice(v)
            );
            if (voice) return voice;
            // 4. preferredLang 匹配
            if (preferredLang) {
                voice = voices.find((v) => v.lang === preferredLang);
                if (voice) return voice;
            }
            return null;
        } catch {
            return null;
        }
    }

    class SpeechReader {
        constructor({
            speechSynthesis = window.speechSynthesis,
            runtime = window.chrome?.runtime,
            AudioCtor = window.Audio,
        } = {}) {
            this.speechSynthesis = speechSynthesis;
            this.runtime = runtime;
            this.AudioCtor = AudioCtor;
            this.queue = [];
            this.isReading = false;
            this.audio = null;
            this.objectUrl = null;
            this.readToken = 0;
        }

        get supported() {
            const hasUtterance =
                typeof SpeechSynthesisUtterance === 'function' ||
                typeof window.SpeechSynthesisUtterance === 'function';
            return (
                Boolean(this.runtime?.sendMessage && this.AudioCtor) ||
                Boolean(this.speechSynthesis && hasUtterance)
            );
        }

        stop() {
            this.readToken += 1;
            this.queue = [];
            this.isReading = false;
            if (this.audio) {
                this.audio.pause();
                this.audio.removeAttribute?.('src');
                this.audio = null;
            }
            if (this.objectUrl) {
                URL.revokeObjectURL(this.objectUrl);
                this.objectUrl = null;
            }
            this.speechSynthesis?.cancel?.();
        }

        readSelection(text) {
            return this.readText(text, getStrings().readSelection || 'Read selection');
        }

        readPage() {
            return this.readText(getPageText(), getStrings().readPage || 'Read page');
        }

        async readText(text, title = '') {
            if (!this.supported) {
                throw new Error(
                    getStrings().speechUnsupported ||
                        'Text-to-speech is not supported in this browser.'
                );
            }

            const normalizedText = normalizeText(text).slice(0, GEMINI_TTS_TEXT_LIMIT);
            if (!normalizedText) {
                throw new Error(getStrings().speechNoText || 'No readable text found.');
            }

            if (this.isReading || this.speechSynthesis?.speaking) {
                this.stop();
                return { status: 'stopped', title };
            }

            if (this.runtime?.sendMessage && this.AudioCtor) {
                try {
                    return await this._readWithGeminiTts(normalizedText, title);
                } catch (error) {
                    // 关键修复：Gemini TTS 失败时自动回退到系统语音，而不是直接报错
                    // 常见失败：未登录 gemini.google.com / 第三方 Cookie 被拦 / 自动播放被拦 / 网络错误
                    console.warn(
                        '[GeminiSpeechReader] Gemini TTS failed, falling back to system TTS:',
                        error?.message || error
                    );
                    const hasUtterance =
                        typeof SpeechSynthesisUtterance === 'function' ||
                        typeof window.SpeechSynthesisUtterance === 'function';
                    if (!this.speechSynthesis || !hasUtterance) {
                        throw error;
                    }
                    // 避免对“无文本”等业务错误做无意义回退
                    const msg = String(error?.message || '');
                    if (msg.includes('No readable text')) throw error;
                    return this._readWithSystemTts(normalizedText, title);
                }
            }

            return this._readWithSystemTts(normalizedText, title);
        }

        _readWithSystemTts(normalizedText, title) {
            const chunks = splitText(normalizedText);
            this.queue = chunks;
            const chunkCount = chunks.length;
            this.isReading = true;
            try {
                this.speechSynthesis.cancel();
            } catch {}
            // Chrome 需等待 voices 就绪，否则 speak 静默失败
            const voices = this.speechSynthesis.getVoices?.() || [];
            if (!voices.length && typeof this.speechSynthesis.addEventListener === 'function') {
                // 触发一次 voices 加载，不阻塞当前朗读
                this.speechSynthesis.addEventListener('voiceschanged', () => {}, { once: true });
            }
            this._speakNext();
            return { status: 'started', title, chunks: chunkCount, provider: 'system' };
        }

        _speakNext() {
            const text = this.queue.shift();
            if (!text) {
                this.isReading = false;
                return;
            }

            const UtteranceCtor =
                window.SpeechSynthesisUtterance || globalThis.SpeechSynthesisUtterance;
            const utterance = new UtteranceCtor(text);
            const targetLang = resolveTtsLocale(text);
            utterance.lang = targetLang;
            utterance.rate = 1;
            const mandarinVoice = pickMandarinVoice(this.speechSynthesis, targetLang);
            if (mandarinVoice) utterance.voice = mandarinVoice;
            utterance.onend = () => this._speakNext();
            utterance.onerror = (event) => {
                console.warn('[GeminiSpeechReader] system TTS error:', event?.error || event);
                this.queue = [];
                this.isReading = false;
            };
            try {
                this.speechSynthesis.speak(utterance);
            } catch (error) {
                console.warn('[GeminiSpeechReader] speak() threw:', error);
                this.queue = [];
                this.isReading = false;
            }
        }

        async _readWithGeminiTts(text, title) {
            const token = (this.readToken += 1);
            this.isReading = true;
            // 预创建 Audio 元素以尽量保留用户手势（Chrome 自动播放策略：异步 fetch 后 play 会丢失手势）
            let precreatedAudio = null;
            try {
                precreatedAudio = new this.AudioCtor();
                precreatedAudio.preload = 'auto';
                // 静默解锁：部分浏览器需要先 resume
                precreatedAudio.muted = true;
                const p = precreatedAudio.play?.();
                if (p?.catch) p.catch(() => {});
                precreatedAudio.pause?.();
                precreatedAudio.muted = false;
            } catch {}
            let response;
            try {
                response = await this.runtime.sendMessage({
                    action: 'GEMINI_TTS',
                    text,
                    locale: resolveTtsLocale(text),
                    sourcePath: '/app',
                });
            } catch (error) {
                this.isReading = false;
                throw error;
            }

            if (token !== this.readToken) return { status: 'stopped', title };
            if (!response || response.status !== 'success' || !response.audioBase64) {
                this.isReading = false;
                const raw =
                    response?.error || getStrings().speechUnsupported || 'Gemini TTS failed.';
                // 给出可操作的中文提示
                const hint = this._humanizeTtsError(raw);
                throw new Error(hint);
            }

            const audioBytes = this._base64ToBytes(response.audioBase64);
            const blob = new Blob([audioBytes], {
                type: response.mimeType || 'audio/ogg',
            });
            this.objectUrl = URL.createObjectURL(blob);
            this.audio = precreatedAudio || new this.AudioCtor();
            // 兼容两种构造：new Audio(url) 与 new Audio() 后设 src
            try {
                if (this.audio.src !== undefined) this.audio.src = this.objectUrl;
                else {
                    // 回退：重建
                    this.audio = new this.AudioCtor(this.objectUrl);
                }
            } catch {
                this.audio = new this.AudioCtor(this.objectUrl);
            }
            this.audio.onended = () => this.stop();
            this.audio.onerror = () => {
                console.warn('[GeminiSpeechReader] audio element error');
                this.stop();
            };
            try {
                await this.audio.play();
            } catch (error) {
                const msg = String(error?.message || error);
                // 自动播放被拦是最高频的“总是错误”根因
                if (msg.includes('NotAllowedError') || error?.name === 'NotAllowedError') {
                    this.stop();
                    const e = new Error(
                        '浏览器拦截了自动播放，请再次点击朗读（已自动回退到系统语音可尝试）。'
                    );
                    e.cause = error;
                    throw e;
                }
                this.stop();
                throw error;
            }
            return { status: 'started', title, chunks: 1, provider: 'gemini' };
        }

        _humanizeTtsError(raw) {
            const s = String(raw || '');
            if (
                s.includes('未登录') ||
                s.includes('Session expired') ||
                s.includes('Missing Gemini Web auth token')
            ) {
                return 'Gemini TTS 需要先登录 https://gemini.google.com 并刷新页面（扩展依赖网页登录态）。已自动回退到系统语音。';
            }
            if (s.includes('429') || s.includes('RESOURCE_EXHAUSTED')) {
                return 'Gemini TTS 触发限流（429），已自动回退到系统语音，稍后重试。';
            }
            if (s.includes('400') || s.includes('401') || s.includes('403')) {
                return `Gemini TTS 鉴权失败（${s}），请到 gemini.google.com 重新登录后重试。已自动回退到系统语音。`;
            }
            return s;
        }

        _base64ToBytes(base64) {
            const binary = atob(base64);
            const bytes = new Uint8Array(binary.length);
            for (let index = 0; index < binary.length; index += 1) {
                bytes[index] = binary.charCodeAt(index);
            }
            return bytes;
        }
    }

    window.GeminiSpeechReader = SpeechReader;
    window.GeminiSpeechReaderUtils = {
        normalizeText,
        splitText,
        getPageText,
    };
})();
