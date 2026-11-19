import type { HeldReceipt, OfflineSaleQueueItem, Product, SecurityLog } from '../types';

const CATALOG_CACHE_KEY = 'freshmart_pos_catalog_cache_v1';
const OFFLINE_QUEUE_KEY = 'freshmart_pos_offline_queue_v1';
const OFFLINE_SECURITY_QUEUE_KEY = 'freshmart_pos_security_queue_v1';
const HELD_RECEIPTS_KEY = 'freshmart_pos_held_receipts_v1';

export function saveCatalogCache(products: Product[]): void {
  try {
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(products));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadCatalogCache(): Product[] {
  try {
    const raw = localStorage.getItem(CATALOG_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Product[]) : [];
  } catch {
    return [];
  }
}

export function getOfflineQueue(): OfflineSaleQueueItem[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as OfflineSaleQueueItem[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineSale(item: OfflineSaleQueueItem): OfflineSaleQueueItem[] {
  const queue = getOfflineQueue();
  queue.push(item);
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore quota errors
  }
  return queue;
}

export function saveOfflineQueue(queue: OfflineSaleQueueItem[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore quota errors
  }
}

export function getOfflineSecurityQueue(): SecurityLog[] {
  try {
    const raw = localStorage.getItem(OFFLINE_SECURITY_QUEUE_KEY);
    return raw ? (JSON.parse(raw) as SecurityLog[]) : [];
  } catch {
    return [];
  }
}

export function enqueueOfflineSecurityLog(log: SecurityLog): SecurityLog[] {
  const queue = getOfflineSecurityQueue();
  if (!queue.some((existing) => existing.id === log.id)) {
    queue.push(log);
  }
  try {
    localStorage.setItem(OFFLINE_SECURITY_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore quota errors
  }
  return queue;
}

export function saveOfflineSecurityQueue(queue: SecurityLog[]): void {
  try {
    localStorage.setItem(OFFLINE_SECURITY_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Ignore quota errors
  }
}

export function loadHeldReceipts(): HeldReceipt[] {
  try {
    const raw = localStorage.getItem(HELD_RECEIPTS_KEY);
    return raw ? (JSON.parse(raw) as HeldReceipt[]) : [];
  } catch {
    return [];
  }
}

export function saveHeldReceipts(receipts: HeldReceipt[]): void {
  try {
    localStorage.setItem(HELD_RECEIPTS_KEY, JSON.stringify(receipts));
  } catch {
    // Ignore quota errors
  }
}
