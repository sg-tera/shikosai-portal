const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

const html = readFileSync(`${__dirname}/../index.html`, 'utf8');
const script = html.match(/<script id="congestion-script">([\s\S]*?)<\/script>/)[1];
const available = { gameId: 1, name: '<img src=x onerror=alert(1)>', status: 'available', expectedEndAt: null };
const inUse = { gameId: 2, name: '利用中ゲーム', status: 'in_use', expectedEndAt: '2020-01-01T01:30:00.000Z' };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal DOM and controlled timers exercise the actual inline script without dependencies.
function setup(fetcher) {
    const elements = new Map();
    const timeouts = new Map();
    const intervals = new Map();
    const events = {};
    const windowEvents = {};
    const calls = [];
    let timerId = 0;
    function element() {
        return {
            dataset: {}, children: [], textContent: '', listeners: {},
            removeAttribute(name) { if (name === 'datetime') delete this.dateTime; },
            append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; },
            addEventListener(type, callback) { this.listeners[type] = callback; }
        };
    }
    for (const id of ['status-message', 'status-updated', 'status-refresh']) {
        elements.set(id, element());
    }
    elements.get('status-updated').textContent = '未取得';
    const panel = element();
    panel.dataset.apiUrl = html.match(/data-api-url="([^"]+)"/)[1];
    const cards = [1, 2, null].map(id => {
        const badge = element();
        badge.textContent = '未確認';
        const end = element();
        end.hidden = true;
        return { dataset: { gameId: id === null ? '' : String(id) }, badge, end,
            querySelector: selector => selector === '.status-badge' ? badge : end };
    });
    panel.querySelectorAll = () => cards;
    elements.set('game', panel);
    const document = {
        hidden: false,
        querySelector: () => panel,
        getElementById: id => elements.get(id),
        createElement: element,
        addEventListener: (type, callback) => { events[type] = callback; }
    };
    runInNewContext(script, {
        document, Intl, Date, AbortController,
        window: { addEventListener: (type, callback) => { windowEvents[type] = callback; } },
        fetch: (...args) => { calls.push(args); return fetcher(...args); },
        setTimeout: (callback, delay) => { const id = ++timerId; timeouts.set(id, { callback, delay }); return id; },
        clearTimeout: id => timeouts.delete(id),
        setInterval: (callback, delay) => { const id = ++timerId; intervals.set(id, { callback, delay }); return id; },
        clearInterval: id => intervals.delete(id)
    });
    return { elements, cards, calls, document, events, windowEvents, timeouts, intervals };
}
const response = data => ({ ok: true, json: async () => data });

test('matches cards by ID, preserves static titles, and keeps overdue games in use', async () => {
    const env = setup(async () => response([inUse, available]));
    await settle();
    assert.equal(env.cards[0].badge.textContent, '空き');
    assert.equal(env.cards[0].end.hidden, true);
    assert.equal(env.cards[1].badge.textContent, '利用中');
    assert.match(env.cards[1].end.textContent, /10:30:00/);
    assert.equal(env.cards[2].badge.textContent, '未確認');
    assert.match(env.elements.get('status-updated').dateTime, /Z$/);
    assert.equal(env.calls[0][0], 'https://shikosai-api-staging.sg-tera.workers.dev/v1/status');
    assert.equal(env.calls[0][1].credentials, 'omit');
    assert.equal(env.calls[0][1].cache, 'no-store');
    assert.equal(html.includes('status-summary'), false);
    assert.match(html, /<h3>花いちもんめ<\/h3>\s*<div class="game-status"/);
});

test('initial failure stays unknown; manual fetch can recover with an empty list', async () => {
    let fail = true;
    const env = setup(async () => { if (fail) throw new Error('offline'); return response([]); });
    await settle();
    assert.equal(env.cards[0].badge.textContent, '未確認');
    assert.equal(env.elements.get('status-updated').textContent, '未取得');
    assert.equal(env.elements.get('status-message').dataset.error, 'true');
    assert.equal(env.calls.length, 1);
    fail = false;
    await env.elements.get('status-refresh').listeners.click();
    assert.equal(env.cards[0].badge.textContent, '未確認');
    assert.equal(env.elements.get('status-message').textContent, '');
});

test('HTTP, malformed JSON, invalid status, and duplicate ID failures preserve the last success', async () => {
    let next = response([available]);
    const env = setup(async () => next);
    await settle();
    const status = env.cards[0].badge.textContent;
    const timestamp = env.elements.get('status-updated').textContent;
    for (const failure of [
        { ok: false },
        { ok: true, json: async () => { throw new SyntaxError(); } },
        response({ games: [available] }),
        response([{ ...available, status: 'unknown' }]),
        response([available, available]),
        response([{ ...inUse, expectedEndAt: null }])
    ]) {
        next = failure;
        await env.elements.get('status-refresh').listeners.click();
        assert.equal(env.cards[0].badge.textContent, status);
        assert.equal(env.elements.get('status-updated').textContent, timestamp);
        assert.match(env.elements.get('status-message').textContent, /前回の情報/);
    }
});

test('polls every 60 seconds, stops while hidden, fetches on return, and restores after bfcache', async () => {
    const env = setup(async () => response([available]));
    await settle();
    assert.equal([...env.intervals.values()][0].delay, 60000);
    await [...env.intervals.values()][0].callback();
    assert.equal(env.calls.length, 2);
    env.document.hidden = true;
    env.events.visibilitychange();
    assert.equal(env.intervals.size, 0);
    await env.elements.get('status-refresh').listeners.click();
    assert.equal(env.calls.length, 2);
    env.document.hidden = false;
    env.events.visibilitychange();
    await settle();
    assert.equal(env.calls.length, 3);
    assert.equal(env.intervals.size, 1);
    env.windowEvents.pagehide();
    assert.equal(env.intervals.size, 0);
    env.windowEvents.pageshow({ persisted: true });
    await settle();
    assert.equal(env.calls.length, 4);
    assert.equal(env.intervals.size, 1);
});

test('times out after 10 seconds and blocks overlapping manual and periodic requests', async () => {
    const env = setup((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('timeout')));
    }));
    const timeout = [...env.timeouts.values()][0];
    assert.equal(timeout.delay, 10000);
    await env.elements.get('status-refresh').listeners.click();
    await [...env.intervals.values()][0].callback();
    assert.equal(env.calls.length, 1);
    assert.equal(env.elements.get('status-refresh').disabled, true);
    timeout.callback();
    await settle();
    assert.equal(env.elements.get('status-refresh').disabled, false);
    assert.equal(env.cards[0].badge.textContent, '未確認');
    assert.equal(env.calls.length, 1);
    assert.equal(env.timeouts.size, 0);
});
