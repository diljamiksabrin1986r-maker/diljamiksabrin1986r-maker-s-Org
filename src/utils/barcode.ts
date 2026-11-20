import type { Product } from '../types';

export const PLU_LENGTH = 6;

export interface BarcodeParseResult {
  matchedProduct: Product | null;
  isWeightedBarcode: boolean;
  pluCode?: string;
  quantity: number;
  overrideLineTotal?: number;
  rawCode: string;
}

/**
 * Normalizes a scale PLU code to the 6-digit standard.
 * Legacy 1..5-digit PLU codes (e.g. "00101" or "101") are left-padded with zeros -> "000101".
 */
export function normalizePluCode(raw?: string | null): string {
  const digits = String(raw ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length <= PLU_LENGTH) {
    return digits.padStart(PLU_LENGTH, '0');
  }
  return digits.slice(0, PLU_LENGTH);
}

/**
 * Checks whether a PLU input is either empty or strictly 6 digits (after normalization or exact).
 */
export function isValidPluCode(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^\d{1,6}$/.test(trimmed);
}

/**
 * Generates the next available 6-digit PLU code based on existing products.
 */
export function generateNextPluCode(products: Product[]): string {
  let maxNum = 0;
  for (const p of products) {
    const norm = normalizePluCode(p.pluCode);
    if (norm) {
      const n = parseInt(norm, 10);
      if (!Number.isNaN(n) && n > maxNum && n < 999999) {
        maxNum = n;
      }
    }
  }
  const next = Math.min(999999, Math.max(1001, maxNum + 1));
  return String(next).padStart(PLU_LENGTH, '0');
}

function findProductByPlu(products: Product[], rawPlu: string): Product | null {
  const normalized = normalizePluCode(rawPlu);
  if (!normalized) return null;
  const numericTarget = parseInt(normalized, 10);

  return (
    products.find((p) => normalizePluCode(p.pluCode) === normalized) ||
    products.find((p) => {
      const pNorm = normalizePluCode(p.pluCode);
      return pNorm !== '' && parseInt(pNorm, 10) === numericTarget;
    }) ||
    null
  );
}

/**
 * Parses standard retail EAN-13/EAN-8 barcodes AND electronic scale weighted barcodes.
 *
 * Supported weighted scale barcode formats:
 * 1) 6-digit PLU (13-digit EAN-13): [1-digit prefix '2'][6-digit PLU][5-digit grams][1-digit check]
 *    Example: 200010101250X -> PLU "000101", weight 1250g = 1.250 kg
 * 2) 6-digit PLU (14-digit extended): [2-digit prefix 20..29][6-digit PLU][5-digit grams/price][1-digit check]
 *    Example: 2200010101250X -> PLU "000101", weight 1250g = 1.250 kg
 * 3) 6-digit PLU (13-digit compact): [2-digit prefix 20..29][6-digit PLU][4-digit grams/price][1-digit check]
 *    Example: 220001011250X -> PLU "000101", weight 1250g = 1.250 kg
 * 4) Legacy 5-digit PLU (13-digit): [2-digit prefix 20..29][5-digit PLU][5-digit grams/price][1-digit check]
 *    Example: 2200101012504 -> PLU "00101" normalized to "000101", weight 1250g = 1.250 kg
 */
export function parseRetailBarcode(rawInput: string, products: Product[]): BarcodeParseResult {
  const code = rawInput.trim().replace(/\s+/g, '');
  if (!code) {
    return { matchedProduct: null, isWeightedBarcode: false, quantity: 1, rawCode: code };
  }

  // Case 1: 14-digit extended scale label with 2-digit prefix + 6-digit PLU + 5-digit value + 1-digit check
  if (/^2[0-9]\d{12}$/.test(code)) {
    const prefix = code.slice(0, 2);
    const pluCode = normalizePluCode(code.slice(2, 8));
    const valuePart = parseInt(code.slice(8, 13), 10);
    const product =
      findProductByPlu(products, pluCode) ||
      products.find((p) => p.barcode === code) ||
      null;

    if (['23', '24', '25'].includes(prefix)) {
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

    const weightKg = Math.round((valuePart / 1000) * 1000) / 1000;
    return {
      matchedProduct: product,
      isWeightedBarcode: true,
      pluCode,
      quantity: weightKg > 0 ? weightKg : 0.1,
      rawCode: code,
    };
  }

  // Case 2: 13-digit scale label starting with 20..29
  if (/^2[0-9]\d{11}$/.test(code)) {
    const prefix2 = code.slice(0, 2);

    // 2a. Standard 6-digit PLU in EAN-13: [2][6-digit PLU][5-digit grams][check]
    const plu6FromPos1 = normalizePluCode(code.slice(1, 7));
    const grams5FromPos7 = parseInt(code.slice(7, 12), 10);
    const match6Pos1 = findProductByPlu(products, plu6FromPos1);

    // 2b. Compact 6-digit PLU in EAN-13: [20..29][6-digit PLU][4-digit grams][check]
    const plu6FromPos2 = normalizePluCode(code.slice(2, 8));
    const value4FromPos8 = parseInt(code.slice(8, 12), 10);
    const match6Pos2 = findProductByPlu(products, plu6FromPos2);

    // 2c. Legacy 5-digit PLU in EAN-13: [20..29][5-digit PLU -> padded to 6][5-digit grams/price][check]
    const legacyPlu5 = code.slice(2, 7);
    const legacyPlu6 = normalizePluCode(legacyPlu5);
    const legacyValue5 = parseInt(code.slice(7, 12), 10);
    const matchLegacy5 = findProductByPlu(products, legacyPlu6);

    // Prefer exact 6-digit match when found, otherwise fallback to legacy 5-digit padded match
    if (match6Pos1 && !matchLegacy5) {
      const weightKg = Math.round((grams5FromPos7 / 1000) * 1000) / 1000;
      return {
        matchedProduct: match6Pos1,
        isWeightedBarcode: true,
        pluCode: plu6FromPos1,
        quantity: weightKg > 0 ? weightKg : 0.1,
        rawCode: code,
      };
    }

    if (match6Pos2 && !matchLegacy5) {
      if (['23', '24', '25'].includes(prefix2)) {
        const embeddedPrice = value4FromPos8 / 100;
        const qty =
          match6Pos2.retailPrice > 0
            ? Math.round((embeddedPrice / match6Pos2.retailPrice) * 1000) / 1000
            : 1;
        return {
          matchedProduct: match6Pos2,
          isWeightedBarcode: true,
          pluCode: plu6FromPos2,
          quantity: qty,
          overrideLineTotal: embeddedPrice,
          rawCode: code,
        };
      }
      const weightKg = Math.round((value4FromPos8 / 1000) * 1000) / 1000;
      return {
        matchedProduct: match6Pos2,
        isWeightedBarcode: true,
        pluCode: plu6FromPos2,
        quantity: weightKg > 0 ? weightKg : 0.1,
        rawCode: code,
      };
    }

    if (match6Pos1) {
      const weightKg = Math.round((grams5FromPos7 / 1000) * 1000) / 1000;
      return {
        matchedProduct: match6Pos1,
        isWeightedBarcode: true,
        pluCode: plu6FromPos1,
        quantity: weightKg > 0 ? weightKg : 0.1,
        rawCode: code,
      };
    }

    const legacyProduct =
      matchLegacy5 || products.find((p) => p.barcode === code) || null;

    if (['23', '24', '25'].includes(prefix2)) {
      const embeddedPrice = legacyValue5 / 100;
      const qty =
        legacyProduct && legacyProduct.retailPrice > 0
          ? Math.round((embeddedPrice / legacyProduct.retailPrice) * 1000) / 1000
          : 1;
      return {
        matchedProduct: legacyProduct,
        isWeightedBarcode: true,
        pluCode: legacyPlu6,
        quantity: qty,
        overrideLineTotal: embeddedPrice,
        rawCode: code,
      };
    }

    const weightKg = Math.round((legacyValue5 / 1000) * 1000) / 1000;
    return {
      matchedProduct: legacyProduct,
      isWeightedBarcode: true,
      pluCode: legacyPlu6,
      quantity: weightKg > 0 ? weightKg : 0.1,
      rawCode: code,
    };
  }

  // Case 3: Standard barcode or direct 1..6-digit PLU lookup (auto-handles old 5-digit & new 6-digit PLU)
  const exact =
    products.find((p) => p.barcode === code) ||
    (/^\d{1,6}$/.test(code) ? findProductByPlu(products, code) : null) ||
    null;

  return {
    matchedProduct: exact,
    isWeightedBarcode: Boolean(exact?.isWeighted),
    pluCode: exact?.pluCode ? normalizePluCode(exact.pluCode) : undefined,
    quantity: exact?.isWeighted ? 0.5 : 1,
    rawCode: code,
  };
}

/**
 * Builds a valid 13-digit EAN-13 scale barcode using a 6-digit PLU:
 * Format: [2][6-digit PLU][5-digit grams][check digit]
 */
export function buildWeightedBarcodeSample(
  pluCode: string,
  weightGrams: number,
  prefix = '2'
): string {
  const cleanPrefix = prefix.slice(0, 1) || '2';
  const plu = normalizePluCode(pluCode || '1');
  const grams = Math.max(1, Math.round(weightGrams)).toString().padStart(5, '0').slice(0, 5);
  const body = `${cleanPrefix}${plu}${grams}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(body[i]) * (i % 2 === 0 ? 1 : 3);
  }
  const check = (10 - (sum % 10)) % 10;
  return `${body}${check}`;
}
