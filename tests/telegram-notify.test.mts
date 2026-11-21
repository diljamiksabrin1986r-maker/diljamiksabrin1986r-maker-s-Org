import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import handler from '../netlify/functions/telegram-notify.mts';
import { notifyNewOrder, type OrderNotification } from '../src/utils/telegram.ts';
import type { OnlineOrder } from '../src/types.ts';

function sampleOrder(): OrderNotification {
  return {
    orderNumber: 'ОНЛ-12345',
    customerName: 'Тестовый покупатель',
    customerPhone: '+70000000000',
    deliveryType: 'delivery',
    deliveryAddress: 'Тестовый адрес',
    paymentMethod: 'qr_online',
    paymentStatus: 'awaiting_verification',
    totalAmount: 250,
    items: [{ name: 'Молоко', quantity: 2, unit: 'л', lineTotal: 250 }],
  };
}

function request(body: unknown = { order: sampleOrder() }, headers: Record<string, string> = {}) {
  return new Request('https://store.example/.netlify/functions/telegram-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://store.example', ...headers },
    body: JSON.stringify(body),
  });
}

let originalFetch: typeof fetch;
let originalToken: string | undefined;
let originalChatId: string | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalToken = process.env.TELEGRAM_BOT_TOKEN;
  originalChatId = process.env.TELEGRAM_CHAT_ID;
  // Synthetic fixtures, never real credentials.
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  process.env.TELEGRAM_CHAT_ID = 'test-chat';
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  if (originalChatId === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = originalChatId;
});

test('sends a Russian order summary to the configured recipient with a timeout', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.telegram.org/bottest-only/sendMessage');
    assert.equal(init?.method, 'POST');
    assert.ok(init?.signal instanceof AbortSignal);
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.chat_id, 'test-chat');
    assert.match(payload.text, /Новый заказ ОНЛ-12345/);
    assert.match(payload.text, /Молоко — 2 л, 250 ₽/);
    assert.match(payload.text, /Ожидает проверки оплаты/);
    assert.match(payload.text, /Адрес: Тестовый адрес/);
    assert.equal(payload.parse_mode, undefined);
    assert.deepEqual(payload.link_preview_options, { is_disabled: true });
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  const response = await handler(request({ order: sampleOrder(), chat_id: 'ignored-target' }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(calls, 1);
});

test('truncates long item lists within the Telegram message limit', async () => {
  const order = sampleOrder();
  order.items = Array.from({ length: 200 }, () => ({
    name: 'Я'.repeat(160), unit: 'шт', quantity: 1, lineTotal: 1,
  }));
  globalThis.fetch = async (_url, init) => {
    const { text } = JSON.parse(String(init?.body));
    assert.ok(text.length <= 4096);
    assert.match(text, /ещё позиций:/);
    return Response.json({ ok: true });
  };
  assert.equal((await handler(request({ order }))).status, 200);
});

test('accepts pickup without an address and does not interpret Telegram markup', async () => {
  const order = sampleOrder();
  order.deliveryType = 'pickup';
  delete order.deliveryAddress;
  order.customerName = '<b>Имя</b>\nНовая строка';
  globalThis.fetch = async (_url, init) => {
    const { text, parse_mode } = JSON.parse(String(init?.body));
    assert.match(text, /Получение: Самовывоз/);
    assert.match(text, /Покупатель: <b>Имя<\/b> Новая строка/);
    assert.doesNotMatch(text, /Адрес:/);
    assert.equal(parse_mode, undefined);
    return Response.json({ ok: true });
  };
  assert.equal((await handler(request({ order }))).status, 200);
});

test('rejects unsupported methods, cross-site requests and non-JSON bodies', async () => {
  const get = await handler(new Request('https://store.example/.netlify/functions/telegram-notify'));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('allow'), 'POST');
  assert.equal((await handler(request(undefined, { Origin: 'https://another.example' }))).status, 403);
  assert.equal((await handler(request(undefined, { 'Sec-Fetch-Site': 'cross-site' }))).status, 403);
  assert.equal((await handler(request(undefined, { 'Content-Type': 'text/plain' }))).status, 415);
});

test('rejects malformed JSON, invalid orders and oversized bodies before calling Telegram', async () => {
  const malformed = new Request('https://store.example/.netlify/functions/telegram-notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal((await handler(malformed)).status, 400);
  for (const body of [null, {}, { order: null }, { order: {} },
    { order: { ...sampleOrder(), items: [] } },
    { order: { ...sampleOrder(), totalAmount: -1 } },
    { order: { ...sampleOrder(), paymentMethod: 'unknown' } },
    { order: { ...sampleOrder(), customerPhone: '' } },
    { order: { ...sampleOrder(), items: [{ name: 'Молоко', unit: 'л', quantity: 0, lineTotal: 1 }] } },
  ]) {
    assert.equal((await handler(request(body))).status, 400);
  }
  assert.equal((await handler(request({ extra: 'Я'.repeat(128 * 1024) }))).status, 413);
});

test('reports missing server configuration without exposing credentials', async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal((await handler(request())).status, 503);
  process.env.TELEGRAM_BOT_TOKEN = 'test-only';
  delete process.env.TELEGRAM_CHAT_ID;
  assert.equal((await handler(request())).status, 503);
});

test('sanitizes Telegram failures, invalid responses, network errors and timeouts', async () => {
  for (const mockFetch of [
    async () => Response.json({ ok: false, description: 'test-only test-chat' }, { status: 403 }),
    async () => Response.json({ ok: false }),
    async () => new Response('<html>test-only</html>', { status: 502 }),
    async () => { throw new Error('https://api.telegram.org/bottest-only/sendMessage'); },
    async () => { throw new DOMException('test-only', 'TimeoutError'); },
  ]) {
    globalThis.fetch = mockFetch;
    const response = await handler(request());
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /test-only|test-chat|api\.telegram\.org/);
  }
});

test('checkout sends minimal notification fields without payment proofs or internal identifiers', async () => {
  const order: OnlineOrder = {
    ...sampleOrder(),
    id: 'ord-test', customerId: 'customer-test', orderStatus: 'new',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    paymentProofNote: 'private proof', paymentProofImage: 'private image',
    items: [{ ...sampleOrder().items[0], productId: 'product-test', unitPrice: 125 }],
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/.netlify/functions/telegram-notify');
    assert.deepEqual(JSON.parse(String(init?.body)), { order: sampleOrder() });
    return Response.json({ ok: true });
  };
  await notifyNewOrder(order);
  globalThis.fetch = async () => Response.json({ error: 'Unavailable' }, { status: 503 });
  await assert.rejects(notifyNewOrder(order), /Уведомление Telegram не отправлено/);
});

