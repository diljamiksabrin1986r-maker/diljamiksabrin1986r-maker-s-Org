import type { Product } from '../types';
import { normalizePluCode } from './barcode';

export interface ScaleSyncResult {
  ok: boolean;
  message: string;
  syncedCount?: number;
  syncedAt?: string;
}

export interface ScaleSyncPayloadItem {
  productId: string;
  pluCode: string;
  name: string;
  retailPrice: number;
  unit: string;
  expiryDate?: string;
}

/**
 * Automatically sends weighted product updates (6-digit PLU, price, name) to the electronic scales bridge.
 */
export async function syncWeightedProductsToScales(
  products: Product[]
): Promise<ScaleSyncResult> {
  const weightedItems: ScaleSyncPayloadItem[] = products
    .filter((p) => p.isWeighted && normalizePluCode(p.pluCode).length === 6)
    .map((p) => ({
      productId: p.id,
      pluCode: normalizePluCode(p.pluCode),
      name: p.name,
      retailPrice: p.retailPrice,
      unit: p.unit,
      expiryDate: p.expiryDate || '',
    }));

  if (weightedItems.length === 0) {
    return {
      ok: false,
      message: 'У весового товара не задан 6-значный PLU-код — выгрузка на весы пропущена.',
    };
  }

  try {
    const resp = await fetch('/api/scales/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ items: weightedItems }),
    });

    const data = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      syncedCount?: number;
      syncedAt?: string;
    };

    if (!resp.ok || !data.ok) {
      return {
        ok: false,
        message: data.error || `Ошибка связи с весами (код ${resp.status}).`,
      };
    }

    if (weightedItems.length === 1) {
      const item = weightedItems[0];
      return {
        ok: true,
        syncedCount: 1,
        syncedAt: data.syncedAt,
        message: `Весы обновлены: PLU ${item.pluCode} · ${item.name} (${item.retailPrice.toFixed(2)} смн/${item.unit})`,
      };
    }

    return {
      ok: true,
      syncedCount: data.syncedCount ?? weightedItems.length,
      syncedAt: data.syncedAt,
      message: `Весы автоматически обновлены (${weightedItems.length} весовых поз., 6-значный PLU).`,
    };
  } catch {
    return {
      ok: false,
      message: 'Нет связи со службой весов. Проверьте подключение и повторите попытку.',
    };
  }
}

export function shouldAutoSyncProductToScales(
  nextProduct: Product,
  prevProduct?: Product | null
): boolean {
  if (!nextProduct.isWeighted) return false;
  if (!prevProduct) return true;
  return (
    !prevProduct.isWeighted ||
    prevProduct.name !== nextProduct.name ||
    prevProduct.retailPrice !== nextProduct.retailPrice ||
    normalizePluCode(prevProduct.pluCode) !== normalizePluCode(nextProduct.pluCode)
  );
}
