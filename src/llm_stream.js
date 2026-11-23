'use strict';

// Streaming chat-completions client shared by the Node tree agent.
// Kept in sync with the copy in extension/st-tree-lore/browser_engine.js (browser builds cannot require()).

/**
 * POST an OpenAI-compatible /chat/completions request and always return the
 * non-stream response shape `{ choices: [{ message, finish_reason }], usage }`.
 *
 * stream=true (default): sends `stream: true` and assembles SSE deltas (content,
 * reasoning_content, tool_calls whose arguments arrive in fragments) back into one
 * message, so callers never see the difference. The timeout is an idle timeout
 * (no bytes for idleMs), so long reasoning is never cut off mid-thought.
 * If the endpoint ignores `stream` and answers with plain JSON, that is accepted.
 * If it rejects streaming (HTTP 400/404/415/422), the call is retried once without it.
 *
 * Errors carry `.status` (HTTP code) and `.retryAfterMs` when the server sent Retry-After.
 */
async function postChatCompletion({ url, key, body, stream = true, idleMs = 90000, totalMs = 0, signal = null, onDelta = null }) {
    const attemptOnce = async (useStream) => {
        const ctrl = new AbortController();
        let timedOut = '';
        let timer = null;
        const arm = (ms, why) => {
            if (timer) clearTimeout(timer);
            if (ms > 0) {
                timer = setTimeout(() => {
                    timedOut = why;
                    ctrl.abort();
                }, ms);
            }
        };
        const onOuterAbort = () => ctrl.abort();
        if (signal) {
            if (signal.aborted) ctrl.abort();
            else signal.addEventListener('abort', onOuterAbort, { once: true });
        }
        const reqBody = { ...body };
        if (useStream) {
            reqBody.stream = true;
            reqBody.stream_options = { include_usage: true };
        }
        const idleWhy = `流式响应超过 ${Math.round(idleMs / 1000)} 秒没有收到数据`;
        if (useStream) arm(idleMs, idleWhy);
        else arm(totalMs, `请求超过 ${Math.round(totalMs / 1000)} 秒未完成`);
        try {
            const resp = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: useStream ? 'text/event-stream, application/json' : 'application/json',
                    Authorization: `Bearer ${key}`,
                },
                body: JSON.stringify(reqBody),
                signal: ctrl.signal,
            });
            if (!resp.ok) {
                const errTxt = await resp.text().catch(() => '');
                const err = new Error(`HTTP ${resp.status}: ${errTxt.slice(0, 200)}`);
                err.status = resp.status;
                const ra = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null;
                if (ra) {
                    const sec = Number(ra);
                    const ts = Date.parse(ra);
                    if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = Math.round(sec * 1000);
                    else if (Number.isFinite(ts)) err.retryAfterMs = Math.max(0, ts - Date.now());
                }
                throw err;
            }
            const ct = String((resp.headers && resp.headers.get && resp.headers.get('content-type')) || '');
            const plainJson = /json/i.test(ct) && !/event-stream/i.test(ct);
            if (!useStream || plainJson || !resp.body || typeof resp.body.getReader !== 'function') {
                // Endpoint ignored `stream` and answered with a normal JSON body: accept it as-is.
                return parseChatPayloadText(await resp.text());
            }
            const acc = createChatStreamAccumulator(onDelta);
            const reader = resp.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                arm(idleMs, idleWhy);
                buf += decoder.decode(value, { stream: true });
                let nl;
                while ((nl = buf.indexOf('\n')) >= 0) {
                    acc.feedLine(buf.slice(0, nl));
                    buf = buf.slice(nl + 1);
                }
            }
            buf += decoder.decode();
            if (buf) buf.split(/\r?\n/).forEach((l) => acc.feedLine(l));
            return acc.finish();
        } catch (err) {
            if (timedOut && !(signal && signal.aborted)) {
                const e = new Error(`LLM ${timedOut}`);
                e.name = 'TimeoutError';
                throw e;
            }
            throw err;
        } finally {
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onOuterAbort);
        }
    };
    if (!stream) return attemptOnce(false);
    try {
        return await attemptOnce(true);
    } catch (err) {
        if (err && [400, 404, 415, 422].includes(err.status)) {
            // Some relays reject `stream` / `stream_options`; fall back to a plain request once.
            return attemptOnce(false);
        }
        throw err;
    }
}

/** Parse a response body that should be JSON, tolerating an SSE body sent without the SSE content-type. */
function parseChatPayloadText(txt) {
    const s = String(txt || '');
    try {
        return JSON.parse(s);
    } catch (_) {
        if (/^\s*data:/m.test(s)) {
            const acc = createChatStreamAccumulator(null);
            s.split(/\r?\n/).forEach((l) => acc.feedLine(l));
            return acc.finish();
        }
        throw new Error(`LLM 返回无法解析：${s.slice(0, 160)}`);
    }
}

/** Accumulate OpenAI-style SSE chunks into a single non-stream chat completion. */
function createChatStreamAccumulator(onDelta) {
    let content = '';
    let reasoning = '';
    let finishReason = null;
    let usage = null;
    let role = 'assistant';
    let sawChoice = false;
    let plain = '';
    const tools = [];
    const emit = (kind, text) => {
        if (typeof onDelta !== 'function') return;
        try {
            onDelta({
                kind,
                text,
                contentChars: content.length,
                reasoningChars: reasoning.length,
                toolNames: tools.filter(Boolean).map((t) => t.function.name),
            });
        } catch (_) {}
    };
    return {
        feedLine(rawLine) {
            const line = String(rawLine || '').replace(/\r$/, '');
            if (!line.startsWith('data:')) {
                // Not SSE: keep it, in case the whole body is a plain JSON object.
                if (line.trim() && !line.startsWith(':') && !/^(event|id|retry):/.test(line)) plain += line + '\n';
                return;
            }
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') return;
            let j;
            try {
                j = JSON.parse(data);
            } catch (_) {
                return;
            }
            if (j && j.error) {
                const m = typeof j.error === 'string' ? j.error : j.error.message || JSON.stringify(j.error);
                throw new Error(`LLM 流式错误：${String(m).slice(0, 200)}`);
            }
            if (j && j.usage) usage = j.usage;
            const ch = j && Array.isArray(j.choices) ? j.choices[0] : null;
            if (!ch) return;
            sawChoice = true;
            if (ch.finish_reason) finishReason = ch.finish_reason;
            const d = ch.delta || ch.message || {};
            if (d.role) role = d.role;
            if (typeof d.content === 'string' && d.content) {
                content += d.content;
                emit('content', d.content);
            }
            const r =
                typeof d.reasoning_content === 'string' ? d.reasoning_content : typeof d.reasoning === 'string' ? d.reasoning : '';
            if (r) {
                reasoning += r;
                emit('reasoning', r);
            }
            if (Array.isArray(d.tool_calls)) {
                for (const tc of d.tool_calls) {
                    if (!tc) continue;
                    let idx = Number.isInteger(tc.index) ? tc.index : -1;
                    if (idx < 0) {
                        // Some relays omit `index`: a new id starts a new call, otherwise append to the last one.
                        const last = tools.length - 1;
                        idx = last < 0 || (tc.id && tools[last].id && tools[last].id !== tc.id) ? tools.length : last;
                    }
                    const slot = tools[idx] || (tools[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } });
                    if (tc.id) slot.id = tc.id;
                    if (tc.type) slot.type = tc.type;
                    const fn = tc.function || {};
                    if (fn.name && !slot.function.name) {
                        slot.function.name = fn.name;
                        emit('tool', fn.name);
                    }
                    if (typeof fn.arguments === 'string') slot.function.arguments += fn.arguments;
                    else if (fn.arguments && typeof fn.arguments === 'object') slot.function.arguments = JSON.stringify(fn.arguments);
                }
            }
        },
        finish() {
            if (!sawChoice && plain.trim()) return parseChatPayloadText(plain);
            if (!sawChoice) throw new Error('LLM 流式响应为空');
            const calls = tools.filter(Boolean).map((t, i) => ({ ...t, id: t.id || `call_${i}` }));
            const message = { role, content: content || (calls.length ? null : '') };
            if (reasoning) message.reasoning_content = reasoning;
            if (calls.length) message.tool_calls = calls;
            return { choices: [{ index: 0, message, finish_reason: finishReason }], usage };
        },
    };
}

module.exports = { postChatCompletion, createChatStreamAccumulator, parseChatPayloadText };
