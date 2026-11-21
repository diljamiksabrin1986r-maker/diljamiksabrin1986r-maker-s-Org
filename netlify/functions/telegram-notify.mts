import type { OrderNotification } from '../../src/utils/telegram';

function json(body: object, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isOrder(value: unknown): value is OrderNotification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const order = value as Record<string, unknown>;
  return (
    isText(order.orderNumber, 64) &&
    isText(order.customerName, 120) &&
    isText(order.customerPhone, 64) &&
    (order.deliveryAddress === undefined || isText(order.deliveryAddress, 500)) &&
    (order.deliveryType === 'delivery' || order.deliveryType === 'pickup') &&
    (order.deliveryType !== 'delivery' || isText(order.deliveryAddress, 500)) &&
    ['card_online', 'qr_online', 'cash_on_delivery'].includes(String(order.paymentMethod)) &&
    ['paid', 'pending', 'awaiting_verification', 'rejected'].includes(String(order.paymentStatus)) &&
    typeof order.totalAmount === 'number' && Number.isFinite(order.totalAmount) && order.totalAmount >= 0 &&
    Array.isArray(order.items) && order.items.length > 0 && order.items.length <= 200 &&
    order.items.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const line = item as Record<string, unknown>;
      return isText(line.name, 160) && isText(line.unit, 16) &&
        typeof line.quantity === 'number' && Number.isFinite(line.quantity) && line.quantity > 0 &&
        typeof line.lineTotal === 'number' && Number.isFinite(line.lineTotal) && line.lineTotal >= 0;
    })
  );
}

function formatMessage(order: OrderNotification): string {
  const money = (value: number) => `${value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
  // Keep customer text on one line and use plain text, without Telegram markup parsing.
  const line = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim();
  const payment = {
    card_online: 'Карта онлайн',
    qr_online: 'QR онлайн',
    cash_on_delivery: 'При получении',
  }[order.paymentMethod];
  const paymentStatus = {
    paid: 'Оплачен',
    pending: 'Ожидает оплаты',
    awaiting_verification: 'Ожидает проверки оплаты',
    rejected: 'Оплата отклонена',
  }[order.paymentStatus];
  const lines = [
    `Новый заказ ${line(order.orderNumber)}`,
    `Покупатель: ${line(order.customerName)}`,
    `Телефон: ${line(order.customerPhone)}`,
    `Получение: ${order.deliveryType === 'delivery' ? 'Доставка' : 'Самовывоз'}`,
    ...(order.deliveryType === 'delivery' ? [`Адрес: ${line(order.deliveryAddress!)}`] : []),
    `Оплата: ${payment} — ${paymentStatus}`,
    `Итого: ${money(order.totalAmount)}`,
    '',
    'Товары:',
  ];
  // Reserve space for the truncation notice and stay below Telegram's 4096-character limit.
  for (const [index, item] of order.items.entries()) {
    const itemLine = `${line(item.name)} — ${item.quantity} ${line(item.unit)}, ${money(item.lineTotal)}`;
    if ([...lines, itemLine].join('\n').length > 3900) {
      lines.push(`…ещё позиций: ${order.items.length - index}`);
      break;
    }
    lines.push(itemLine);
  }
  return lines.join('\n');
}

export default async (request: Request): Promise<Response> => {
  if (request.method !== 'POST') {
    return json({ error: 'Разрешён только POST.' }, 405, { Allow: 'POST' });
  }
  const origin = request.headers.get('origin');
  if ((origin && origin !== new URL(request.url).origin) ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'Запрос с другого сайта запрещён.' }, 403);
  }
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return json({ error: 'Ожидается application/json.' }, 415);
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > 128 * 1024) {
      return json({ error: 'Слишком большой запрос.' }, 413);
    }
    body = JSON.parse(text);
  } catch {
    return json({ error: 'Некорректный JSON.' }, 400);
  }
  if (!body || typeof body !== 'object' || !('order' in body) || !isOrder(body.order)) {
    return json({ error: 'Некорректные данные заказа.' }, 400);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    return json({ error: 'Уведомления Telegram не настроены.' }, 503);
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatMessage(body.order),
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(8_000),
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true) {
      return json({ error: 'Telegram не принял уведомление.' }, 502);
    }
    return json({ ok: true });
  } catch {
    // Fetch errors can contain the bot token in the URL. Never log or return them.
    return json({ error: 'Не удалось отправить уведомление в Telegram.' }, 502);
  }
};

export const config = {
  rateLimit: {
    action: 'rate_limit',
    aggregateBy: ['ip', 'domain'],
    windowLimit: 5,
    windowSize: 60,
  },
};
