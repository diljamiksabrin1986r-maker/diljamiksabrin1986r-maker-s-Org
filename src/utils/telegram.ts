import type { OnlineOrder, OnlineOrderItem } from '../types';

export type OrderNotification = Pick<OnlineOrder,
  'orderNumber' | 'customerName' | 'customerPhone' | 'deliveryAddress' |
  'deliveryType' | 'paymentMethod' | 'paymentStatus' | 'totalAmount'
> & {
  items: Pick<OnlineOrderItem, 'name' | 'unit' | 'quantity' | 'lineTotal'>[];
};

export async function notifyNewOrder(order: OnlineOrder): Promise<void> {
  // Send only notification details, excluding payment proofs, images and internal IDs.
  const notification: OrderNotification = {
    orderNumber: order.orderNumber,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: order.deliveryAddress,
    deliveryType: order.deliveryType,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    totalAmount: order.totalAmount,
    items: order.items.map(({ name, unit, quantity, lineTotal }) => ({ name, unit, quantity, lineTotal })),
  };
  const body = JSON.stringify({ order: notification });
  const response = await fetch('/.netlify/functions/telegram-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(12_000),
    keepalive: new TextEncoder().encode(body).byteLength <= 60 * 1024,
  });
  if (!response.ok) throw new Error('Уведомление Telegram не отправлено.');
}
