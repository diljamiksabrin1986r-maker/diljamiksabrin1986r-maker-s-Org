import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertOctagon,
  ArrowDownRight,
  ArrowUpRight,
  Building2,
  Download,
  FileSpreadsheet,
  FileText,
  KeyRound,
  Lock,
  QrCode,
  ShieldAlert,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
  CheckCircle2,
  Clock,
} from 'lucide-react';
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType, sha256Hex } from '../firebase';
import type {
  Expense,
  PosSecuritySettings,
  Product,
  Sale,
  SecurityLog,
  SecurityLogAction,
  Shift,
  StaffInvite,
  StoreSettings,
  SupplierInvoice,
  SupplierPayment,
  SupplierReturn,
  UserProfile,
  UserRole,
  WriteOff,
} from '../types';
import {
  exportFinancialCSV,
  exportFinancialPDF,
  exportFullFinancialExcel,
  formatMoney,
  type FinancialReportSummary,
} from '../utils/exportReports';

interface OwnerAnalyticsViewProps {
  user: UserProfile;
  products: Product[];
  sales: Sale[];
  expenses: Expense[];
  writeOffs: WriteOff[];
  shifts: Shift[];
  invoices: SupplierInvoice[];
  supplierPayments: SupplierPayment[];
  supplierReturns: SupplierReturn[];
  securityLogs: SecurityLog[];
  staffInvites: StaffInvite[];
  staffUsers: UserProfile[];
  storeSettings: StoreSettings | null;
  posSecurity: PosSecuritySettings | null;
}

type OwnerTab = 'pnl' | 'cashflow' | 'security' | 'shifts' | 'staff';
type PeriodMode = 'daily' | 'month' | 'year';

const ACTION_LABELS: Record<SecurityLogAction, string> = {
  remove_cart_item: 'Удаление товара из открытого чека',
  cancel_receipt: 'Отмена открытого чека',
  return_sale: 'Возврат товара покупателем',
  stock_adjustment: 'Изменение остатков / ревизия',
  price_change: 'Изменение цены товара',
  cash_out: 'Изъятие наличных из кассы',
  supplier_return: 'Возврат товара поставщику',
};

const PAYMENT_METHOD_LABELS: Record<SupplierPayment['paymentMethod'], string> = {
  cash: 'Наличные',
  bank_transfer: 'Безнал / перевод',
  card: 'Карта',
};

export const OwnerAnalyticsView: React.FC<OwnerAnalyticsViewProps> = ({
  user,
  products,
  sales,
  expenses,
  writeOffs,
  shifts,
  invoices,
  supplierPayments,
  supplierReturns,
  securityLogs,
  staffInvites,
  staffUsers,
  storeSettings,
  posSecurity: _posSecurity,
}) => {
  const [tab, setTab] = useState<OwnerTab>('pnl');
  const [periodMode, setPeriodMode] = useState<PeriodMode>('month');
  const [logFilter, setLogFilter] = useState<string>('all');
  const [notice, setNotice] = useState<string | null>(null);

  // Staff Invite Form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteName, setInviteName] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<UserRole, 'customer'>>('cashier');
  const [invite2FA, setInvite2FA] = useState(true);

  // Admin PIN & QR Merchant Form
  const [newAdminPin, setNewAdminPin] = useState('');
  const [qrMerchantInput, setQrMerchantInput] = useState(
    storeSettings?.qrMerchantId || 'FRESHMART-SBP-001'
  );

  useEffect(() => {
    if (storeSettings?.qrMerchantId) {
      setQrMerchantInput(storeSettings.qrMerchantId);
    }
  }, [storeSettings?.qrMerchantId]);

  // Period filtering
  const now = new Date();
  const currentMonthPrefix = now.toISOString().slice(0, 7);
  const currentYearPrefix = now.toISOString().slice(0, 4);

  const filteredPeriodData = useMemo(() => {
    const matchDate = (iso: string) => {
      if (periodMode === 'year') return iso.startsWith(currentYearPrefix);
      if (periodMode === 'month') return iso.startsWith(currentMonthPrefix);
      const diffDays = (Date.now() - new Date(iso).getTime()) / 86400000;
      return diffDays <= 30;
    };

    const periodSales = sales.filter((s) => matchDate(s.createdAt));
    const periodExpenses = expenses.filter((e) => matchDate(e.expenseDate || e.createdAt));
    const periodWriteOffs = writeOffs.filter((w) => matchDate(w.createdAt));

    let revenue = 0;
    let returns = 0;
    let cogs = 0;
    let posRevenue = 0;
    let onlineRevenue = 0;

    for (const s of periodSales) {
      if (s.type === 'return') {
        returns += s.totalAmount;
        cogs -= s.costTotal;
      } else {
        revenue += s.totalAmount;
        cogs += s.costTotal;
        if (s.channel === 'online') onlineRevenue += s.totalAmount;
        else posRevenue += s.totalAmount;
      }
    }

    const netRevenue = Math.round((revenue - returns) * 100) / 100;
    const grossProfit = Math.round((netRevenue - cogs) * 100) / 100;
    const writeOffLoss = Math.round(
      periodWriteOffs.reduce((acc, w) => acc + w.costValue, 0) * 100
    ) / 100;
    const operatingExpenseItems = periodExpenses.filter(
      (e) => e.category !== 'Списания и брак' && e.category !== 'Закупка товара'
    );
    const operatingExpenses =
      Math.round(operatingExpenseItems.reduce((acc, e) => acc + e.amount, 0) * 100) / 100;
    const excludedProcurementTotal =
      Math.round(
        periodExpenses
          .filter((e) => e.category === 'Закупка товара')
          .reduce((acc, e) => acc + e.amount, 0) * 100
      ) / 100;
    const netProfit =
      Math.round((grossProfit - writeOffLoss - operatingExpenses) * 100) / 100;

    // Daily aggregation (strictly aligned with P&L: excludes Закупка товара and Списания и брак)
    const dayMap = new Map<string, { revenue: number; cost: number; expenses: number }>();
    for (const s of periodSales) {
      const d = s.createdAt.slice(0, 10);
      const cur = dayMap.get(d) || { revenue: 0, cost: 0, expenses: 0 };
      if (s.type === 'return') {
        cur.revenue -= s.totalAmount;
        cur.cost -= s.costTotal;
      } else {
        cur.revenue += s.totalAmount;
        cur.cost += s.costTotal;
      }
      dayMap.set(d, cur);
    }
    for (const e of operatingExpenseItems) {
      const d = (e.expenseDate || e.createdAt).slice(0, 10);
      const cur = dayMap.get(d) || { revenue: 0, cost: 0, expenses: 0 };
      cur.expenses += e.amount;
      dayMap.set(d, cur);
    }
    for (const w of periodWriteOffs) {
      const d = w.createdAt.slice(0, 10);
      const cur = dayMap.get(d) || { revenue: 0, cost: 0, expenses: 0 };
      cur.expenses += w.costValue;
      dayMap.set(d, cur);
    }

    const dailyRows = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({
        date,
        revenue: Math.round(v.revenue * 100) / 100,
        expenses: Math.round(v.expenses * 100) / 100,
        netProfit: Math.round((v.revenue - v.cost - v.expenses) * 100) / 100,
      }));

    // Operating expenses by category (for P&L export & view)
    const expCatMap = new Map<string, number>();
    for (const e of operatingExpenseItems) {
      expCatMap.set(e.category, (expCatMap.get(e.category) || 0) + e.amount);
    }
    const expenseByCategory = Array.from(expCatMap.entries())
      .map(([category, amount]) => ({ category, amount: Math.round(amount * 100) / 100 }))
      .sort((a, b) => b.amount - a.amount);

    const periodLabel =
      periodMode === 'daily'
        ? 'Последние 30 дней'
        : periodMode === 'month'
        ? `Месяц (${currentMonthPrefix})`
        : `Год (${currentYearPrefix})`;

    const summary: FinancialReportSummary = {
      periodLabel,
      revenue: Math.round(revenue * 100) / 100,
      returns: Math.round(returns * 100) / 100,
      netRevenue,
      cogs: Math.round(cogs * 100) / 100,
      grossProfit,
      writeOffLoss,
      operatingExpenses,
      netProfit,
      dailyRows,
      expenseByCategory,
    };

    return { summary, posRevenue, onlineRevenue, periodSales, excludedProcurementTotal };
  }, [sales, expenses, writeOffs, periodMode, currentMonthPrefix, currentYearPrefix]);

  // ДДС (Cash Flow) & Supplier Debt Reconciliation
  const cashFlowData = useMemo(() => {
    const matchDate = (iso: string) => {
      if (periodMode === 'year') return iso.startsWith(currentYearPrefix);
      if (periodMode === 'month') return iso.startsWith(currentMonthPrefix);
      const diffDays = (Date.now() - new Date(iso).getTime()) / 86400000;
      return diffDays <= 30;
    };

    const periodSales = sales.filter((s) => matchDate(s.createdAt));
    const periodPayments = supplierPayments.filter((p) => matchDate(p.paymentDate || p.createdAt));
    const periodReturns = supplierReturns.filter((r) => matchDate(r.createdAt));
    const periodOpExpenses = expenses.filter(
      (e) =>
        matchDate(e.expenseDate || e.createdAt) &&
        e.category !== 'Закупка товара' &&
        e.category !== 'Списания и брак'
    );
    const periodShifts = shifts.filter((s) => matchDate(s.openedAt));

    let salesCashIn = 0;
    let salesCardIn = 0;
    let salesQrIn = 0;
    let customerReturnsOut = 0;
    for (const s of periodSales) {
      if (s.type === 'return') {
        customerReturnsOut += s.totalAmount;
      } else {
        salesCashIn += s.cashAmount;
        salesCardIn += s.cardAmount;
        salesQrIn += s.qrAmount;
      }
    }

    let supplierCashOut = 0;
    let supplierBankOut = 0;
    let supplierCardOut = 0;
    for (const p of periodPayments) {
      if (p.paymentMethod === 'cash') supplierCashOut += p.amount;
      else if (p.paymentMethod === 'bank_transfer') supplierBankOut += p.amount;
      else supplierCardOut += p.amount;
    }
    const supplierPaymentsTotal = supplierCashOut + supplierBankOut + supplierCardOut;

    const supplierCashRefundsIn = periodReturns
      .filter((r) => r.settlementType === 'cash_refund')
      .reduce((acc, r) => acc + r.totalRefund, 0);

    const operatingExpensesOut = periodOpExpenses.reduce((acc, e) => acc + e.amount, 0);

    let shiftCashIn = 0;
    let shiftCashOut = 0;
    for (const sh of periodShifts) {
      for (const m of sh.movements || []) {
        if (m.type === 'in') shiftCashIn += m.amount;
        else shiftCashOut += m.amount;
      }
    }

    const totalInflow =
      Math.round((salesCashIn + salesCardIn + salesQrIn + supplierCashRefundsIn + shiftCashIn) * 100) /
      100;
    const totalOutflow =
      Math.round(
        (supplierPaymentsTotal + operatingExpensesOut + customerReturnsOut + shiftCashOut) * 100
      ) / 100;
    const netCashFlow = Math.round((totalInflow - totalOutflow) * 100) / 100;

    // Live cash in open cash registers
    const openShifts = shifts.filter((s) => s.status === 'open');
    const cashInOpenRegisters =
      Math.round(openShifts.reduce((acc, s) => acc + s.expectedCash, 0) * 100) / 100;
    const lastClosedShift = shifts.find((s) => s.status === 'closed') || null;

    // All-time Supplier Debt Balances
    const debtMap = new Map<
      string,
      {
        supplierName: string;
        invoicedTotal: number;
        paidTotal: number;
        returnedOffsetTotal: number;
        balanceOwed: number;
      }
    >();
    const ensureRow = (name: string) => {
      const key = name.trim();
      let row = debtMap.get(key);
      if (!row) {
        row = {
          supplierName: key,
          invoicedTotal: 0,
          paidTotal: 0,
          returnedOffsetTotal: 0,
          balanceOwed: 0,
        };
        debtMap.set(key, row);
      }
      return row;
    };
    for (const inv of invoices) {
      if (!inv.supplierName.trim()) continue;
      ensureRow(inv.supplierName).invoicedTotal += inv.totalCost;
    }
    for (const p of supplierPayments) {
      if (!p.supplierName.trim()) continue;
      ensureRow(p.supplierName).paidTotal += p.amount;
    }
    for (const r of supplierReturns) {
      if (!r.supplierName.trim()) continue;
      if (r.settlementType === 'offset_debt') {
        ensureRow(r.supplierName).returnedOffsetTotal += r.totalRefund;
      }
    }
    const supplierDebts = Array.from(debtMap.values())
      .map((r) => ({
        ...r,
        invoicedTotal: Math.round(r.invoicedTotal * 100) / 100,
        paidTotal: Math.round(r.paidTotal * 100) / 100,
        returnedOffsetTotal: Math.round(r.returnedOffsetTotal * 100) / 100,
        balanceOwed:
          Math.round((r.invoicedTotal - r.paidTotal - r.returnedOffsetTotal) * 100) / 100,
      }))
      .sort((a, b) => b.balanceOwed - a.balanceOwed || a.supplierName.localeCompare(b.supplierName, 'ru'));

    const totalSupplierDebt =
      Math.round(
        supplierDebts.reduce((acc, r) => acc + (r.balanceOwed > 0 ? r.balanceOwed : 0), 0) * 100
      ) / 100;
    const totalSupplierAdvance =
      Math.round(
        supplierDebts.reduce((acc, r) => acc + (r.balanceOwed < 0 ? Math.abs(r.balanceOwed) : 0), 0) *
          100
      ) / 100;

    return {
      salesCashIn: Math.round(salesCashIn * 100) / 100,
      salesCardIn: Math.round(salesCardIn * 100) / 100,
      salesQrIn: Math.round(salesQrIn * 100) / 100,
      supplierCashRefundsIn: Math.round(supplierCashRefundsIn * 100) / 100,
      shiftCashIn: Math.round(shiftCashIn * 100) / 100,
      supplierCashOut: Math.round(supplierCashOut * 100) / 100,
      supplierBankOut: Math.round(supplierBankOut * 100) / 100,
      supplierCardOut: Math.round(supplierCardOut * 100) / 100,
      supplierPaymentsTotal: Math.round(supplierPaymentsTotal * 100) / 100,
      operatingExpensesOut: Math.round(operatingExpensesOut * 100) / 100,
      customerReturnsOut: Math.round(customerReturnsOut * 100) / 100,
      shiftCashOut: Math.round(shiftCashOut * 100) / 100,
      totalInflow,
      totalOutflow,
      netCashFlow,
      openShiftsCount: openShifts.length,
      cashInOpenRegisters,
      lastClosedShift,
      supplierDebts,
      totalSupplierDebt,
      totalSupplierAdvance,
      periodPayments,
    };
  }, [
    sales,
    supplierPayments,
    supplierReturns,
    expenses,
    shifts,
    invoices,
    periodMode,
    currentMonthPrefix,
    currentYearPrefix,
  ]);

  const maxDailyRev = useMemo(
    () =>
      Math.max(
        1,
        ...filteredPeriodData.summary.dailyRows.map((r) => Math.max(r.revenue, Math.abs(r.netProfit)))
      ),
    [filteredPeriodData.summary.dailyRows]
  );

  const filteredLogs = useMemo(() => {
    if (logFilter === 'all') return securityLogs;
    return securityLogs.filter((l) => l.action === logFilter);
  }, [securityLogs, logFilter]);

  const handleInviteStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!email || !inviteName.trim()) return;
    try {
      await setDoc(doc(db, 'staff_invites', email), {
        email,
        name: inviteName.trim(),
        role: inviteRole,
        twoFactorRequired: invite2FA,
        active: true,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      } satisfies StaffInvite);
      setInviteEmail('');
      setInviteName('');
      setNotice(`Доступ для ${email} (${inviteRole}) сохранен.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `staff_invites/${email}`);
    }
  };

  const handleRemoveInvite = async (email: string) => {
    try {
      await deleteDoc(doc(db, 'staff_invites', email));
      setNotice(`Доступ для ${email} удален.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, `staff_invites/${email}`);
    }
  };

  const handleUpdateUserRole = async (target: UserProfile, role: UserRole) => {
    try {
      await updateDoc(doc(db, 'users', target.uid), {
        role,
        updatedAt: new Date().toISOString(),
      });
      setNotice(`Роль сотрудника ${target.displayName} обновлена на ${role}.`);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${target.uid}`);
    }
  };

  const handleUpdateAdminPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newAdminPin.trim().length < 4) {
      setNotice('PIN-код должен содержать минимум 4 символа.');
      return;
    }
    try {
      const pinHash = await sha256Hex(newAdminPin.trim());
      await setDoc(doc(db, 'store_settings', 'pos_security'), {
        id: 'pos_security',
        adminPinHash: pinHash,
        updatedAt: new Date().toISOString(),
      } satisfies PosSecuritySettings);
      setNewAdminPin('');
      setNotice('PIN-код администратора сохранен в закрытом документе персонала (pos_security).');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'store_settings/pos_security');
    }
  };

  const handleUpdateQrMerchant = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = qrMerchantInput.trim();
    if (!trimmed) {
      setNotice('Укажите идентификатор или реквизиты для QR-оплаты.');
      return;
    }
    try {
      await setDoc(doc(db, 'store_settings', 'public_store'), {
        id: 'public_store',
        storeName: storeSettings?.storeName || 'FreshMart Pro',
        qrMerchantId: trimmed,
        updatedAt: new Date().toISOString(),
      } satisfies StoreSettings);
      setNotice('Реквизиты QR-оплаты обновлены для кассы и онлайн-витрины.');
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'store_settings/public_store');
    }
  };

  const { summary, posRevenue, onlineRevenue, excludedProcurementTotal } = filteredPeriodData;

  return (
    <div className="space-y-5">
      {/* Owner Exclusive Header */}
      <div className="bg-slate-900 text-white rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
            <Lock className="w-3.5 h-3.5" />
            <span>Эксклюзивная панель руководителя · Финансы и Безопасность скрыты от админов и кассиров</span>
          </div>
          <h2 className="text-xl font-bold mt-1">Финансовый контроль (P&L) и Аудит магазина</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => exportFinancialPDF(summary)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-500 transition-colors"
          >
            <FileText className="w-3.5 h-3.5" />
            Скачать PDF
          </button>
          <button
            type="button"
            onClick={() => exportFinancialCSV(summary)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 text-white border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Скачать CSV
          </button>
          <button
            type="button"
            onClick={() => exportFullFinancialExcel(sales, expenses, writeOffs, products)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-slate-800 text-white border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" />
            Полный Excel
          </button>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div className="bg-white border border-slate-200 rounded-xl p-1.5 flex items-center gap-1 overflow-x-auto">
        {(
          [
            ['pnl', 'P&L (Прибыль)', TrendingUp],
            ['cashflow', 'ДДС (Движение денег)', Wallet],
            ['security', `Журнал безопасности (${securityLogs.length})`, ShieldAlert],
            ['shifts', `Смены и Z-отчеты (${shifts.length})`, Clock],
            ['staff', 'Персонал, 2FA и PIN-код', Users],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-3.5 py-2 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 inline-flex items-center gap-1.5 transition-colors ${
              tab === id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {notice && (
        <div className="px-4 py-2.5 rounded-lg border bg-emerald-50 border-emerald-200 text-emerald-900 text-sm flex items-center justify-between">
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">
            Скрыть
          </button>
        </div>
      )}

      {/* TAB 1: P&L & Net Profit */}
      {tab === 'pnl' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex bg-white border border-slate-200 rounded-lg p-1 gap-1">
              {(
                [
                  ['daily', 'По дням (30 дн.)'],
                  ['month', 'За месяц'],
                  ['year', 'За год'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPeriodMode(mode)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    periodMode === mode
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500">
              POS-касса: <span className="font-mono font-semibold text-slate-900">{formatMoney(posRevenue)}</span> ·
              Онлайн-магазин: <span className="font-mono font-semibold text-slate-900">{formatMoney(onlineRevenue)}</span>
            </div>
          </div>

          {/* 4 KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Чистая выручка ({summary.periodLabel})</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1">
                {formatMoney(summary.netRevenue)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                Возвраты: {formatMoney(summary.returns)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Валовая прибыль</div>
              <div className="font-mono text-2xl font-bold text-slate-900 mt-1">
                {formatMoney(summary.grossProfit)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                Себестоимость: {formatMoney(summary.cogs)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Расходы и списания</div>
              <div className="font-mono text-2xl font-bold text-amber-700 mt-1">
                {formatMoney(summary.operatingExpenses + summary.writeOffLoss)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                Брак/просрочка: {formatMoney(summary.writeOffLoss)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Чистая прибыль</div>
              <div
                className={`font-mono text-2xl font-bold mt-1 ${
                  summary.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {formatMoney(summary.netProfit)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {summary.netRevenue > 0
                  ? `Рентабельность: ${Math.round((summary.netProfit / summary.netRevenue) * 100)}%`
                  : 'Нет продаж за период'}
              </div>
            </div>
          </div>

          {/* Daily Sales & Profit Visualization + P&L Table */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-900">
                  График выручки и чистой прибыли по дням
                </h3>
                <span className="text-xs text-slate-500">
                  {summary.dailyRows.length} дн.
                </span>
              </div>

              {summary.dailyRows.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">
                  Нет данных за выбранный период.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-80 overflow-y-auto pr-1">
                  {summary.dailyRows.map((row) => (
                    <div key={row.date} className="space-y-1 text-xs">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-slate-600">{row.date}</span>
                        <div className="font-mono space-x-3">
                          <span className="text-slate-900 font-semibold">
                            Выручка: {formatMoney(row.revenue)}
                          </span>
                          <span
                            className={`font-bold ${
                              row.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                            }`}
                          >
                            Прибыль: {formatMoney(row.netProfit)}
                          </span>
                        </div>
                      </div>
                      <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden flex">
                        <div
                          className="h-full bg-slate-900"
                          style={{
                            width: `${Math.min(100, Math.round((row.revenue / maxDailyRev) * 100))}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h3 className="text-base font-semibold text-slate-900">
                Сводный отчет P&L ({summary.periodLabel})
              </h3>
              <div className="divide-y divide-slate-100 text-sm">
                <div className="py-2 flex justify-between">
                  <span className="text-slate-600">Валовая выручка</span>
                  <span className="font-mono font-medium">{formatMoney(summary.revenue)}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-600">Возвраты покупателей</span>
                  <span className="font-mono text-red-700">-{formatMoney(summary.returns)}</span>
                </div>
                <div className="py-2 flex justify-between font-semibold">
                  <span>Чистая выручка</span>
                  <span className="font-mono">{formatMoney(summary.netRevenue)}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-600">Себестоимость продаж</span>
                  <span className="font-mono">-{formatMoney(summary.cogs)}</span>
                </div>
                <div className="py-2 flex justify-between font-semibold">
                  <span>Валовая прибыль</span>
                  <span className="font-mono">{formatMoney(summary.grossProfit)}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-600">Списания и брак</span>
                  <span className="font-mono text-amber-700">-{formatMoney(summary.writeOffLoss)}</span>
                </div>
                <div className="py-2 flex justify-between">
                  <span className="text-slate-600">Операционные расходы (без закупки)</span>
                  <span className="font-mono text-amber-700">
                    -{formatMoney(summary.operatingExpenses)}
                  </span>
                </div>
                <div className="pt-3 flex justify-between text-base font-bold">
                  <span>ЧИСТАЯ ПРИБЫЛЬ</span>
                  <span
                    className={`font-mono ${
                      summary.netProfit >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {formatMoney(summary.netProfit)}
                  </span>
                </div>
              </div>
              <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 leading-relaxed">
                Статья «Закупка товара» ({formatMoney(excludedProcurementTotal)}) исключена из операционных расходов P&L, так как стоимость проданного товара уже учтена в себестоимости. Реальные оплаты поставщикам отражены на вкладке «ДДС (Движение денег)».
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: ДДС (Cash Flow, Cash in Register, Supplier Debts) */}
      {tab === 'cashflow' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex bg-white border border-slate-200 rounded-lg p-1 gap-1">
              {(
                [
                  ['daily', 'По дням (30 дн.)'],
                  ['month', 'За месяц'],
                  ['year', 'За год'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPeriodMode(mode)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    periodMode === mode
                      ? 'bg-emerald-600 text-white'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="text-xs text-slate-500">
              Реальные поступления и выплаты денежных средств ({summary.periodLabel})
            </div>
          </div>

          {/* 4 Cash Flow KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Поступления денег</span>
                <ArrowUpRight className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="font-mono text-2xl font-bold text-emerald-700 mt-1 tabular-nums">
                {formatMoney(cashFlowData.totalInflow)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                Нал: {formatMoney(cashFlowData.salesCashIn)} · Безнал/QR:{' '}
                {formatMoney(cashFlowData.salesCardIn + cashFlowData.salesQrIn)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Реальные выплаты</span>
                <ArrowDownRight className="w-4 h-4 text-amber-600" />
              </div>
              <div className="font-mono text-2xl font-bold text-amber-700 mt-1 tabular-nums">
                {formatMoney(cashFlowData.totalOutflow)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                Поставщикам: {formatMoney(cashFlowData.supplierPaymentsTotal)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Чистый денежный поток (ДДС)</div>
              <div
                className={`font-mono text-2xl font-bold mt-1 tabular-nums ${
                  cashFlowData.netCashFlow >= 0 ? 'text-emerald-700' : 'text-red-700'
                }`}
              >
                {cashFlowData.netCashFlow >= 0 ? '+' : ''}
                {formatMoney(cashFlowData.netCashFlow)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Наличные в кассе сейчас:{' '}
                <span className="font-mono font-semibold text-slate-900">
                  {formatMoney(cashFlowData.cashInOpenRegisters)}
                </span>
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>Остаток долга поставщикам</span>
                <Building2 className="w-4 h-4 text-slate-400" />
              </div>
              <div
                className={`font-mono text-2xl font-bold mt-1 tabular-nums ${
                  cashFlowData.totalSupplierDebt > 0 ? 'text-red-700' : 'text-emerald-700'
                }`}
              >
                {formatMoney(cashFlowData.totalSupplierDebt)}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono">
                {cashFlowData.openShiftsCount > 0
                  ? `Открыто смен: ${cashFlowData.openShiftsCount}`
                  : cashFlowData.lastClosedShift
                  ? `Посл. Z-отчет: ${formatMoney(cashFlowData.lastClosedShift.actualCash || 0)}`
                  : 'Нет открытых смен'}
              </div>
            </div>
          </div>

          {/* Cash Flow Structure + Supplier Debt Table */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <h3 className="text-base font-semibold text-slate-900">
                Структура движения денег ({summary.periodLabel})
              </h3>

              <div className="space-y-3 text-sm">
                <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                  Поступления (+)
                </div>
                <div className="divide-y divide-slate-100">
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Выручка наличными</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoney(cashFlowData.salesCashIn)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Оплаты банковскими картами</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoney(cashFlowData.salesCardIn)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Оплаты по QR (касса + подтвержденный онлайн)</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoney(cashFlowData.salesQrIn)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Возвраты денег от поставщиков</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoney(cashFlowData.supplierCashRefundsIn)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Внесения наличных в кассу</span>
                    <span className="font-mono font-medium tabular-nums">
                      {formatMoney(cashFlowData.shiftCashIn)}
                    </span>
                  </div>
                </div>

                <div className="text-xs font-semibold uppercase tracking-wide text-amber-700 pt-2">
                  Выплаты (−)
                </div>
                <div className="divide-y divide-slate-100">
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Оплаты поставщикам (нал)</span>
                    <span className="font-mono text-amber-700 tabular-nums">
                      -{formatMoney(cashFlowData.supplierCashOut)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Оплаты поставщикам (безнал / карта)</span>
                    <span className="font-mono text-amber-700 tabular-nums">
                      -{formatMoney(cashFlowData.supplierBankOut + cashFlowData.supplierCardOut)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Операционные расходы (аренда, ЗП, логистика)</span>
                    <span className="font-mono text-amber-700 tabular-nums">
                      -{formatMoney(cashFlowData.operatingExpensesOut)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Возвраты покупателям</span>
                    <span className="font-mono text-red-700 tabular-nums">
                      -{formatMoney(cashFlowData.customerReturnsOut)}
                    </span>
                  </div>
                  <div className="py-1.5 flex justify-between">
                    <span className="text-slate-600">Инкассация и изъятия из кассы</span>
                    <span className="font-mono text-amber-700 tabular-nums">
                      -{formatMoney(cashFlowData.shiftCashOut)}
                    </span>
                  </div>
                </div>

                <div className="pt-3 border-t border-slate-200 flex justify-between text-base font-bold">
                  <span>ЧИСТЫЙ ПОТОК ДДС</span>
                  <span
                    className={`font-mono tabular-nums ${
                      cashFlowData.netCashFlow >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {cashFlowData.netCashFlow >= 0 ? '+' : ''}
                    {formatMoney(cashFlowData.netCashFlow)}
                  </span>
                </div>
              </div>
            </div>

            <div className="lg:col-span-7 space-y-5">
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-900">
                    Взаиморасчеты и остаток долгов поставщикам
                  </h3>
                  {cashFlowData.totalSupplierAdvance > 0 && (
                    <span className="text-xs font-mono text-emerald-700">
                      Переплата: {formatMoney(cashFlowData.totalSupplierAdvance)}
                    </span>
                  )}
                </div>

                {cashFlowData.supplierDebts.length === 0 ? (
                  <div className="py-8 text-center text-sm text-slate-500">
                    Нет зарегистрированных накладных или оплат поставщикам.
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-xs">
                      <thead>
                        <tr className="border-b border-slate-200 text-slate-500">
                          <th className="py-2 pr-3">Поставщик</th>
                          <th className="py-2 px-3 text-right">Закуплено</th>
                          <th className="py-2 px-3 text-right">Оплачено</th>
                          <th className="py-2 px-3 text-right">Зачет возвратов</th>
                          <th className="py-2 pl-3 text-right">Остаток долга</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {cashFlowData.supplierDebts.map((row) => (
                          <tr key={row.supplierName} className="hover:bg-slate-50">
                            <td className="py-2.5 pr-3 font-medium text-slate-900">
                              {row.supplierName}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-right tabular-nums text-slate-700">
                              {formatMoney(row.invoicedTotal)}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-right tabular-nums text-emerald-700">
                              {formatMoney(row.paidTotal)}
                            </td>
                            <td className="py-2.5 px-3 font-mono text-right tabular-nums text-slate-600">
                              {formatMoney(row.returnedOffsetTotal)}
                            </td>
                            <td
                              className={`py-2.5 pl-3 font-mono font-bold text-right tabular-nums ${
                                row.balanceOwed > 0
                                  ? 'text-red-700'
                                  : row.balanceOwed < 0
                                  ? 'text-emerald-700'
                                  : 'text-slate-500'
                              }`}
                            >
                              {formatMoney(row.balanceOwed)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-sm font-semibold text-slate-900">
                  Реальные оплаты поставщикам за период ({cashFlowData.periodPayments.length})
                </h3>
                {cashFlowData.periodPayments.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-500">
                    За выбранный период оплат поставщикам не проводилось.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto text-xs">
                    {cashFlowData.periodPayments.map((p) => (
                      <div key={p.id} className="py-2.5 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium text-slate-900 truncate">
                            {p.supplierName}
                            {p.invoiceNumber ? ` · Накл. №${p.invoiceNumber}` : ''}
                          </div>
                          <div className="text-slate-500">
                            {p.paymentDate} · {PAYMENT_METHOD_LABELS[p.paymentMethod]} ·{' '}
                            {p.createdByName}
                          </div>
                        </div>
                        <div className="font-mono font-bold text-amber-700 shrink-0 tabular-nums">
                          -{formatMoney(p.amount)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: Hidden Security Audit Log */}
      {tab === 'security' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <AlertOctagon className="w-5 h-5 text-red-600 shrink-0 mt-0.5" />
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Скрытый журнал безопасности (только для руководителя)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Неизменяемый лог удалений из открытого чека, отмен чеков, возвратов, корректировок остатков, изменения цен и изъятия наличных. Скрыт от кассиров и администраторов.
                </p>
              </div>
            </div>
            <select
              value={logFilter}
              onChange={(e) => setLogFilter(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="all">Все события ({securityLogs.length})</option>
              {Object.entries(ACTION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>

          {filteredLogs.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              Подозрительных или корректирующих событий не зафиксировано.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 pr-3">Время</th>
                    <th className="py-2 px-3">Сотрудник</th>
                    <th className="py-2 px-3">Событие</th>
                    <th className="py-2 px-3">Детали</th>
                    <th className="py-2 pl-3 text-right">Сумма влияния</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-3 font-mono text-xs text-slate-500 whitespace-nowrap">
                        {log.createdAt.slice(0, 19).replace('T', ' ')}
                      </td>
                      <td className="py-2.5 px-3 text-xs">
                        <div className="font-medium text-slate-900">{log.actorName}</div>
                        <div className="text-slate-500">{log.actorRole}</div>
                      </td>
                      <td className="py-2.5 px-3 text-xs font-semibold text-red-700">
                        {ACTION_LABELS[log.action]}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-700">
                        <div>{log.details}</div>
                        {log.authorizedBy && (
                          <div className="text-emerald-700 mt-0.5">{log.authorizedBy}</div>
                        )}
                      </td>
                      <td className="py-2.5 pl-3 font-mono text-xs font-semibold text-right text-slate-900">
                        {formatMoney(log.amountImpact)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 3: Cashier Shifts & Z-Reports */}
      {tab === 'shifts' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <h3 className="text-base font-semibold text-slate-900">
            Контроль кассовых смен и Z-отчетов
          </h3>
          {shifts.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              Смены еще не открывались.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 pr-3">Кассир</th>
                    <th className="py-2 px-3">Статус</th>
                    <th className="py-2 px-3 text-right">Начало</th>
                    <th className="py-2 px-3 text-right">Наличные продажи</th>
                    <th className="py-2 px-3 text-right">Карта / QR</th>
                    <th className="py-2 px-3 text-right">Ожидалось</th>
                    <th className="py-2 pl-3 text-right">Факт / Расхождение</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {shifts.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900">{s.cashierName}</div>
                        <div className="text-xs font-mono text-slate-500">
                          {s.openedAt.slice(0, 16).replace('T', ' ')}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-xs font-semibold">
                        {s.status === 'open' ? (
                          <span className="text-emerald-700">Открыта</span>
                        ) : (
                          <span className="text-slate-500">Закрыта (Z)</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-right">{formatMoney(s.openingCash)}</td>
                      <td className="py-2.5 px-3 font-mono text-right">
                        {formatMoney(s.cashSalesTotal)}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-right">
                        {formatMoney(s.cardSalesTotal + s.qrSalesTotal)}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-right">
                        {formatMoney(s.expectedCash)}
                      </td>
                      <td className="py-2.5 pl-3 font-mono text-right">
                        {s.status === 'closed' ? (
                          <div>
                            <div>{formatMoney(s.actualCash || 0)}</div>
                            <div
                              className={`text-xs ${
                                (s.discrepancy || 0) === 0 ? 'text-emerald-700' : 'text-red-700'
                              }`}
                            >
                              {(s.discrepancy || 0) >= 0 ? '+' : ''}
                              {formatMoney(s.discrepancy || 0)}
                            </div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB 4: Staff, RBAC, 2FA & Admin PIN */}
      {tab === 'staff' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 space-y-5">
            <form
              onSubmit={handleInviteStaff}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center gap-2">
                <UserPlus className="w-4 h-4 text-emerald-700" />
                <h3 className="text-base font-semibold text-slate-900">
                  Добавить сотрудника и выдать права
                </h3>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Google Email сотрудника
                </label>
                <input
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  placeholder="cashier@example.com"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Имя</label>
                  <input
                    type="text"
                    required
                    value={inviteName}
                    onChange={(e) => setInviteName(e.target.value)}
                    placeholder="Алина К."
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Роль</label>
                  <select
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as Exclude<UserRole, 'customer'>)}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="cashier">Кассир (только POS)</option>
                    <option value="admin">Администратор (склад/заказы)</option>
                    <option value="requester">Заявщик (заявки на закупку)</option>
                    <option value="owner">Руководитель (полный)</option>
                  </select>
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700">
                <input
                  type="checkbox"
                  checked={invite2FA}
                  onChange={(e) => setInvite2FA(e.target.checked)}
                />
                Обязательная двухфакторная аутентификация (2FA)
              </label>
              <button
                type="submit"
                className="w-full py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
              >
                Назначить доступ
              </button>
            </form>

            <form
              onSubmit={handleUpdateAdminPin}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-slate-700" />
                <h3 className="text-base font-semibold text-slate-900">
                  PIN-код администратора для возвратов на кассе
                </h3>
              </div>
              <p className="text-xs text-slate-500">
                Кассир обязан ввести этот PIN для подтверждения возврата товара покупателю (по умолчанию 1234). Хэш хранится в закрытом документе <span className="font-mono">store_settings/pos_security</span>, недоступном покупателям.
              </p>
              <div className="flex gap-2">
                <input
                  type="password"
                  inputMode="numeric"
                  value={newAdminPin}
                  onChange={(e) => setNewAdminPin(e.target.value)}
                  placeholder="Новый PIN (мин. 4 цифры)"
                  className="flex-1 px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                >
                  Сохранить PIN
                </button>
              </div>
            </form>

            <form
              onSubmit={handleUpdateQrMerchant}
              className="bg-white border border-slate-200 rounded-xl p-5 space-y-3"
            >
              <div className="flex items-center gap-2">
                <QrCode className="w-4 h-4 text-emerald-700" />
                <h3 className="text-base font-semibold text-slate-900">
                  Реквизиты QR-оплаты (Касса и Онлайн)
                </h3>
              </div>
              <p className="text-xs text-slate-500">
                Идентификатор получателя или счета, который кодируется в QR-код на кассе и в разделе онлайн-оплаты.
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={qrMerchantInput}
                  onChange={(e) => setQrMerchantInput(e.target.value)}
                  placeholder="FRESHMART-SBP-001"
                  className="flex-1 px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
                >
                  Сохранить QR ID
                </button>
              </div>
            </form>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Зарегистрированные аккаунты и права доступа
              </h3>
              <div className="mt-3 divide-y divide-slate-100">
                {staffUsers.map((u) => (
                  <div key={u.uid} className="py-3 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium text-slate-900 flex items-center gap-2">
                        {u.displayName}
                        {u.twoFactorEnabled && (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                        )}
                      </div>
                      <div className="text-xs text-slate-500">{u.email}</div>
                    </div>
                    <select
                      value={u.role}
                      disabled={u.uid === user.uid}
                      onChange={(e) => handleUpdateUserRole(u, e.target.value as UserRole)}
                      className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white disabled:opacity-60"
                    >
                      <option value="owner">Руководитель</option>
                      <option value="admin">Администратор</option>
                      <option value="cashier">Кассир</option>
                      <option value="requester">Заявщик</option>
                      <option value="customer">Покупатель</option>
                    </select>
                  </div>
                ))}
              </div>
            </div>

            {staffInvites.length > 0 && (
              <div className="border-t border-slate-200 pt-4">
                <h4 className="text-xs font-semibold text-slate-700 mb-2">
                  Ожидающие приглашения сотрудников
                </h4>
                <div className="space-y-2">
                  {staffInvites.map((inv) => (
                    <div
                      key={inv.email}
                      className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-xs"
                    >
                      <div>
                        <span className="font-medium text-slate-900">{inv.name}</span> · {inv.email} ·{' '}
                        <span className="font-semibold text-emerald-700">{inv.role}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveInvite(inv.email)}
                        className="text-red-600 hover:underline"
                      >
                        Отозвать
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
