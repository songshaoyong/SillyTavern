import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE } from '../../constants.js';
import { extension_settings, renderExtensionTemplateAsync } from '../../extensions.js';
import { saveBase64AsFile } from '../../utils.js';
import { Generate, appendMediaToMessage, getCurrentChatId, isGenerating, saveChatConditional, saveSettingsDebounced, sendMessageAsUser } from '../../../script.js';

const MODULE = 'transcript_feed';

const defaultSettings = {
    enabled: true,
    url: 'ws://127.0.0.1:8757/ws',
    eventType: 'caption',
    textPath: 'data.content',
    roomId: '',
    speaker: '主播',
    template: '{{speaker}}：{{text}}',
    minLength: 100,
    skipWhileGenerating: true,
    reply: true,
    includeSituation: true,
};

let socket = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const heldByRoom = new Map();
const lastTextByRoom = new Map();
const preparingRooms = new Set();
let accepted = 0;
let skipped = 0;
let inserting = false;
const BASELINE_KEY = 'transcript_feed_situation_baseline';

function readBaselines() {
    try {
        const parsed = JSON.parse(localStorage.getItem(BASELINE_KEY) || '{}');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function saveBaseline(roomId, counts) {
    const all = readBaselines();
    all[roomId] = {
        sessionId: counts.sessionId ?? null,
        chat: Number(counts.chat) || 0,
        gift: Number(counts.gift) || 0,
        like: Number(counts.like) || 0,
        follow: Number(counts.follow) || 0,
        member: Number(counts.member) || 0,
    };
    localStorage.setItem(BASELINE_KEY, JSON.stringify(all));
}

function settings() {
    extension_settings[MODULE] = Object.assign({}, defaultSettings, extension_settings[MODULE] ?? {});
    return extension_settings[MODULE];
}

function persist(reconnect) {
    saveSettingsDebounced();
    if (reconnect) connect();
}

function readPath(value, path) {
    const keys = String(path || '').split('.').map(key => key.trim()).filter(Boolean);
    let current = value;
    for (const key of keys) {
        if (!current || typeof current !== 'object') return '';
        current = current[key];
    }
    return typeof current === 'string' ? current.trim() : '';
}

function socketUrl() {
    const current = settings();
    const raw = String(current.url || defaultSettings.url).trim();
    const url = new URL(raw.includes('://') ? raw : `ws://${raw}`);
    if (current.eventType && !url.searchParams.has('types')) url.searchParams.set('types', current.eventType);
    if (current.roomId) url.searchParams.set('roomId', String(current.roomId).trim());
    else url.searchParams.delete('roomId');
    if (!url.searchParams.has('autoconnect')) url.searchParams.set('autoconnect', '0');
    return url.toString();
}

function setStatus(text) {
    const node = document.getElementById('transcript_feed_status');
    if (node) node.textContent = text;
}

function renderMessage(speaker, text) {
    const template = String(settings().template ?? '');
    if (!template.trim()) return text;
    return template.replaceAll('{{speaker}}', speaker).replaceAll('{{text}}', text);
}

function holdLimit() {
    return Math.max(1, Number(settings().minLength) || 100);
}

function httpBase() {
    const raw = String(settings().url || defaultSettings.url).trim();
    const url = new URL(raw.includes('://') ? raw : `ws://${raw}`);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.origin;
}

function formatCount(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return number.toLocaleString('zh-CN');
}

function formatClock(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('zh-CN', { hour12: false });
}

function situationLines(data) {
    const now = Number(data.at) || Date.now();
    const previous = readBaselines()[data.roomId];
    const sameSession = Boolean(previous && data.sessionId != null && Number(previous.sessionId) === Number(data.sessionId));
    const restarted = sameSession && ['chat', 'gift', 'like', 'follow', 'member'].some(key => Number(data[key]) < Number(previous[key]));
    const windowCounts = sameSession && !restarted
        ? {
            chat: Number(data.chat) - Number(previous.chat),
            gift: Number(data.gift) - Number(previous.gift),
            like: Number(data.like) - Number(previous.like),
            follow: Number(data.follow) - Number(previous.follow),
            member: Number(data.member) - Number(previous.member),
        }
        : null;
    const lines = ['直播间现状', `时间：${formatClock(now)}`];
    if (data.sessionDate && data.sessionNo) lines.push(`场次：${data.sessionDate} 第${data.sessionNo}场`);
    const sessionStart = formatClock(data.sessionStartedAt);
    if (sessionStart) lines.push(`本场开始：${sessionStart}`);
    const online = formatCount(data.online);
    const watched = formatCount(data.totalUser);
    const heat = formatCount(data.popularity);
    if (online) lines.push(`在线：${online}`);
    if (watched) lines.push(`累计观看：${watched}`);
    if (Number(data.popularity) > 0) lines.push(`热度：${heat}`);
    const tally = (counts) => `弹幕 ${formatCount(counts.chat) || 0}，送礼 ${formatCount(counts.gift) || 0}，点赞 ${formatCount(counts.like) || 0}，关注 ${formatCount(counts.follow) || 0}，进场 ${formatCount(counts.member) || 0}`;
    lines.push(`本场互动：${tally(data)}`);
    if (windowCounts) lines.push(`这段新增：${tally(windowCounts)}`);
    return lines.join('\n');
}

async function loadSituation(roomId) {
    if (settings().includeSituation === false || !roomId) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(`${httpBase()}/api/rooms/${encodeURIComponent(roomId)}/situation?image=1`, { signal: controller.signal });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || typeof data !== 'object') return null;
        data.roomId = roomId;
        return {
            text: situationLines(data),
            image: typeof data.image === 'string' ? data.image : '',
            counts: data,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function attachScreenshot(message, image) {
    // 没有打开的聊天（初始化中 / 未选角色）时保存必然失败，还会弹出"聊天无法保存"的报错
    if (!getCurrentChatId()) return;
    try {
        const url = await saveBase64AsFile(image, 'transcript', `live-${Date.now()}`, 'jpg');
        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra.media = [{
            url,
            type: MEDIA_TYPE.IMAGE,
            title: '直播间画面',
            source: MEDIA_SOURCE.API,
        }];
        message.extra.media_index = 0;
        message.extra.inline_image = true;
        message.extra.media_display = MEDIA_DISPLAY.LIST;
        const messageId = document.querySelectorAll('#chat .mes').length - 1;
        const node = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (node && globalThis.$) appendMediaToMessage(message, globalThis.$(node));
        await saveChatConditional();
    } catch (err) {
        // 画面附不上去不应该影响这条转写本身，更不应该弹保存失败
        console.warn('[transcript-feed] 附加直播间画面失败', err);
    }
}

function dropHeld(roomKey, reason) {
    heldByRoom.delete(roomKey);
    skipped += 1;
    setStatus(`${reason}写入 ${accepted}，丢掉 ${skipped}`);
}

async function considerHeld(roomKey) {
    const current = settings();
    const minLength = holdLimit();
    const heldText = heldByRoom.get(roomKey) || '';
    if (!heldText) return;
    if (heldText.length <= minLength) {
        setStatus(`已攒 ${heldText.length} 字，超过 ${minLength} 字再发送。写入 ${accepted}，丢掉 ${skipped}`);
        return;
    }
    if (preparingRooms.has(roomKey)) return;
    const speaker = String(current.speaker || '主播').trim() || '主播';
    const batch = heldText;
    if (batch === (lastTextByRoom.get(roomKey) || '')) {
        dropHeld(roomKey, '与上一句相同，已丢掉。');
        return;
    }
    if (!getCurrentChatId()) {
        dropHeld(roomKey, '没有打开的对话，已丢掉。');
        return;
    }
    if (current.skipWhileGenerating && (isGenerating() || inserting)) {
        dropHeld(roomKey, '场控正在生成，已丢掉。');
        return;
    }
    const roomId = String(current.roomId || roomKey || '').trim();
    heldByRoom.delete(roomKey);
    preparingRooms.add(roomKey);
    let situation = null;
    try {
        situation = await loadSituation(roomId);
    } finally {
        preparingRooms.delete(roomKey);
    }
    const spoken = renderMessage(speaker, batch);
    const text = situation?.text ? `${spoken}\n\n${situation.text}` : spoken;
    inserting = true;
    try {
        const message = await sendMessageAsUser(text, '', null, false, speaker);
        if (situation?.image) {
            try {
                await attachScreenshot(message, situation.image);
            } catch (error) {
                console.warn('直播间截图没有附上', error);
            }
        }
        if (situation?.counts && roomId) saveBaseline(roomId, situation.counts);
        lastTextByRoom.set(roomKey, batch);
        accepted += 1;
        if (current.reply) {
            setStatus(`已写入，正在请场控回复。写入 ${accepted}，丢掉 ${skipped}`);
            await replyToFeed();
        }
        setStatus(`已连接。写入 ${accepted}，丢掉 ${skipped}`);
    } catch (error) {
        skipped += 1;
        setStatus(`写入失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
        inserting = false;
        if (heldByRoom.get(roomKey)) void considerHeld(roomKey);
    }
}

async function acceptText(text, roomId) {
    const piece = String(text || '').trim();
    if (!piece) return;
    const roomKey = String(roomId || '').trim();
    const prev = heldByRoom.get(roomKey) || '';
    heldByRoom.set(roomKey, prev ? `${prev}\n${piece}` : piece);
    await considerHeld(roomKey);
}

async function replyToFeed() {
    const box = document.querySelector('#send_textarea');
    const draft = box ? String(box.value) : '';
    if (box) box.value = '';
    try {
        await Generate('normal', { automatic_trigger: true });
    } finally {
        if (box && draft && box.value === '') {
            box.value = draft;
            box.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
}

function onSocketMessage(raw) {
    let payload;
    try {
        payload = JSON.parse(raw.data);
    } catch {
        return;
    }
    if (!payload || typeof payload !== 'object') return;
    const type = typeof payload.type === 'string' ? payload.type : '';
    if (!type || type.startsWith('__')) return;
    const current = settings();
    if (current.eventType && type !== current.eventType) return;
    if (current.roomId && payload.roomId && String(payload.roomId) !== String(current.roomId).trim()) return;
    const text = readPath(payload, current.textPath);
    if (!text) return;
    void acceptText(text, payload.roomId || current.roomId || '');
}

function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (socket) {
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        socket.onmessage = null;
        socket.close();
        socket = null;
    }
}

function scheduleReconnect() {
    if (!settings().enabled || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
}

function connect() {
    disconnect();
    const current = settings();
    if (!current.enabled) {
        setStatus('已关闭');
        return;
    }
    let url = '';
    try {
        url = socketUrl();
    } catch {
        setStatus('WebSocket 地址无效');
        return;
    }
    const next = new WebSocket(url);
    socket = next;
    setStatus('正在连接…');
    next.onopen = () => {
        if (socket !== next) return;
        reconnectDelay = 1000;
        setStatus(`已连接。写入 ${accepted}，丢掉 ${skipped}`);
    };
    next.onmessage = (event) => {
        if (socket !== next) return;
        onSocketMessage(event);
    };
    next.onerror = () => {
        if (socket === next) setStatus('连接失败，正在重试');
    };
    next.onclose = () => {
        if (socket !== next) return;
        socket = null;
        setStatus('连接已断开，正在重试');
        scheduleReconnect();
    };
}

function bind(id, key, parse, reconnect, after) {
    const node = document.getElementById(id);
    if (!node) return;
    const current = settings();
    if (node.type === 'checkbox') node.checked = Boolean(current[key]);
    else node.value = current[key] ?? '';
    node.addEventListener('change', () => {
        const value = node.type === 'checkbox' ? node.checked : parse(node.value);
        settings()[key] = value;
        persist(reconnect);
        if (after) after();
    });
}

export async function init() {
    settings();
    const html = await renderExtensionTemplateAsync('transcript-feed', 'settings');
    document.getElementById('extensions_settings')?.insertAdjacentHTML('beforeend', html);
    bind('transcript_feed_enabled', 'enabled', value => value, true);
    bind('transcript_feed_url', 'url', value => value.trim(), true);
    bind('transcript_feed_event', 'eventType', value => value.trim(), true);
    bind('transcript_feed_path', 'textPath', value => value.trim() || 'data.content', false);
    bind('transcript_feed_room', 'roomId', value => value.trim(), true);
    bind('transcript_feed_speaker', 'speaker', value => value.trim() || '主播', false);
    bind('transcript_feed_template', 'template', value => value, false);
    bind('transcript_feed_min', 'minLength', value => Math.max(1, Number(value) || 100), false, () => { void considerHeld(); });
    bind('transcript_feed_skip', 'skipWhileGenerating', value => value, false);
    bind('transcript_feed_reply', 'reply', value => value, false);
    bind('transcript_feed_situation', 'includeSituation', value => value, false);
    connect();
}
