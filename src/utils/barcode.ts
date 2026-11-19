import type { Product } from '../types';

export interface BarcodeParseResult {
  matchedProduct: Product | null;
  isWeightedBarcode: boolean;
  pluCode?: string;
  quantity: number;
  overrideLineTotal?: number;
  rawCode: string;
}

/**
 * Parses standard retail EAN-13/EAN-8 barcodes AND electronic scale weighted barcodes.
 * Supported weighted barcode prefixes:
 * - 20, 21, 22, 27, 28: [2-digit prefix][5-digit PLU][5-digit weight in grams][1-digit check]
 *   Example: 2200101012504 -> PLU "00101", weight 1250g = 1.250 kg
 * - 23, 24, 25: [2-digit prefix][5-digit PLU][5-digit total price in kopecks/rub*100][1-digit check]
 */
export function parseRetailBarcode(rawInput: string, products: Product[]): BarcodeParseResult {
  const code = rawInput.trim().replace(/\s+/g, '');
  if (!code) {
    return { matchedProduct: null, isWeightedBarcode: false, quantity: 1, rawCode: code };
  }

  // Check if 13-digit weighted scale label starting with 20..29
  if (/^2[0-9]\d{11}$/.test(code)) {
    const prefix = code.slice(0, 2);
    const pluCode = code.slice(2, 7);
    const valuePart = parseInt(code.slice(7, 12), 10);

    const product =
      products.find((p) => p.pluCode === pluCode) ||
      products.find((p) => p.pluCode && Number(p.pluCode) === Number(pluCode)) ||
      products.find((p) => p.barcode === code) ||
      null;

    if (['23', '24', '25'].includes(prefix)) {
      // Price-embedded scale barcode (in 0.01 currency units)
      const embeddedPrice = valuePart / 100;
      const qty =
        product && product.retailPrice > 0
          ? Math.round((embeddedPrice / product.retailPrice) * 1000) / 1000
          : 1;
      return {
        matchedProduct: product,
        isWeightedBarcode: true,
        pluCode,
        quantity: qty,
        overrideLineTotal: embeddedPrice,
        rawCode: code,
      };
    }

    // Weight-embedded scale barcode (grams -> kg)
    const weightKg = Math.round((valuePart / 1000) * 1000) / 1000;
    return {
      matchedProduct: product,
      isWeightedBarcode: true,
      pluCode,
      quantity: weightKg > 0 ? weightKg : 0.1,
      rawCode: code,
    };
  }

  // Standard barcode or PLU match
  const exact =
    products.find((p) => p.barcode === code) ||
    products.find((p) => p.pluCode === code) ||
    null;

  return {
    matchedProduct: exact,
    isWeightedBarcode: Boolean(exact?.isWeighted),
    pluCode: exact?.pluCode,
    quantity: exact?.isWeighted ? 0.5 : 1,
    rawCode: code,
  };
}

export function buildWeightedBarcodeSample(pluCode: string, weightGrams: number, prefix = '22'): string {
  const plu = pluCode.padStart(5, '0').slice(0, 5);
  const grams = Math.max(1, Math.round(weightGrams)).toString().padStart(5, '0').slice(0, 5);
  const body = `${prefix}${plu}${grams}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}
