import * as XLSX from 'xlsx';
import { jsPDF } from 'jspdf';
import type { Expense, InvoiceItemInput, Product, ProductUnit, Sale, WriteOff } from '../types';
import { normalizePluCode } from './barcode';

export function formatMoney(value: number): string {
  const formatted = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return `${formatted} смн`;
}

export function exportProductsToExcel(products: Product[]): void {
  const rows = products.map((p) => ({
    ID: p.id,
    Наименование: p.name,
    Штрихкод: p.barcode || '',
    PLU_весовой: p.pluCode ? normalizePluCode(p.pluCode) : '',
    Категория: p.category,
    Единица: p.unit,
    Весовой: p.isWeighted ? 'Да' : 'Нет',
    Быстрая_кнопка: p.isQuickItem ? 'Да' : 'Нет',
    Цена_продажи: p.retailPrice,
    Закупочная_цена: p.costPrice,
    Остаток: p.stock,
    Мин_остаток: p.minStock,
    Срок_годности: p.expiryDate || '',
    Поставщик: p.supplierName || '',
    Онлайн_витрина: p.activeOnline ? 'Да' : 'Нет',
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Номенклатура');
  XLSX.writeFile(wb, `FreshMart_Номенклатура_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export function downloadExcelImportTemplate(): void {
  const sample = [
    {
      Наименование: 'Кефир 2.5% 900мл',
      Штрихкод: '4601234567890',
      PLU_весовой: '',
      Категория: 'Молочные',
      Единица: 'шт',
      Весовой: 'Нет',
      Быстрая_кнопка: 'Нет',
      Цена_продажи: 98,
      Закупочная_цена: 72,
      Количество: 24,
      Мин_остаток: 10,
      Срок_годности: new Date(Date.now() + 12 * 86400000).toISOString().slice(0, 10),
      Поставщик: 'МолЗавод №1',
    },
    {
      Наименование: 'Бананы Эквадор',
      Штрихкод: '',
      PLU_весовой: '000205',
      Категория: 'Овощи и фрукты',
      Единица: 'кг',
      Весовой: 'Да',
      Быстрая_кнопка: 'Да',
      Цена_продажи: 149,
      Закупочная_цена: 105,
      Количество: 35,
      Мин_остаток: 10,
      Срок_годности: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10),
      Поставщик: 'ФруктТрейд',
    },
  ];
  const ws = XLSX.utils.json_to_sheet(sample);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Шаблон_импорта');
  XLSX.writeFile(wb, 'FreshMart_Шаблон_Номенклатуры.xlsx');
}

const VALID_UNITS: ProductUnit[] = ['шт', 'кг', 'л', 'уп'];

export async function parseNomenclatureExcel(file: File): Promise<
  (InvoiceItemInput & { pluCode?: string; isWeighted?: boolean; isQuickItem?: boolean; minStock?: number; supplierName?: string })[]
> {
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName]);

  return rows
    .map((row) => {
      const name = String(row['Наименование'] ?? row['name'] ?? row['Название'] ?? '').trim();
      if (!name) return null;
      const rawUnit = String(row['Единица'] ?? row['unit'] ?? 'шт').trim() as ProductUnit;
      const unit: ProductUnit = VALID_UNITS.includes(rawUnit) ? rawUnit : 'шт';
      const costPrice = Number(row['Закупочная_цена'] ?? row['costPrice'] ?? 0) || 0;
      const retailPrice =
        Number(row['Цена_продажи'] ?? row['retailPrice'] ?? Math.round(costPrice * 1.25)) || 0;
      const quantity = Number(row['Количество'] ?? row['Остаток'] ?? row['quantity'] ?? 0) || 0;
      const isWeightedStr = String(row['Весовой'] ?? '').toLowerCase();
      const isQuickStr = String(row['Быстрая_кнопка'] ?? '').toLowerCase();
      return {
        name,
        barcode: String(row['Штрихкод'] ?? row['barcode'] ?? '').trim(),
        pluCode: normalizePluCode(String(row['PLU_весовой'] ?? row['pluCode'] ?? '').trim()),
        category: String(row['Категория'] ?? row['category'] ?? 'Бакалея').trim() || 'Бакалея',
        unit,
        quantity,
        costPrice,
        retailPrice,
        minStock: Number(row['Мин_остаток'] ?? row['minStock'] ?? 5) || 5,
        expiryDate: String(row['Срок_годности'] ?? row['expiryDate'] ?? '').trim(),
        supplierName: String(row['Поставщик'] ?? row['supplierName'] ?? '').trim(),
        isWeighted: isWeightedStr === 'да' || isWeightedStr === 'true' || unit === 'кг',
        isQuickItem: isQuickStr === 'да' || isQuickStr === 'true',
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

export function exportFullFinancialExcel(
  sales: Sale[],
  expenses: Expense[],
  writeOffs: WriteOff[],
  products: Product[]
): void {
  const wb = XLSX.utils.book_new();

  const salesRows = sales.map((s) => ({
    Чек: s.receiptNumber,
    Дата: s.createdAt.slice(0, 19).replace('T', ' '),
    Тип: s.type === 'return' ? 'Возврат' : 'Продажа',
    Канал: s.channel === 'online' ? 'Онлайн' : 'Касса',
    Оплата: s.paymentMethod,
    Выручка: s.type === 'return' ? -s.totalAmount : s.totalAmount,
    Себестоимость: s.type === 'return' ? -s.costTotal : s.costTotal,
    Прибыль_валовая:
      s.type === 'return' ? -(s.totalAmount - s.costTotal) : s.totalAmount - s.costTotal,
    Кассир: s.cashierName,
  }));

  const expenseRows = expenses.map((e) => ({
    Дата: e.expenseDate,
    Категория: e.category,
    Сумма: e.amount,
    Описание: e.description,
  }));

  const writeOffRows = writeOffs.map((w) => ({
    Дата: w.createdAt.slice(0, 10),
    Товар: w.productName,
    Категория: w.category,
    Количество: w.quantity,
    Ед: w.unit,
    Убыток_смн: w.costValue,
    Причина: w.reason,
  }));

  const stockRows = products.map((p) => ({
    Товар: p.name,
    Категория: p.category,
    Остаток: p.stock,
    Закуп_цена: p.costPrice,
    Оценка_склада: Math.round(p.stock * p.costPrice * 100) / 100,
    Розница: p.retailPrice,
  }));

  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salesRows), 'Продажи');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(expenseRows), 'Расходы');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(writeOffRows), 'Списания');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(stockRows), 'Склад_оценка');

  XLSX.writeFile(wb, `FreshMart_Финансовый_Отчет_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

export interface FinancialReportSummary {
  periodLabel: string;
  revenue: number;
  returns: number;
  netRevenue: number;
  cogs: number;
  grossProfit: number;
  writeOffLoss: number;
  operatingExpenses: number;
  netProfit: number;
  dailyRows: { date: string; revenue: number; expenses: number; netProfit: number }[];
  expenseByCategory: { category: string; amount: number }[];
}

export function exportFinancialCSV(summary: FinancialReportSummary): void {
  const lines: string[] = [];
  lines.push('Раздел;Показатель;Сумма (TJS)');
  lines.push(`Сводка за ${summary.periodLabel};Валовая выручка;${summary.revenue.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Возвраты;${summary.returns.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Чистая выручка;${summary.netRevenue.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Себестоимость продаж;${summary.cogs.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Валовая прибыль;${summary.grossProfit.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Списания и брак;${summary.writeOffLoss.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};Операционные расходы;${summary.operatingExpenses.toFixed(2)}`);
  lines.push(`Сводка за ${summary.periodLabel};ЧИСТАЯ ПРИБЫЛЬ;${summary.netProfit.toFixed(2)}`);
  lines.push('');
  lines.push('Дата;Выручка (TJS);Расходы и списания (TJS);Чистая прибыль (TJS)');
  for (const row of summary.dailyRows) {
    lines.push(`${row.date};${row.revenue.toFixed(2)};${row.expenses.toFixed(2)};${row.netProfit.toFixed(2)}`);
  }
  lines.push('');
  lines.push('Категория расходов;Сумма (TJS)');
  for (const cat of summary.expenseByCategory) {
    lines.push(`${cat.category};${cat.amount.toFixed(2)}`);
  }

  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `FreshMart_PnL_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Renders a crisp Cyrillic financial P&L report onto high-DPI HTML5 canvas pages
 * and exports a valid multi-page A4 PDF using jsPDF (guarantees perfect Russian glyphs).
 */
export function exportFinancialPDF(summary: FinancialReportSummary): void {
  const pageWidthPx = 1240;
  const pageHeightPx = 1754;
  const canvas = document.createElement('canvas');
  canvas.width = pageWidthPx;
  canvas.height = pageHeightPx;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pdfW = pdf.internal.pageSize.getWidth();
  const pdfH = pdf.internal.pageSize.getHeight();

  const clearPage = () => {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, pageWidthPx, pageHeightPx);
  };

  clearPage();

  // Header
  ctx.fillStyle = '#059669';
  ctx.fillRect(72, 64, pageWidthPx - 144, 6);

  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 34px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText('FreshMart Pro — Финансовый отчет (P&L)', 72, 122);

  ctx.fillStyle = '#475569';
  ctx.font = '18px "Manrope", Arial, sans-serif';
  ctx.fillText(
    `Период: ${summary.periodLabel}   ·   Сформирован: ${new Date().toLocaleString('ru-RU')}`,
    72,
    158
  );

  // KPI Grid
  const kpis = [
    { label: 'Чистая выручка', value: formatMoney(summary.netRevenue), color: '#0F172A' },
    { label: 'Себестоимость (COGS)', value: formatMoney(summary.cogs), color: '#334155' },
    { label: 'Расходы и списания', value: formatMoney(summary.operatingExpenses + summary.writeOffLoss), color: '#D97706' },
    {
      label: 'Чистая прибыль',
      value: formatMoney(summary.netProfit),
      color: summary.netProfit >= 0 ? '#059669' : '#DC2626',
    },
  ];

  const cardW = (pageWidthPx - 144 - 48) / 4;
  kpis.forEach((k, idx) => {
    const x = 72 + idx * (cardW + 16);
    const y = 194;
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(x, y, cardW, 110);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, cardW, 110);

    ctx.fillStyle = '#64748B';
    ctx.font = '16px "Manrope", Arial, sans-serif';
    ctx.fillText(k.label, x + 18, y + 38);

    ctx.fillStyle = k.color;
    ctx.font = 'bold 24px "JetBrains Mono", monospace';
    ctx.fillText(k.value, x + 18, y + 82);
  });

  // P&L Breakdown Table
  let y = 356;
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 22px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText('1. Отчет о прибылях и убытках (P&L)', 72, y);
  y += 28;

  const pnlLines: [string, number, boolean][] = [
    ['Валовая выручка (POS + Онлайн-магазин)', summary.revenue, false],
    ['Возвраты покупателей', -summary.returns, false],
    ['Чистая выручка', summary.netRevenue, true],
    ['Себестоимость реализованных товаров', -summary.cogs, false],
    ['Валовая прибыль', summary.grossProfit, true],
    ['Списания и брак (убыток)', -summary.writeOffLoss, false],
    ['Операционные расходы', -summary.operatingExpenses, false],
    ['ИТОГО ЧИСТАЯ ПРИБЫЛЬ', summary.netProfit, true],
  ];

  pnlLines.forEach(([label, val, bold], idx) => {
    if (idx % 2 === 0) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(72, y, pageWidthPx - 144, 42);
    }
    ctx.fillStyle = bold ? '#0F172A' : '#334155';
    ctx.font = `${bold ? 'bold ' : ''}18px "Manrope", Arial, sans-serif`;
    ctx.fillText(label, 88, y + 27);

    ctx.textAlign = 'right';
    ctx.fillStyle = bold && label.includes('ЧИСТАЯ ПРИБЫЛЬ') ? (val >= 0 ? '#059669' : '#DC2626') : '#0F172A';
    ctx.font = `${bold ? 'bold ' : ''}18px "JetBrains Mono", monospace`;
    ctx.fillText(formatMoney(val), pageWidthPx - 88, y + 27);
    ctx.textAlign = 'left';
    y += 42;
  });

  // Expenses by category
  y += 46;
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 22px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText('2. Структура расходов по категориям', 72, y);
  y += 28;

  summary.expenseByCategory.forEach((cat, idx) => {
    if (idx % 2 === 0) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(72, y, pageWidthPx - 144, 38);
    }
    ctx.fillStyle = '#334155';
    ctx.font = '17px "Manrope", Arial, sans-serif';
    ctx.fillText(cat.category, 88, y + 25);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#0F172A';
    ctx.font = '17px "JetBrains Mono", monospace';
    ctx.fillText(formatMoney(cat.amount), pageWidthPx - 88, y + 25);
    ctx.textAlign = 'left';
    y += 38;
  });

  // Daily Dynamics
  y += 46;
  ctx.fillStyle = '#0F172A';
  ctx.font = 'bold 22px "Plus Jakarta Sans", Arial, sans-serif';
  ctx.fillText('3. Динамика по дням', 72, y);
  y += 28;

  // Table header
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(72, y, pageWidthPx - 144, 40);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 16px "Manrope", Arial, sans-serif';
  ctx.fillText('Дата', 88, y + 26);
  ctx.textAlign = 'right';
  ctx.fillText('Выручка', 620, y + 26);
  ctx.fillText('Расходы', 880, y + 26);
  ctx.fillText('Чистая прибыль', pageWidthPx - 88, y + 26);
  ctx.textAlign = 'left';
  y += 40;

  summary.dailyRows.slice(0, 14).forEach((row, idx) => {
    if (y > pageHeightPx - 90) {
      pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdfW, pdfH);
      pdf.addPage();
      clearPage();
      y = 80;
    }
    if (idx % 2 === 0) {
      ctx.fillStyle = '#F8FAFC';
      ctx.fillRect(72, y, pageWidthPx - 144, 36);
    }
    ctx.fillStyle = '#334155';
    ctx.font = '16px "JetBrains Mono", monospace';
    ctx.fillText(row.date, 88, y + 24);
    ctx.textAlign = 'right';
    ctx.fillText(formatMoney(row.revenue), 620, y + 24);
    ctx.fillText(formatMoney(row.expenses), 880, y + 24);
    ctx.fillStyle = row.netProfit >= 0 ? '#059669' : '#DC2626';
    ctx.fillText(formatMoney(row.netProfit), pageWidthPx - 88, y + 24);
    ctx.textAlign = 'left';
    y += 36;
  });

  pdf.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, pdfW, pdfH);
  pdf.save(`FreshMart_Финансовый_Отчет_${new Date().toISOString().slice(0, 10)}.pdf`);
}
