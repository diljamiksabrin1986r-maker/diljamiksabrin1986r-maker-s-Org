import React, { useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Banknote,
  Calculator,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Eye,
  FileSpreadsheet,
  PackagePlus,
  Plus,
  RefreshCw,
  RotateCcw,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Trash2,
  Truck,
  Upload,
  XCircle,
  CalendarClock,
  Receipt,
} from 'lucide-react';
import { doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { auth, createSafeId, db, handleFirestoreError, OperationType } from '../firebase';
import type {
  Expense,
  ExpenseCategory,
  InventoryAudit,
  InvoiceItemInput,
  OnlineOrder,
  Product,
  ProductUnit,
  PurchaseRequest,
  PurchaseRequestStatus,
  Sale,
  SecurityLogAction,
  SupplierInvoice,
  SupplierPayment,
  SupplierPaymentMethod,
  SupplierReturn,
  SupplierReturnReason,
  SupplierReturnSettlement,
  UserProfile,
  WriteOff,
  WriteOffReason,
} from '../types';
import {
  downloadExcelImportTemplate,
  exportProductsToExcel,
  formatMoney,
  parseNomenclatureExcel,
} from '../utils/exportReports';
import { getCategoryImage } from '../utils/seedData';

interface AdminWarehouseViewProps {
  user: UserProfile;
  products: Product[];
  writeOffs: WriteOff[];
  invoices: SupplierInvoice[];
  inventories: InventoryAudit[];
  purchaseRequests: PurchaseRequest[];
  expenses: Expense[];
  onlineOrders: OnlineOrder[];
  supplierPayments: SupplierPayment[];
  supplierReturns: SupplierReturn[];
}

type AdminSection =
  | 'catalog'
  | 'procurement'
  | 'margin_calc'
  | 'invoice_ai'
  | 'suppliers'
  | 'expiry'
  | 'writeoffs'
  | 'inventory'
  | 'requests'
  | 'expenses'
  | 'online_orders';

interface ProcurementLineItem {
  productId?: string;
  name: string;
  barcode: string;
  category: string;
  unit: ProductUnit;
  quantity: number;
  costPrice: number;
  retailPrice: number;
  expiryDate: string;
  isNew: boolean;
}

const CATEGORIES = [
  'Выпечка',
  'Молочные',
  'Овощи и фрукты',
  'Бакалея',
  'Напитки',
  'Детские товары',
  'Кондитерка',
  'Хозтовары',
];

const EXPENSE_CATEGORIES: ExpenseCategory[] = [
  'Закупка товара',
  'Аренда',
  'Зарплата',
  'Коммунальные',
  'Логистика',
  'Списания и брак',
  'Прочее',
];

export const AdminWarehouseView: React.FC<AdminWarehouseViewProps> = ({
  user,
  products,
  writeOffs,
  invoices,
  inventories,
  purchaseRequests,
  expenses,
  onlineOrders,
  supplierPayments,
  supplierReturns,
}) => {
  const [section, setSection] = useState<AdminSection>('catalog');
  const [notice, setNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Manual Product Form Modal
  const [productModalOpen, setProductModalOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [formName, setFormName] = useState('');
  const [formBarcode, setFormBarcode] = useState('');
  const [formPlu, setFormPlu] = useState('');
  const [formCategory, setFormCategory] = useState('Бакалея');
  const [formUnit, setFormUnit] = useState<ProductUnit>('шт');
  const [formWeighted, setFormWeighted] = useState(false);
  const [formQuick, setFormQuick] = useState(false);
  const [formCost, setFormCost] = useState('');
  const [formRetail, setFormRetail] = useState('');
  const [formStock, setFormStock] = useState('');
  const [formMinStock, setFormMinStock] = useState('10');
  const [formExpiry, setFormExpiry] = useState('');
  const [formSupplier, setFormSupplier] = useState('');
  const [formOnline, setFormOnline] = useState(true);

  // Excel import ref
  const excelInputRef = useRef<HTMLInputElement>(null);

  // AI Invoice Parsing state
  const [invoiceSupplier, setInvoiceSupplier] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceItems, setInvoiceItems] = useState<InvoiceItemInput[]>([]);
  const [parsingPhoto, setParsingPhoto] = useState(false);
  const [invoicePreviewUrl, setInvoicePreviewUrl] = useState('');
  const invoicePhotoRef = useRef<HTMLInputElement>(null);

  // Write-off form
  const [woProductId, setWoProductId] = useState('');
  const [woQty, setWoQty] = useState('1');
  const [woReason, setWoReason] = useState<WriteOffReason>('expired');
  const [woNotes, setWoNotes] = useState('');

  // Shelf Inventory Audit
  const [auditCategory, setAuditCategory] = useState('Молочные');
  const [auditCounts, setAuditCounts] = useState<Record<string, string>>({});

  // Expense form
  const [expCategory, setExpCategory] = useState<ExpenseCategory>('Закупка товара');
  const [expAmount, setExpAmount] = useState('');
  const [expDesc, setExpDesc] = useState('');
  const [expDate, setExpDate] = useState(new Date().toISOString().slice(0, 10));

  // Margin Calculator state
  const [calcProductId, setCalcProductId] = useState<string>('custom');
  const [calcCost, setCalcCost] = useState<string>('100');
  const [calcMarkupPercent, setCalcMarkupPercent] = useState<string>('30');
  const [calcRounding, setCalcRounding] = useState<'none' | 'ceil' | 'round' | 'nine'>('none');
  const [applyingCalcPrice, setApplyingCalcPrice] = useState(false);

  // Inline markup helper for Add/Edit Product Modal
  const [formMarkup, setFormMarkup] = useState<string>('');

  // Supplier Payments & Returns state
  const [supplierSubMode, setSupplierSubMode] = useState<'payments' | 'returns'>('payments');
  const [supplierFilter, setSupplierFilter] = useState<string>('');
  const [paySupplierName, setPaySupplierName] = useState<string>('');
  const [payInvoiceId, setPayInvoiceId] = useState<string>('');
  const [payAmount, setPayAmount] = useState<string>('');
  const [payMethod, setPayMethod] = useState<SupplierPaymentMethod>('bank_transfer');
  const [payDate, setPayDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [payNotes, setPayNotes] = useState<string>('');
  const [paySyncExpense, setPaySyncExpense] = useState<boolean>(true);
  const [savingSupplierOp, setSavingSupplierOp] = useState<boolean>(false);

  const [retProductId, setRetProductId] = useState<string>('');
  const [retSupplierName, setRetSupplierName] = useState<string>('');
  const [retQty, setRetQty] = useState<string>('1');
  const [retUnitCost, setRetUnitCost] = useState<string>('');
  const [retReason, setRetReason] = useState<SupplierReturnReason>('defect');
  const [retSettlement, setRetSettlement] = useState<SupplierReturnSettlement>('offset_debt');
  const [retInvoiceNum, setRetInvoiceNum] = useState<string>('');
  const [retNotes, setRetNotes] = useState<string>('');

  // Product Procurement ("Закуп товара") state
  const [procSupplier, setProcSupplier] = useState<string>('');
  const [procInvoiceNumber, setProcInvoiceNumber] = useState<string>('');
  const [procDate, setProcDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [procPaymentMode, setProcPaymentMode] = useState<
    'credit' | 'cash' | 'bank_transfer' | 'card'
  >('credit');
  const [procRecordExpense, setProcRecordExpense] = useState<boolean>(true);
  const [procSelectedProdId, setProcSelectedProdId] = useState<string>('');
  const [procItems, setProcItems] = useState<ProcurementLineItem[]>([]);
  const [procDraftQuery, setProcDraftQuery] = useState<string>('');
  const [procDraftMatchedId, setProcDraftMatchedId] = useState<string>('');
  const [procDraftBarcode, setProcDraftBarcode] = useState<string>('');
  const [procDraftCategory, setProcDraftCategory] = useState<string>('Бакалея');
  const [procDraftUnit, setProcDraftUnit] = useState<ProductUnit>('шт');
  const [procDraftQty, setProcDraftQty] = useState<string>('1');
  const [procDraftCost, setProcDraftCost] = useState<string>('');
  const [procDraftMarkup, setProcDraftMarkup] = useState<string>('25');
  const [procDraftRetail, setProcDraftRetail] = useState<string>('');
  const [procDraftExpiry, setProcDraftExpiry] = useState<string>('');
  const [savingDraftCatalog, setSavingDraftCatalog] = useState<boolean>(false);
  const [procHistorySearch, setProcHistorySearch] = useState<string>('');
  const [procHistoryFilter, setProcHistoryFilter] = useState<'all' | 'manual' | 'ai'>('all');
  const [savingProcurement, setSavingProcurement] = useState<boolean>(false);

  // Online QR Payment Verification state
  const [verifyingOrderId, setVerifyingOrderId] = useState<string | null>(null);
  const [previewReceiptOrder, setPreviewReceiptOrder] = useState<OnlineOrder | null>(null);

  const logHiddenAudit = async (action: SecurityLogAction, details: string, amountImpact: number) => {
    try {
      const logId = createSafeId('sec');
      await setDoc(doc(db, 'security_logs', logId), {
        id: logId,
        action,
        actorId: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        details,
        amountImpact,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Hidden audit log
    }
  };

  // Expiry 15-day alert computation
  const expiryAlerts = useMemo(() => {
    const todayMs = new Date().setHours(0, 0, 0, 0);
    return products
      .filter((p) => Boolean(p.expiryDate) && p.stock > 0)
      .map((p) => {
        const expMs = new Date(p.expiryDate!).setHours(0, 0, 0, 0);
        const daysLeft = Math.ceil((expMs - todayMs) / 86400000);
        return { product: p, daysLeft };
      })
      .filter((x) => x.daysLeft <= 15)
      .sort((a, b) => a.daysLeft - b.daysLeft);
  }, [products]);

  const lowStockProducts = useMemo(
    () => products.filter((p) => p.stock <= p.minStock),
    [products]
  );

  const pendingRequestsCount = useMemo(
    () => purchaseRequests.filter((r) => r.status === 'new' || r.status === 'reviewing').length,
    [purchaseRequests]
  );

  const pendingOnlineOrders = useMemo(
    () =>
      onlineOrders.filter(
        (o) =>
          o.paymentStatus === 'awaiting_verification' ||
          o.orderStatus === 'new' ||
          o.orderStatus === 'packing'
      ).length,
    [onlineOrders]
  );

  const openProductForm = (prod?: Product) => {
    if (prod) {
      setEditingProduct(prod);
      setFormName(prod.name);
      setFormBarcode(prod.barcode || '');
      setFormPlu(prod.pluCode || '');
      setFormCategory(prod.category);
      setFormUnit(prod.unit);
      setFormWeighted(prod.isWeighted);
      setFormQuick(prod.isQuickItem);
      setFormCost(String(prod.costPrice));
      setFormRetail(String(prod.retailPrice));
      if (prod.costPrice > 0 && prod.retailPrice >= prod.costPrice) {
        const pct = ((prod.retailPrice - prod.costPrice) / prod.costPrice) * 100;
        setFormMarkup(String(Math.round(pct * 10) / 10));
      } else {
        setFormMarkup('');
      }
      setFormStock(String(prod.stock));
      setFormMinStock(String(prod.minStock));
      setFormExpiry(prod.expiryDate || '');
      setFormSupplier(prod.supplierName || '');
      setFormOnline(prod.activeOnline);
    } else {
      setEditingProduct(null);
      setFormName('');
      setFormBarcode('');
      setFormPlu('');
      setFormCategory('Бакалея');
      setFormUnit('шт');
      setFormWeighted(false);
      setFormQuick(false);
      setFormCost('');
      setFormRetail('');
      setFormMarkup('');
      setFormStock('0');
      setFormMinStock('10');
      setFormExpiry('');
      setFormSupplier('');
      setFormOnline(true);
    }
    setProductModalOpen(true);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = editingProduct ? editingProduct.id : createSafeId('prod');
    const retailPrice = Math.max(0, Number(formRetail) || 0);
    const costPrice = Math.max(0, Number(formCost) || 0);
    const stock = Math.max(0, Number(formStock) || 0);
    const minStock = Math.max(0, Number(formMinStock) || 0);

    const payload: Product = {
      id,
      name: formName.trim(),
      barcode: formBarcode.trim(),
      pluCode: formPlu.trim(),
      category: formCategory,
      unit: formUnit,
      isWeighted: formWeighted,
      isQuickItem: formQuick,
      retailPrice,
      costPrice,
      stock,
      minStock,
      expiryDate: formExpiry.trim(),
      supplierName: formSupplier.trim(),
      imageUrl: editingProduct?.imageUrl || getCategoryImage(formCategory),
      activeOnline: formOnline,
      updatedAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(db, 'products', id), payload);
      if (editingProduct) {
        if (editingProduct.retailPrice !== retailPrice) {
          await logHiddenAudit(
            'price_change',
            `Изменена цена: ${payload.name} (${formatMoney(editingProduct.retailPrice)} -> ${formatMoney(retailPrice)})`,
            retailPrice - editingProduct.retailPrice
          );
        }
        if (editingProduct.stock !== stock) {
          await logHiddenAudit(
            'stock_adjustment',
            `Ручная правка остатка: ${payload.name} (${editingProduct.stock} -> ${stock} ${payload.unit})`,
            (stock - editingProduct.stock) * costPrice
          );
        }
      }
      setProductModalOpen(false);
      setNotice({ type: 'ok', text: `Товар «${payload.name}» сохранен.` });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `products/${id}`);
    }
  };

  const handleExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const items = await parseNomenclatureExcel(file);
      if (items.length === 0) {
        setNotice({ type: 'err', text: 'В файле Excel не найдено строк с товарами.' });
        return;
      }
      const batch = writeBatch(db);
      for (const item of items) {
        const existing = products.find(
          (p) =>
            (item.barcode && p.barcode === item.barcode) ||
            p.name.toLowerCase() === item.name.toLowerCase()
        );
        const id = existing ? existing.id : createSafeId('prod');
        const nextStock = existing
          ? Math.round((existing.stock + item.quantity) * 1000) / 1000
          : item.quantity;

        batch.set(doc(db, 'products', id), {
          id,
          name: item.name,
          barcode: item.barcode || existing?.barcode || '',
          pluCode: item.pluCode || existing?.pluCode || '',
          category: item.category,
          unit: item.unit,
          isWeighted: item.isWeighted ?? existing?.isWeighted ?? false,
          isQuickItem: item.isQuickItem ?? existing?.isQuickItem ?? false,
          retailPrice: item.retailPrice,
          costPrice: item.costPrice,
          stock: nextStock,
          minStock: item.minStock ?? existing?.minStock ?? 5,
          expiryDate: item.expiryDate || existing?.expiryDate || '',
          supplierName: item.supplierName || existing?.supplierName || '',
          imageUrl: existing?.imageUrl || getCategoryImage(item.category),
          activeOnline: existing?.activeOnline ?? true,
          updatedAt: new Date().toISOString(),
        } satisfies Product);
      }
      await batch.commit();
      setNotice({ type: 'ok', text: `Загружено позиций из Excel: ${items.length}` });
    } catch (err) {
      setNotice({
        type: 'err',
        text: err instanceof Error ? err.message : 'Ошибка импорта Excel',
      });
    } finally {
      e.target.value = '';
    }
  };

  const handleInvoicePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = String(reader.result || '');
      setInvoicePreviewUrl(dataUrl);
      setParsingPhoto(true);
      setNotice(null);
      try {
        const idToken = await auth.currentUser?.getIdToken();
        if (!idToken) {
          throw new Error('Требуется авторизация сотрудника. Повторите вход в систему.');
        }
        const resp = await fetch('/api/invoice/parse', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${idToken}`,
          },
          body: JSON.stringify({ imageBase64: dataUrl, mimeType: file.type || 'image/jpeg' }),
        });
        const data = await resp.json();
        if (!resp.ok) {
          throw new Error(data.error || 'Не удалось распознать накладную');
        }
        setInvoiceSupplier(data.supplierName || 'Поставщик');
        setInvoiceNumber(data.invoiceNumber || `НК-${Date.now().toString().slice(-5)}`);
        setInvoiceItems(
          (data.items || []).map((item: InvoiceItemInput) => ({
            name: item.name || 'Товар',
            barcode: item.barcode || '',
            category: CATEGORIES.includes(item.category) ? item.category : 'Бакалея',
            unit: ['шт', 'кг', 'л', 'уп'].includes(item.unit) ? item.unit : 'шт',
            quantity: Number(item.quantity) || 1,
            costPrice: Number(item.costPrice) || 0,
            retailPrice: Number(item.retailPrice) || Math.round((Number(item.costPrice) || 0) * 1.25),
            expiryDate: item.expiryDate || '',
          }))
        );
        setNotice({
          type: 'ok',
          text: `Распознано позиций с фото накладной: ${(data.items || []).length}. Проверьте и оприходуйте.`,
        });
      } catch (err) {
        setNotice({
          type: 'err',
          text: err instanceof Error ? err.message : 'Ошибка при распознавании фото',
        });
      } finally {
        setParsingPhoto(false);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleCommitInvoice = async () => {
    if (invoiceItems.length === 0) return;
    const invId = createSafeId('inv');
    const expId = createSafeId('exp');
    const totalCost = Math.round(
      invoiceItems.reduce((acc, i) => acc + i.quantity * i.costPrice, 0) * 100
    ) / 100;

    try {
      const batch = writeBatch(db);
      for (const item of invoiceItems) {
        const existing = products.find(
          (p) =>
            (item.barcode && p.barcode === item.barcode) ||
            p.name.toLowerCase() === item.name.toLowerCase()
        );
        const prodId = existing ? existing.id : createSafeId('prod');
        const nextStock = existing
          ? Math.round((existing.stock + item.quantity) * 1000) / 1000
          : item.quantity;

        batch.set(doc(db, 'products', prodId), {
          id: prodId,
          name: item.name,
          barcode: item.barcode || existing?.barcode || '',
          pluCode: existing?.pluCode || '',
          category: item.category,
          unit: item.unit,
          isWeighted: existing?.isWeighted ?? item.unit === 'кг',
          isQuickItem: existing?.isQuickItem ?? false,
          retailPrice: item.retailPrice,
          costPrice: item.costPrice,
          stock: nextStock,
          minStock: existing?.minStock ?? 5,
          expiryDate: item.expiryDate || existing?.expiryDate || '',
          supplierName: invoiceSupplier.trim() || existing?.supplierName || 'Поставщик',
          imageUrl: existing?.imageUrl || getCategoryImage(item.category),
          activeOnline: existing?.activeOnline ?? true,
          updatedAt: new Date().toISOString(),
        } satisfies Product);
      }

      batch.set(doc(db, 'invoices', invId), {
        id: invId,
        invoiceNumber: invoiceNumber.trim() || `НК-${Date.now().toString().slice(-5)}`,
        supplierName: invoiceSupplier.trim() || 'Поставщик',
        items: invoiceItems,
        totalCost,
        parsedByAi: true,
        createdBy: user.uid,
        createdByName: user.displayName,
        createdAt: new Date().toISOString(),
      } satisfies SupplierInvoice);

      batch.set(doc(db, 'expenses', expId), {
        id: expId,
        category: 'Закупка товара',
        amount: totalCost,
        description: `Приход по накладной ${invoiceNumber || invId} (${invoiceSupplier || 'Поставщик'})`,
        expenseDate: new Date().toISOString().slice(0, 10),
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      } satisfies Expense);

      await batch.commit();
      setInvoiceItems([]);
      setInvoiceSupplier('');
      setInvoiceNumber('');
      setInvoicePreviewUrl('');
      setNotice({
        type: 'ok',
        text: `Накладная оприходована на склад. Остатки и расходы по закупке обновлены.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'invoices');
    }
  };

  const handleWriteOff = async (
    prodId: string,
    qty: number,
    reason: WriteOffReason,
    notes: string
  ) => {
    const prod = products.find((p) => p.id === prodId);
    if (!prod || qty <= 0) return;

    const woId = createSafeId('wo');
    const expId = createSafeId('exp');
    const actualQty = Math.min(prod.stock, qty);
    const costValue = Math.round(actualQty * prod.costPrice * 100) / 100;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'write_offs', woId), {
        id: woId,
        productId: prod.id,
        productName: prod.name,
        category: prod.category,
        quantity: actualQty,
        unit: prod.unit,
        costValue,
        reason,
        notes: notes.trim(),
        createdBy: user.uid,
        createdByName: user.displayName,
        createdAt: new Date().toISOString(),
      } satisfies WriteOff);

      batch.update(doc(db, 'products', prod.id), {
        stock: Math.max(0, Math.round((prod.stock - actualQty) * 1000) / 1000),
        updatedAt: new Date().toISOString(),
      });

      batch.set(doc(db, 'expenses', expId), {
        id: expId,
        category: 'Списания и брак',
        amount: costValue,
        description: `Списание: ${prod.name} (${actualQty} ${prod.unit})`,
        expenseDate: new Date().toISOString().slice(0, 10),
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      } satisfies Expense);

      await batch.commit();
      setNotice({
        type: 'ok',
        text: `Списано: ${prod.name} (${actualQty} ${prod.unit}). Остаток на складе уменьшен.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'write_offs');
    }
  };

  const auditCategoryProducts = useMemo(
    () => products.filter((p) => p.category === auditCategory),
    [products, auditCategory]
  );

  const handleCompleteCategoryAudit = async () => {
    if (auditCategoryProducts.length === 0) return;
    const auditId = createSafeId('inv_aud');
    const items = auditCategoryProducts.map((p) => {
      const rawActual = auditCounts[p.id];
      const actualStock =
        rawActual !== undefined && rawActual !== '' ? Math.max(0, Number(rawActual)) : p.stock;
      const diff = Math.round((actualStock - p.stock) * 1000) / 1000;
      const costValueDiff = Math.round(diff * p.costPrice * 100) / 100;
      return {
        productId: p.id,
        name: p.name,
        unit: p.unit,
        expectedStock: p.stock,
        actualStock,
        diff,
        costValueDiff,
      };
    });

    const discrepancyCount = items.filter((i) => Math.abs(i.diff) > 0.001).length;
    const discrepancyValue = Math.round(
      items.reduce((acc, i) => acc + i.costValueDiff, 0) * 100
    ) / 100;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'inventories', auditId), {
        id: auditId,
        category: auditCategory,
        items,
        discrepancyCount,
        discrepancyValue,
        performedBy: user.uid,
        performedByName: user.displayName,
        createdAt: new Date().toISOString(),
      } satisfies InventoryAudit);

      for (const item of items) {
        if (Math.abs(item.diff) > 0.001) {
          batch.update(doc(db, 'products', item.productId), {
            stock: item.actualStock,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await batch.commit();

      if (discrepancyCount > 0) {
        await logHiddenAudit(
          'stock_adjustment',
          `Ревизия категории «${auditCategory}»: расхождений ${discrepancyCount}, сумма по закупке ${formatMoney(discrepancyValue)}`,
          discrepancyValue
        );
      }

      setAuditCounts({});
      setNotice({
        type: 'ok',
        text: `Ревизия полки «${auditCategory}» завершена. Расхождений: ${discrepancyCount}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'inventories');
    }
  };

  const handleGenerateAutoOrder = async () => {
    if (lowStockProducts.length === 0) return;
    const reqId = createSafeId('req');
    const items = lowStockProducts.map((p) => {
      const orderQty = Math.max(10, Math.ceil(p.minStock * 2 - p.stock));
      return {
        productId: p.id,
        name: p.name,
        category: p.category,
        unit: p.unit,
        quantity: orderQty,
        estimatedCost: Math.round(orderQty * p.costPrice * 100) / 100,
        isNewProduct: false,
      };
    });

    const newReq: PurchaseRequest = {
      id: reqId,
      requestNumber: `АВТО-${Date.now().toString().slice(-5)}`,
      requesterId: user.uid,
      requesterName: `${user.displayName} (Автозаказ)`,
      supplierName: 'Сборный заказ поставщикам',
      items,
      isAutoGenerated: true,
      status: 'approved',
      comment: 'Автоматически сформировано при достижении критического минимума остатков',
      unreadForRequester: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      await setDoc(doc(db, 'purchase_requests', reqId), newReq);
      setNotice({
        type: 'ok',
        text: `Автозаявка ${newReq.requestNumber} на ${items.length} позиций сформирована и отправлена.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'purchase_requests');
    }
  };

  const handleUpdateRequestStatus = async (
    req: PurchaseRequest,
    status: PurchaseRequestStatus,
    adminNote?: string
  ) => {
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'purchase_requests', req.id), {
        status,
        adminNote: adminNote ?? req.adminNote ?? '',
        unreadForRequester: true,
        updatedAt: new Date().toISOString(),
      });

      if (status === 'delivered') {
        for (const item of req.items) {
          if (item.productId) {
            const existing = products.find((p) => p.id === item.productId);
            if (existing) {
              batch.update(doc(db, 'products', existing.id), {
                stock: Math.round((existing.stock + item.quantity) * 1000) / 1000,
                updatedAt: new Date().toISOString(),
              });
            }
          } else {
            const newId = createSafeId('prod');
            const unitCost =
              item.quantity > 0 ? Math.round((item.estimatedCost / item.quantity) * 100) / 100 : 100;
            batch.set(doc(db, 'products', newId), {
              id: newId,
              name: item.name,
              barcode: '',
              pluCode: '',
              category: item.category,
              unit: item.unit,
              isWeighted: item.unit === 'кг',
              isQuickItem: false,
              costPrice: unitCost,
              retailPrice: Math.round(unitCost * 1.25),
              stock: item.quantity,
              minStock: 5,
              supplierName: req.supplierName || 'Поставщик',
              imageUrl: getCategoryImage(item.category),
              activeOnline: true,
              updatedAt: new Date().toISOString(),
            } satisfies Product);
          }
        }
      }

      await batch.commit();
      setNotice({ type: 'ok', text: `Статус заявки ${req.requestNumber} обновлен.` });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `purchase_requests/${req.id}`);
    }
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = Number(expAmount);
    if (!amount || amount <= 0 || !expDesc.trim()) return;
    const expId = createSafeId('exp');
    try {
      await setDoc(doc(db, 'expenses', expId), {
        id: expId,
        category: expCategory,
        amount,
        description: expDesc.trim(),
        expenseDate: expDate,
        createdBy: user.uid,
        createdAt: new Date().toISOString(),
      } satisfies Expense);
      setExpAmount('');
      setExpDesc('');
      setNotice({ type: 'ok', text: 'Расход добавлен в аналитику.' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'expenses');
    }
  };

  const expenseByCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, number>();
    EXPENSE_CATEGORIES.forEach((c) => map.set(c, 0));
    expenses.forEach((e) => {
      map.set(e.category, (map.get(e.category) || 0) + e.amount);
    });
    const list = Array.from(map.entries()).map(([category, total]) => ({ category, total }));
    const maxVal = Math.max(1, ...list.map((x) => x.total));
    return { list, maxVal };
  }, [expenses]);

  const handleUpdateOrderStatus = async (
    order: OnlineOrder,
    nextStatus: OnlineOrder['orderStatus']
  ) => {
    try {
      await updateDoc(doc(db, 'online_orders', order.id), {
        orderStatus: nextStatus,
        updatedAt: new Date().toISOString(),
      });
      setNotice({ type: 'ok', text: `Заказ ${order.orderNumber} переведен в статус «${nextStatus}».` });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `online_orders/${order.id}`);
    }
  };

  const handleVerifyQrPayment = async (order: OnlineOrder) => {
    if (order.paymentStatus !== 'awaiting_verification') return;
    setVerifyingOrderId(order.id);
    const nowIso = new Date().toISOString();
    const saleId = createSafeId('sale');
    const saleItems = order.items.map((item) => {
      const prod = products.find((p) => p.id === item.productId);
      return {
        productId: item.productId,
        name: item.name,
        category: prod?.category || 'Прочее',
        unit: item.unit,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        costPrice: prod?.costPrice ?? 0,
        lineTotal: item.lineTotal,
      };
    });
    const costTotal =
      Math.round(saleItems.reduce((acc, i) => acc + i.costPrice * i.quantity, 0) * 100) / 100;

    const saleRecord: Sale = {
      id: saleId,
      receiptNumber: order.orderNumber,
      type: 'sale',
      channel: 'online',
      cashierId: user.uid,
      cashierName: `Онлайн QR (${order.customerName})`.slice(0, 120),
      items: saleItems,
      totalAmount: order.totalAmount,
      costTotal,
      cashAmount: 0,
      cardAmount: 0,
      qrAmount: order.totalAmount,
      paymentMethod: 'online',
      syncedFromOffline: false,
      authorizedBy: `QR проверил: ${user.displayName}`.slice(0, 120),
      createdAt: nowIso,
    };

    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'online_orders', order.id), {
        paymentStatus: 'paid',
        paymentVerifiedBy: user.displayName.slice(0, 120),
        paymentVerifiedAt: nowIso,
        updatedAt: nowIso,
      });
      batch.set(doc(db, 'sales', saleId), saleRecord);
      await batch.commit();
      setNotice({
        type: 'ok',
        text: `Оплата по QR для заказа ${order.orderNumber} (${formatMoney(order.totalAmount)}) подтверждена. Можно начинать сборку.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `online_orders/${order.id}`);
    } finally {
      setVerifyingOrderId(null);
    }
  };

  const handleRejectQrPayment = async (order: OnlineOrder) => {
    if (order.paymentStatus !== 'awaiting_verification') return;
    setVerifyingOrderId(order.id);
    const nowIso = new Date().toISOString();
    try {
      const batch = writeBatch(db);
      batch.update(doc(db, 'online_orders', order.id), {
        paymentStatus: 'rejected',
        orderStatus: 'cancelled',
        paymentVerifiedBy: user.displayName.slice(0, 120),
        paymentVerifiedAt: nowIso,
        updatedAt: nowIso,
      });
      for (const item of order.items) {
        const prod = products.find((p) => p.id === item.productId);
        if (prod) {
          batch.update(doc(db, 'products', prod.id), {
            stock: Math.round((prod.stock + item.quantity) * 1000) / 1000,
            updatedAt: nowIso,
          });
        }
      }
      await batch.commit();
      setNotice({
        type: 'ok',
        text: `Оплата по QR для заказа ${order.orderNumber} отклонена. Заказ отменен, остатки возвращены на склад.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `online_orders/${order.id}`);
    } finally {
      setVerifyingOrderId(null);
    }
  };

  const computeRecommendedRetail = (
    cost: number,
    markupPct: number,
    rounding: 'none' | 'ceil' | 'round' | 'nine'
  ) => {
    const safeCost = Math.max(0, cost);
    const safeMarkup = Math.max(0, markupPct);
    const rawRetail = safeCost * (1 + safeMarkup / 100);
    let recommendedRetail = Math.round(rawRetail * 100) / 100;
    if (rawRetail > 0) {
      if (rounding === 'ceil') recommendedRetail = Math.ceil(rawRetail);
      else if (rounding === 'round') recommendedRetail = Math.round(rawRetail);
      else if (rounding === 'nine') {
        recommendedRetail = rawRetail < 1 ? 0.9 : Math.floor(rawRetail) + 0.9;
      }
    }
    const profitPerUnit = Math.round((recommendedRetail - safeCost) * 100) / 100;
    const actualMarkupPercent =
      safeCost > 0 ? ((recommendedRetail - safeCost) / safeCost) * 100 : 0;
    const grossMarginPercent =
      recommendedRetail > 0 ? ((recommendedRetail - safeCost) / recommendedRetail) * 100 : 0;
    return {
      cost: safeCost,
      rawRetail: Math.round(rawRetail * 100) / 100,
      recommendedRetail,
      profitPerUnit,
      actualMarkupPercent,
      grossMarginPercent,
    };
  };

  const selectedCalcProduct = useMemo(
    () => products.find((p) => p.id === calcProductId) || null,
    [products, calcProductId]
  );

  const marginCalcResult = useMemo(() => {
    const costNum = Number(calcCost) || 0;
    const markupNum = Number(calcMarkupPercent) || 0;
    return computeRecommendedRetail(costNum, markupNum, calcRounding);
  }, [calcCost, calcMarkupPercent, calcRounding]);

  const handleSelectCalcProduct = (productId: string) => {
    setCalcProductId(productId);
    if (productId === 'custom') return;
    const prod = products.find((p) => p.id === productId);
    if (!prod) return;
    setCalcCost(String(prod.costPrice));
    if (prod.costPrice > 0 && prod.retailPrice >= prod.costPrice) {
      const currentMarkup = ((prod.retailPrice - prod.costPrice) / prod.costPrice) * 100;
      setCalcMarkupPercent(String(Math.round(currentMarkup * 10) / 10));
    } else {
      setCalcMarkupPercent('30');
    }
  };

  const handleApplyCalcPriceToProduct = async () => {
    if (!selectedCalcProduct) return;
    const nextCost = Math.max(0, Number(calcCost) || 0);
    const nextRetail = marginCalcResult.recommendedRetail;
    if (nextRetail <= 0) {
      setNotice({ type: 'err', text: 'Рекомендованная розничная цена должна быть больше нуля.' });
      return;
    }
    setApplyingCalcPrice(true);
    try {
      await updateDoc(doc(db, 'products', selectedCalcProduct.id), {
        costPrice: nextCost,
        retailPrice: nextRetail,
        updatedAt: new Date().toISOString(),
      });
      if (selectedCalcProduct.retailPrice !== nextRetail) {
        await logHiddenAudit(
          'price_change',
          `Калькулятор маржи: ${selectedCalcProduct.name} (${formatMoney(
            selectedCalcProduct.retailPrice
          )} -> ${formatMoney(nextRetail)}, наценка ${marginCalcResult.actualMarkupPercent.toFixed(1)}%)`,
          nextRetail - selectedCalcProduct.retailPrice
        );
      }
      setNotice({
        type: 'ok',
        text: `Цена для «${selectedCalcProduct.name}» обновлена: ${formatMoney(nextRetail)}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `products/${selectedCalcProduct.id}`);
    } finally {
      setApplyingCalcPrice(false);
    }
  };

  const handleCreateProductFromCalc = () => {
    setEditingProduct(null);
    setFormName(selectedCalcProduct ? `${selectedCalcProduct.name} (копия)` : '');
    setFormBarcode('');
    setFormPlu('');
    setFormCategory(selectedCalcProduct?.category || 'Бакалея');
    setFormUnit(selectedCalcProduct?.unit || 'шт');
    setFormWeighted(selectedCalcProduct?.isWeighted || false);
    setFormQuick(false);
    setFormCost(String(marginCalcResult.cost));
    setFormRetail(String(marginCalcResult.recommendedRetail));
    setFormMarkup(String(Math.round(marginCalcResult.actualMarkupPercent * 10) / 10));
    setFormStock('0');
    setFormMinStock('10');
    setFormExpiry('');
    setFormSupplier(selectedCalcProduct?.supplierName || '');
    setFormOnline(true);
    setProductModalOpen(true);
  };

  const knownSuppliers = useMemo(() => {
    const set = new Set<string>();
    invoices.forEach((inv) => {
      if (inv.supplierName.trim()) set.add(inv.supplierName.trim());
    });
    supplierPayments.forEach((p) => {
      if (p.supplierName.trim()) set.add(p.supplierName.trim());
    });
    supplierReturns.forEach((r) => {
      if (r.supplierName.trim()) set.add(r.supplierName.trim());
    });
    products.forEach((p) => {
      if (p.supplierName?.trim()) set.add(p.supplierName.trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'ru'));
  }, [invoices, supplierPayments, supplierReturns, products]);

  const supplierBalances = useMemo(() => {
    const map = new Map<
      string,
      {
        supplierName: string;
        invoicedTotal: number;
        paidTotal: number;
        returnedOffsetTotal: number;
        returnedCashTotal: number;
        returnedPendingTotal: number;
        balanceOwed: number;
      }
    >();
    const ensureRow = (name: string) => {
      const key = name.trim();
      let existingRow = map.get(key);
      if (!existingRow) {
        existingRow = {
          supplierName: key,
          invoicedTotal: 0,
          paidTotal: 0,
          returnedOffsetTotal: 0,
          returnedCashTotal: 0,
          returnedPendingTotal: 0,
          balanceOwed: 0,
        };
        map.set(key, existingRow);
      }
      return existingRow;
    };

    invoices.forEach((inv) => {
      if (!inv.supplierName.trim()) return;
      ensureRow(inv.supplierName).invoicedTotal += inv.totalCost;
    });
    supplierPayments.forEach((p) => {
      if (!p.supplierName.trim()) return;
      ensureRow(p.supplierName).paidTotal += p.amount;
    });
    supplierReturns.forEach((r) => {
      if (!r.supplierName.trim()) return;
      const row = ensureRow(r.supplierName);
      if (r.settlementType === 'offset_debt') row.returnedOffsetTotal += r.totalRefund;
      else if (r.settlementType === 'cash_refund') row.returnedCashTotal += r.totalRefund;
      else row.returnedPendingTotal += r.totalRefund;
    });

    return Array.from(map.values())
      .map((r) => ({
        ...r,
        invoicedTotal: Math.round(r.invoicedTotal * 100) / 100,
        paidTotal: Math.round(r.paidTotal * 100) / 100,
        returnedOffsetTotal: Math.round(r.returnedOffsetTotal * 100) / 100,
        returnedCashTotal: Math.round(r.returnedCashTotal * 100) / 100,
        returnedPendingTotal: Math.round(r.returnedPendingTotal * 100) / 100,
        balanceOwed:
          Math.round((r.invoicedTotal - r.paidTotal - r.returnedOffsetTotal) * 100) / 100,
      }))
      .sort((a, b) => b.balanceOwed - a.balanceOwed || a.supplierName.localeCompare(b.supplierName, 'ru'));
  }, [invoices, supplierPayments, supplierReturns]);

  const pendingSupplierReturnsCount = useMemo(
    () => supplierReturns.filter((r) => r.settlementType === 'pending_credit').length,
    [supplierReturns]
  );

  const handleRecordSupplierPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const supplierName = paySupplierName.trim().slice(0, 120);
    const amount = Math.round((Number(payAmount) || 0) * 100) / 100;
    if (!supplierName || amount <= 0) {
      setNotice({ type: 'err', text: 'Укажите поставщика и корректную сумму оплаты больше нуля.' });
      return;
    }

    const linkedInv = invoices.find((inv) => inv.id === payInvoiceId) || null;
    const payId = createSafeId('spay');
    const nowIso = new Date().toISOString();
    const paymentPayload: SupplierPayment = {
      id: payId,
      supplierName,
      amount,
      paymentMethod: payMethod,
      paymentDate: payDate || nowIso.slice(0, 10),
      createdBy: user.uid,
      createdByName: user.displayName.slice(0, 120),
      createdAt: nowIso,
      ...(linkedInv ? { invoiceId: linkedInv.id, invoiceNumber: linkedInv.invoiceNumber.slice(0, 64) } : {}),
      ...(payNotes.trim() ? { notes: payNotes.trim().slice(0, 300) } : {}),
    };

    setSavingSupplierOp(true);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'supplier_payments', payId), paymentPayload);

      if (paySyncExpense) {
        const expId = createSafeId('exp');
        const invLabel = linkedInv ? ` (накл. №${linkedInv.invoiceNumber})` : '';
        batch.set(doc(db, 'expenses', expId), {
          id: expId,
          category: 'Закупка товара',
          amount,
          description: `Оплата поставщику «${supplierName}»${invLabel}`.slice(0, 240),
          expenseDate: paymentPayload.paymentDate,
          createdBy: user.uid,
          createdAt: nowIso,
        } satisfies Expense);
      }

      await batch.commit();
      setPayAmount('');
      setPayInvoiceId('');
      setPayNotes('');
      setNotice({
        type: 'ok',
        text: `Оплата поставщику «${supplierName}» на сумму ${formatMoney(amount)} проведена.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'supplier_payments');
    } finally {
      setSavingSupplierOp(false);
    }
  };

  const handleRecordSupplierReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    const product = products.find((p) => p.id === retProductId);
    if (!product) {
      setNotice({ type: 'err', text: 'Выберите товар со склада для возврата поставщику.' });
      return;
    }
    const supplierName = (retSupplierName.trim() || product.supplierName || '').slice(0, 120);
    if (!supplierName) {
      setNotice({ type: 'err', text: 'Укажите наименование поставщика.' });
      return;
    }
    const qty = Math.round((Number(retQty) || 0) * 1000) / 1000;
    if (qty <= 0) {
      setNotice({ type: 'err', text: 'Количество возврата должно быть больше нуля.' });
      return;
    }
    if (qty > product.stock) {
      setNotice({
        type: 'err',
        text: `На складе только ${product.stock} ${product.unit} товара «${product.name}».`,
      });
      return;
    }

    const unitCost = Math.max(0, Math.round((Number(retUnitCost) || 0) * 100) / 100);
    const totalRefund = Math.round(qty * unitCost * 100) / 100;
    const nextStock = Math.max(0, Math.round((product.stock - qty) * 1000) / 1000);
    const returnId = createSafeId('sret');
    const logId = createSafeId('sec');
    const nowIso = new Date().toISOString();
    const returnNumber = `ВП-${Date.now().toString().slice(-5)}`;

    const returnPayload: SupplierReturn = {
      id: returnId,
      returnNumber,
      supplierName,
      productId: product.id,
      productName: product.name.slice(0, 160),
      unit: product.unit,
      quantity: qty,
      unitCost,
      totalRefund,
      reason: retReason,
      settlementType: retSettlement,
      createdBy: user.uid,
      createdByName: user.displayName.slice(0, 120),
      createdAt: nowIso,
      ...(retInvoiceNum.trim() ? { invoiceNumber: retInvoiceNum.trim().slice(0, 64) } : {}),
      ...(retNotes.trim() ? { notes: retNotes.trim().slice(0, 300) } : {}),
    };

    setSavingSupplierOp(true);
    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'supplier_returns', returnId), returnPayload);
      batch.update(doc(db, 'products', product.id), {
        stock: nextStock,
        updatedAt: nowIso,
      });
      batch.set(doc(db, 'security_logs', logId), {
        id: logId,
        action: 'supplier_return',
        actorId: user.uid,
        actorName: user.displayName.slice(0, 120),
        actorRole: user.role,
        details: `Возврат поставщику «${supplierName}» (${returnNumber}): ${product.name} × ${qty} ${product.unit} на ${formatMoney(totalRefund)}`,
        amountImpact: totalRefund,
        createdAt: nowIso,
      });
      await batch.commit();

      setRetQty('1');
      setRetInvoiceNum('');
      setRetNotes('');
      setNotice({
        type: 'ok',
        text: `Возврат ${returnNumber} поставщику «${supplierName}» оформлен. Остаток «${product.name}» уменьшен до ${nextStock} ${product.unit}.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'supplier_returns');
    } finally {
      setSavingSupplierOp(false);
    }
  };

  const handleUpdateSupplierReturnSettlement = async (
    ret: SupplierReturn,
    nextSettlement: SupplierReturnSettlement
  ) => {
    try {
      await updateDoc(doc(db, 'supplier_returns', ret.id), {
        settlementType: nextSettlement,
      });
      setNotice({
        type: 'ok',
        text: `Статус взаиморасчёта по возврату ${ret.returnNumber} обновлён.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `supplier_returns/${ret.id}`);
    }
  };

  const approvedPurchaseRequests = useMemo(
    () => purchaseRequests.filter((r) => r.status === 'approved'),
    [purchaseRequests]
  );

  const procTotals = useMemo(() => {
    const totalCost = Math.round(
      procItems.reduce((acc, item) => acc + item.quantity * item.costPrice, 0) * 100
    ) / 100;
    const totalRetail = Math.round(
      procItems.reduce((acc, item) => acc + item.quantity * item.retailPrice, 0) * 100
    ) / 100;
    const expectedProfit = Math.round((totalRetail - totalCost) * 100) / 100;
    return { totalCost, totalRetail, expectedProfit };
  }, [procItems]);

  const currentMonthProcurementTotal = useMemo(() => {
    const monthPrefix = new Date().toISOString().slice(0, 7);
    return Math.round(
      invoices
        .filter((inv) => inv.createdAt.startsWith(monthPrefix))
        .reduce((acc, inv) => acc + inv.totalCost, 0) * 100
    ) / 100;
  }, [invoices]);

  const filteredProcInvoices = useMemo(() => {
    const q = procHistorySearch.trim().toLowerCase();
    return invoices.filter((inv) => {
      if (procHistoryFilter === 'manual' && inv.parsedByAi) return false;
      if (procHistoryFilter === 'ai' && !inv.parsedByAi) return false;
      if (!q) return true;
      return (
        inv.supplierName.toLowerCase().includes(q) ||
        inv.invoiceNumber.toLowerCase().includes(q) ||
        inv.items.some((it) => it.name.toLowerCase().includes(q))
      );
    });
  }, [invoices, procHistoryFilter, procHistorySearch]);

  const handleAddProductToProcurement = (prodId: string) => {
    const prod = products.find((p) => p.id === prodId);
    if (!prod) return;
    if (!procSupplier.trim() && prod.supplierName?.trim()) {
      setProcSupplier(prod.supplierName.trim());
    }
    setProcItems((prev) => {
      const idx = prev.findIndex((x) => x.productId === prod.id);
      if (idx >= 0) {
        return prev.map((x, i) =>
          i === idx ? { ...x, quantity: Math.round((x.quantity + 1) * 1000) / 1000 } : x
        );
      }
      const suggestedQty =
        prod.stock <= prod.minStock ? Math.max(5, Math.ceil(prod.minStock * 2 - prod.stock)) : 10;
      return [
        ...prev,
        {
          productId: prod.id,
          name: prod.name,
          barcode: prod.barcode || '',
          category: prod.category,
          unit: prod.unit,
          quantity: suggestedQty,
          costPrice: prod.costPrice,
          retailPrice: prod.retailPrice,
          expiryDate: prod.expiryDate || '',
          isNew: false,
        },
      ];
    });
  };

  const handleAddNewRowToProcurement = () => {
    setProcItems((prev) => [
      ...prev,
      {
        name: '',
        barcode: '',
        category: 'Бакалея',
        unit: 'шт',
        quantity: 10,
        costPrice: 0,
        retailPrice: 0,
        expiryDate: '',
        isNew: true,
      },
    ]);
  };

  const resetProcDraft = () => {
    setProcDraftQuery('');
    setProcDraftMatchedId('');
    setProcDraftBarcode('');
    setProcDraftCategory('Бакалея');
    setProcDraftUnit('шт');
    setProcDraftQty('1');
    setProcDraftCost('');
    setProcDraftMarkup('25');
    setProcDraftRetail('');
    setProcDraftExpiry('');
  };

  const handleProcDraftInputChange = (val: string) => {
    setProcDraftQuery(val);
    const trimmed = val.trim().toLowerCase();
    if (!trimmed) {
      setProcDraftMatchedId('');
      return;
    }
    const matched = products.find(
      (p) =>
        (p.barcode && p.barcode.toLowerCase() === trimmed) ||
        p.name.toLowerCase() === trimmed
    );
    if (matched) {
      setProcDraftMatchedId(matched.id);
      setProcDraftBarcode(matched.barcode || '');
      setProcDraftCategory(matched.category);
      setProcDraftUnit(matched.unit);
      setProcDraftCost(String(matched.costPrice));
      setProcDraftRetail(String(matched.retailPrice));
      if (matched.costPrice > 0 && matched.retailPrice >= matched.costPrice) {
        const pct = ((matched.retailPrice - matched.costPrice) / matched.costPrice) * 100;
        setProcDraftMarkup(String(Math.round(pct * 10) / 10));
      }
      setProcDraftExpiry(matched.expiryDate || '');
      if (!procSupplier.trim() && matched.supplierName?.trim()) {
        setProcSupplier(matched.supplierName.trim());
      }
    } else {
      setProcDraftMatchedId('');
    }
  };

  const handleAddDraftToProcurement = (overrideProductId?: string) => {
    const cleanName = procDraftQuery.trim();
    const matched = overrideProductId
      ? products.find((p) => p.id === overrideProductId)
      : procDraftMatchedId
      ? products.find((p) => p.id === procDraftMatchedId)
      : products.find(
          (p) =>
            (procDraftBarcode.trim() && p.barcode === procDraftBarcode.trim()) ||
            (cleanName && p.name.toLowerCase() === cleanName.toLowerCase())
        );

    const qty = Math.max(0.01, Math.round((Number(procDraftQty) || 1) * 1000) / 1000);
    const costNum = Math.max(0, Math.round((Number(procDraftCost) || 0) * 100) / 100);
    const markupNum = Number(procDraftMarkup) || 0;
    const retailNum =
      procDraftRetail !== ''
        ? Math.max(0, Math.round((Number(procDraftRetail) || 0) * 100) / 100)
        : Math.round(costNum * (1 + markupNum / 100) * 100) / 100;

    if (!matched && !cleanName) {
      setNotice({ type: 'err', text: 'Введите название товара, штрихкод или выберите товар из списка.' });
      return;
    }

    const itemName = (matched?.name || cleanName).slice(0, 160);
    const itemBarcode = (procDraftBarcode.trim() || matched?.barcode || '').slice(0, 64);

    setProcItems((prev) => {
      const existingIdx = matched
        ? prev.findIndex((x) => x.productId === matched.id)
        : prev.findIndex((x) => x.name.toLowerCase() === itemName.toLowerCase());
      if (existingIdx >= 0) {
        return prev.map((x, i) =>
          i === existingIdx
            ? {
                ...x,
                quantity: Math.round((x.quantity + qty) * 1000) / 1000,
                costPrice: procDraftCost !== '' ? costNum : x.costPrice,
                retailPrice: procDraftRetail !== '' ? retailNum : x.retailPrice,
                expiryDate: procDraftExpiry || x.expiryDate,
              }
            : x
        );
      }
      return [
        ...prev,
        {
          productId: matched?.id,
          name: itemName,
          barcode: itemBarcode,
          category: matched ? matched.category : procDraftCategory,
          unit: matched ? matched.unit : procDraftUnit,
          quantity: qty,
          costPrice: procDraftCost !== '' ? costNum : matched?.costPrice || 0,
          retailPrice: procDraftRetail !== '' ? retailNum : matched?.retailPrice || retailNum,
          expiryDate: procDraftExpiry || matched?.expiryDate || '',
          isNew: !matched,
        },
      ];
    });

    resetProcDraft();
  };

  const handleSaveDraftToCatalogAndAdd = async () => {
    const cleanName = procDraftQuery.trim().slice(0, 160);
    if (!cleanName) {
      openProductForm();
      return;
    }

    const existing = procDraftMatchedId
      ? products.find((p) => p.id === procDraftMatchedId)
      : products.find(
          (p) =>
            (procDraftBarcode.trim() && p.barcode === procDraftBarcode.trim()) ||
            p.name.toLowerCase() === cleanName.toLowerCase()
        );
    if (existing) {
      handleAddDraftToProcurement(existing.id);
      return;
    }

    const costNum = Math.max(0, Math.round((Number(procDraftCost) || 0) * 100) / 100);
    const markupNum = Number(procDraftMarkup) || 0;
    const retailNum =
      procDraftRetail !== ''
        ? Math.max(0, Math.round((Number(procDraftRetail) || 0) * 100) / 100)
        : Math.round(costNum * (1 + markupNum / 100) * 100) / 100;

    const prodId = createSafeId('prod');
    const newProduct: Product = {
      id: prodId,
      name: cleanName,
      barcode: procDraftBarcode.trim().slice(0, 64),
      pluCode: '',
      category: procDraftCategory,
      unit: procDraftUnit,
      isWeighted: procDraftUnit === 'кг',
      isQuickItem: false,
      retailPrice: retailNum,
      costPrice: costNum,
      stock: 0,
      minStock: 10,
      expiryDate: procDraftExpiry.trim().slice(0, 32),
      supplierName: procSupplier.trim().slice(0, 120),
      imageUrl: getCategoryImage(procDraftCategory),
      activeOnline: true,
      updatedAt: new Date().toISOString(),
    };

    setSavingDraftCatalog(true);
    try {
      await setDoc(doc(db, 'products', prodId), newProduct);
      const qty = Math.max(0.01, Math.round((Number(procDraftQty) || 1) * 1000) / 1000);
      setProcItems((prev) => [
        ...prev,
        {
          productId: prodId,
          name: newProduct.name,
          barcode: newProduct.barcode || '',
          category: newProduct.category,
          unit: newProduct.unit,
          quantity: qty,
          costPrice: newProduct.costPrice,
          retailPrice: newProduct.retailPrice,
          expiryDate: newProduct.expiryDate || '',
          isNew: false,
        },
      ]);
      resetProcDraft();
      setNotice({
        type: 'ok',
        text: `Товар «${newProduct.name}» добавлен в номенклатуру и в список закупа.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `products/${prodId}`);
    } finally {
      setSavingDraftCatalog(false);
    }
  };

  const handleAddLowStockToProcurement = () => {
    if (lowStockProducts.length === 0) return;
    setProcItems((prev) => {
      const next = [...prev];
      for (const prod of lowStockProducts) {
        const existingIdx = next.findIndex((x) => x.productId === prod.id);
        const orderQty = Math.max(5, Math.ceil(prod.minStock * 2 - prod.stock));
        if (existingIdx === -1) {
          next.push({
            productId: prod.id,
            name: prod.name,
            barcode: prod.barcode || '',
            category: prod.category,
            unit: prod.unit,
            quantity: orderQty,
            costPrice: prod.costPrice,
            retailPrice: prod.retailPrice,
            expiryDate: prod.expiryDate || '',
            isNew: false,
          });
        }
      }
      return next;
    });
    if (!procSupplier.trim()) {
      const firstSupplier = lowStockProducts.find((p) => p.supplierName?.trim())?.supplierName;
      if (firstSupplier) setProcSupplier(firstSupplier);
    }
    setNotice({
      type: 'ok',
      text: `Добавлены дефицитные товары (${lowStockProducts.length} поз.) в ведомость закупа.`,
    });
  };

  const handleLoadRequestToProcurement = (requestId: string) => {
    const req = purchaseRequests.find((r) => r.id === requestId);
    if (!req) return;
    if (req.supplierName?.trim()) setProcSupplier(req.supplierName.trim());
    const mapped: ProcurementLineItem[] = req.items.map((item) => {
      const existing = item.productId
        ? products.find((p) => p.id === item.productId)
        : products.find((p) => p.name.toLowerCase() === item.name.toLowerCase());
      const estUnitCost =
        item.quantity > 0 ? Math.round((item.estimatedCost / item.quantity) * 100) / 100 : 0;
      const costPrice = existing ? existing.costPrice : estUnitCost;
      const retailPrice = existing
        ? existing.retailPrice
        : Math.round(costPrice * 1.25 * 100) / 100;
      return {
        productId: existing?.id,
        name: existing?.name || item.name,
        barcode: existing?.barcode || '',
        category: existing?.category || item.category || 'Бакалея',
        unit: existing?.unit || item.unit || 'шт',
        quantity: item.quantity,
        costPrice,
        retailPrice,
        expiryDate: existing?.expiryDate || '',
        isNew: !existing,
      };
    });
    setProcItems(mapped);
    setNotice({
      type: 'ok',
      text: `Позиции из заявки ${req.requestNumber} загружены в закуп.`,
    });
  };

  const handleRepeatInvoiceProcurement = (inv: SupplierInvoice) => {
    setProcSupplier(inv.supplierName);
    setProcInvoiceNumber('');
    setProcItems(
      inv.items.map((item) => {
        const existing = products.find(
          (p) =>
            (item.barcode && p.barcode === item.barcode) ||
            p.name.toLowerCase() === item.name.toLowerCase()
        );
        return {
          productId: existing?.id,
          name: item.name,
          barcode: item.barcode || existing?.barcode || '',
          category: CATEGORIES.includes(item.category) ? item.category : 'Бакалея',
          unit: item.unit,
          quantity: item.quantity,
          costPrice: item.costPrice,
          retailPrice: item.retailPrice,
          expiryDate: '',
          isNew: !existing,
        };
      })
    );
    setNotice({
      type: 'ok',
      text: `Состав накладной №${inv.invoiceNumber} загружен для повторного закупа.`,
    });
  };

  const handleCommitProcurement = async (e: React.FormEvent) => {
    e.preventDefault();
    const validItems = procItems.filter((item) => item.name.trim() && item.quantity > 0);
    if (validItems.length === 0) {
      setNotice({ type: 'err', text: 'Добавьте хотя бы один товар с наименованием и количеством больше нуля.' });
      return;
    }

    const supplierName = (procSupplier.trim() || 'Поставщик').slice(0, 120);
    const invNum = (procInvoiceNumber.trim() || `ЗП-${Date.now().toString().slice(-5)}`).slice(0, 64);
    const invId = createSafeId('inv');
    const nowIso = new Date().toISOString();
    const docDate = procDate || nowIso.slice(0, 10);

    const invoicePayloadItems: InvoiceItemInput[] = validItems.map((item) => ({
      name: item.name.trim().slice(0, 160),
      barcode: item.barcode.trim().slice(0, 64),
      category: item.category,
      unit: item.unit,
      quantity: Math.round(item.quantity * 1000) / 1000,
      costPrice: Math.max(0, Math.round(item.costPrice * 100) / 100),
      retailPrice: Math.max(0, Math.round(item.retailPrice * 100) / 100),
      expiryDate: item.expiryDate.trim().slice(0, 32),
    }));

    const totalCost = Math.round(
      invoicePayloadItems.reduce((acc, it) => acc + it.quantity * it.costPrice, 0) * 100
    ) / 100;

    setSavingProcurement(true);
    try {
      const batch = writeBatch(db);
      const priceAuditEntries: { details: string; diff: number }[] = [];

      for (const item of validItems) {
        const cleanName = item.name.trim().slice(0, 160);
        const existing = item.productId
          ? products.find((p) => p.id === item.productId)
          : products.find(
              (p) =>
                (item.barcode.trim() && p.barcode === item.barcode.trim()) ||
                p.name.toLowerCase() === cleanName.toLowerCase()
            );

        const prodId = existing ? existing.id : createSafeId('prod');
        const nextStock = existing
          ? Math.round((existing.stock + item.quantity) * 1000) / 1000
          : Math.round(item.quantity * 1000) / 1000;
        const cleanCost = Math.max(0, Math.round(item.costPrice * 100) / 100);
        const cleanRetail = Math.max(0, Math.round(item.retailPrice * 100) / 100);

        batch.set(doc(db, 'products', prodId), {
          id: prodId,
          name: cleanName,
          barcode: item.barcode.trim().slice(0, 64) || existing?.barcode || '',
          pluCode: existing?.pluCode || '',
          category: item.category,
          unit: item.unit,
          isWeighted: existing?.isWeighted ?? item.unit === 'кг',
          isQuickItem: existing?.isQuickItem ?? false,
          retailPrice: cleanRetail,
          costPrice: cleanCost,
          stock: nextStock,
          minStock: existing?.minStock ?? 5,
          expiryDate: item.expiryDate.trim().slice(0, 32) || existing?.expiryDate || '',
          supplierName: supplierName || existing?.supplierName || '',
          imageUrl: existing?.imageUrl || getCategoryImage(item.category),
          activeOnline: existing?.activeOnline ?? true,
          updatedAt: nowIso,
        } satisfies Product);

        if (existing && existing.retailPrice !== cleanRetail) {
          priceAuditEntries.push({
            details: `Закуп товара (${invNum}): изменена цена «${cleanName}» (${formatMoney(
              existing.retailPrice
            )} -> ${formatMoney(cleanRetail)})`,
            diff: cleanRetail - existing.retailPrice,
          });
        }
      }

      batch.set(doc(db, 'invoices', invId), {
        id: invId,
        invoiceNumber: invNum,
        supplierName,
        items: invoicePayloadItems,
        totalCost,
        parsedByAi: false,
        createdBy: user.uid,
        createdByName: user.displayName.slice(0, 120),
        createdAt: nowIso,
      } satisfies SupplierInvoice);

      if (procPaymentMode !== 'credit' && totalCost > 0) {
        const payId = createSafeId('spay');
        batch.set(doc(db, 'supplier_payments', payId), {
          id: payId,
          supplierName,
          invoiceId: invId,
          invoiceNumber: invNum,
          amount: totalCost,
          paymentMethod: procPaymentMode,
          paymentDate: docDate,
          notes: `Оплата при закупе по документу №${invNum}`,
          createdBy: user.uid,
          createdByName: user.displayName.slice(0, 120),
          createdAt: nowIso,
        } satisfies SupplierPayment);
      }

      if (procRecordExpense && totalCost > 0) {
        const expId = createSafeId('exp');
        batch.set(doc(db, 'expenses', expId), {
          id: expId,
          category: 'Закупка товара',
          amount: totalCost,
          description: `Закуп товара №${invNum} (${supplierName})`.slice(0, 240),
          expenseDate: docDate,
          createdBy: user.uid,
          createdAt: nowIso,
        } satisfies Expense);
      }

      await batch.commit();

      for (const audit of priceAuditEntries) {
        await logHiddenAudit('price_change', audit.details, audit.diff);
      }

      setProcItems([]);
      setProcInvoiceNumber('');
      setNotice({
        type: 'ok',
        text: `Закуп №${invNum} (${validItems.length} поз., ${formatMoney(totalCost)}) успешно проведен. Остатки на складе обновлены.`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'invoices');
    } finally {
      setSavingProcurement(false);
    }
  };

  const filteredCatalog = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q) ||
        (p.barcode || '').includes(q)
    );
  }, [products, searchQuery]);

  const navTabs: { id: AdminSection; label: string; count?: number }[] = [
    { id: 'catalog', label: 'Номенклатура и Excel', count: products.length },
    { id: 'procurement', label: 'Закуп товара', count: invoices.length },
    { id: 'margin_calc', label: 'Калькулятор маржи' },
    { id: 'invoice_ai', label: 'Фото накладных (AI)' },
    { id: 'suppliers', label: 'Оплата и возврат поставщикам', count: pendingSupplierReturnsCount },
    { id: 'expiry', label: 'Сроки годности (15 дн.)', count: expiryAlerts.length },
    { id: 'writeoffs', label: 'Списание и брак', count: writeOffs.length },
    { id: 'inventory', label: 'Ревизия по полкам' },
    { id: 'requests', label: 'Заявки и Автозаказ', count: pendingRequestsCount + lowStockProducts.length },
    { id: 'expenses', label: 'Расходы по категориям' },
    { id: 'online_orders', label: 'Онлайн-заказы', count: pendingOnlineOrders },
  ];

  return (
    <div className="space-y-5">
      {/* Operational Alert Strip (NO revenue/sales totals shown to Admin!) */}
      {(expiryAlerts.length > 0 || lowStockProducts.length > 0 || pendingRequestsCount > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3 text-sm text-amber-950">
          <div className="flex flex-wrap items-center gap-4">
            {expiryAlerts.length > 0 && (
              <button
                type="button"
                onClick={() => setSection('expiry')}
                className="inline-flex items-center gap-1.5 font-medium hover:underline"
              >
                <CalendarClock className="w-4 h-4 text-amber-700" />
                Истекает срок годности (≤15 дн.): <span className="font-mono font-bold">{expiryAlerts.length}</span>
              </button>
            )}
            {lowStockProducts.length > 0 && (
              <button
                type="button"
                onClick={() => setSection('requests')}
                className="inline-flex items-center gap-1.5 font-medium hover:underline"
              >
                <AlertTriangle className="w-4 h-4 text-amber-700" />
                Заканчивается товар: <span className="font-mono font-bold">{lowStockProducts.length}</span>
              </button>
            )}
            {pendingRequestsCount > 0 && (
              <button
                type="button"
                onClick={() => setSection('requests')}
                className="inline-flex items-center gap-1.5 font-medium hover:underline"
              >
                <Truck className="w-4 h-4 text-emerald-700" />
                Новые заявки на согласование: <span className="font-mono font-bold">{pendingRequestsCount}</span>
              </button>
            )}
          </div>
          <span className="text-xs text-amber-800">
            Финансовая выручка и P&L доступны только руководителю
          </span>
        </div>
      )}

      {/* Segmented Navigation */}
      <div className="bg-white border border-slate-200 rounded-xl p-1.5 flex items-center gap-1 overflow-x-auto">
        {navTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className={`px-3 py-2 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
              section === t.id
                ? 'bg-slate-900 text-white'
                : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
            }`}
          >
            <span>{t.label}</span>
            {t.count !== undefined && t.count > 0 && (
              <span
                className={`font-mono text-[11px] ${
                  section === t.id ? 'text-emerald-300' : 'text-slate-500'
                }`}
              >
                ({t.count})
              </span>
            )}
          </button>
        ))}
      </div>

      {notice && (
        <div
          className={`px-4 py-2.5 rounded-lg border text-sm flex items-center justify-between ${
            notice.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">
            Скрыть
          </button>
        </div>
      )}

      {/* SECTION 1: Catalog & Excel Integration */}
      {section === 'catalog' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск товара, категории или штрихкода..."
              className="w-full sm:w-72 px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={downloadExcelImportTemplate}
                className="px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Шаблон Excel
              </button>
              <button
                type="button"
                onClick={() => excelInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <Upload className="w-3.5 h-3.5" />
                Импорт из Excel
              </button>
              <input
                ref={excelInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleExcelImport}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => exportProductsToExcel(products)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" />
                Выгрузить Excel
              </button>
              <button
                type="button"
                onClick={() => openProductForm()}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
              >
                <Plus className="w-4 h-4" />
                Добавить товар
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2.5 pr-3 font-medium">Товар</th>
                  <th className="py-2.5 px-3 font-medium">Категория</th>
                  <th className="py-2.5 px-3 font-medium">ШК / PLU</th>
                  <th className="py-2.5 px-3 font-medium text-right">Закуп</th>
                  <th className="py-2.5 px-3 font-medium text-right">Розница</th>
                  <th className="py-2.5 px-3 font-medium text-right">Остаток</th>
                  <th className="py-2.5 px-3 font-medium">Срок годности</th>
                  <th className="py-2.5 pl-3 font-medium text-right">Действие</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCatalog.map((p) => {
                  const isLow = p.stock <= p.minStock;
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="py-2.5 pr-3">
                        <div className="font-medium text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">
                          {p.isQuickItem ? 'Быстрая кнопка кассы' : 'Обычный товар'} ·{' '}
                          {p.activeOnline ? 'В онлайн-магазине' : 'Только зал'}
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-slate-600">{p.category}</td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-600">
                        {p.barcode || 'Без ШК'} {p.pluCode ? `· PLU ${p.pluCode}` : ''}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-right text-slate-600">
                        {formatMoney(p.costPrice)}
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-right text-slate-900">
                        {formatMoney(p.retailPrice)}
                      </td>
                      <td
                        className={`py-2.5 px-3 font-mono text-right font-semibold ${
                          isLow ? 'text-amber-700' : 'text-slate-900'
                        }`}
                      >
                        {p.stock} {p.unit}
                      </td>
                      <td className="py-2.5 px-3 font-mono text-xs text-slate-600">
                        {p.expiryDate || '—'}
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        <button
                          type="button"
                          onClick={() => openProductForm(p)}
                          className="text-xs font-medium text-emerald-700 hover:underline"
                        >
                          Изменить
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* SECTION: Direct Product Procurement ("Закуп товара") */}
      {section === 'procurement' && (
        <div className="space-y-5">
          {/* Summary KPI strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Закупки за текущий месяц</div>
              <div className="font-mono tabular-nums text-xl font-bold text-slate-900 mt-1">
                {formatMoney(currentMonthProcurementTotal)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Всего документов прихода: {invoices.length}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">В текущей ведомости закупа</div>
              <div className="font-mono tabular-nums text-xl font-bold text-emerald-700 mt-1">
                {formatMoney(procTotals.totalCost)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Позиций: {procItems.length} · Потенциал маржи: {formatMoney(procTotals.expectedProfit)}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-slate-500">Товары с низким остатком</div>
                <div className="font-mono tabular-nums text-xl font-bold text-amber-700 mt-1">
                  {lowStockProducts.length} поз.
                </div>
                <div className="text-xs text-slate-500 mt-1">Требуют пополнения</div>
              </div>
              <button
                type="button"
                disabled={lowStockProducts.length === 0}
                onClick={handleAddLowStockToProcurement}
                className="px-3 py-2 text-xs font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-40 whitespace-nowrap"
              >
                + Дозакупить дефицит
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Left / Main: Procurement Builder */}
            <form
              onSubmit={handleCommitProcurement}
              className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="w-5 h-5 text-emerald-700" />
                  <h3 className="text-base font-semibold text-slate-900">
                    Оформление закупа товара на склад
                  </h3>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {approvedPurchaseRequests.length > 0 && (
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) {
                          handleLoadRequestToProcurement(e.target.value);
                          e.target.value = '';
                        }
                      }}
                      className="px-2.5 py-1.5 text-xs border border-emerald-300 bg-emerald-50 text-emerald-900 rounded-lg"
                    >
                      <option value="">Загрузить из одобренной заявки...</option>
                      {approvedPurchaseRequests.map((req) => (
                        <option key={req.id} value={req.id}>
                          {req.requestNumber} ({req.items.length} поз.) — {req.supplierName || req.requesterName}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    onClick={() => setSection('invoice_ai')}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50"
                  >
                    <Camera className="w-3.5 h-3.5" />
                    Распознать по фото
                  </button>
                </div>
              </div>

              {/* Document Header Fields */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Поставщик</label>
                  <input
                    type="text"
                    list="proc-suppliers-list"
                    value={procSupplier}
                    onChange={(e) => setProcSupplier(e.target.value)}
                    placeholder="Название поставщика или базы"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                  <datalist id="proc-suppliers-list">
                    {knownSuppliers.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    № документа / накладной
                  </label>
                  <input
                    type="text"
                    value={procInvoiceNumber}
                    onChange={(e) => setProcInvoiceNumber(e.target.value)}
                    placeholder="Авто (ЗП-...)"
                    className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">Дата закупа</label>
                  <input
                    type="date"
                    value={procDate}
                    onChange={(e) => setProcDate(e.target.value)}
                    className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              {/* Payment Status Selector */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                <div className="text-xs font-medium text-slate-700">Условия оплаты поставщику</div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: 'credit' as const, label: 'В долг (отсрочка)' },
                    { id: 'cash' as const, label: 'Оплачено наличными' },
                    { id: 'bank_transfer' as const, label: 'Перевод / Банк' },
                    { id: 'card' as const, label: 'Оплата картой' },
                  ].map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setProcPaymentMode(mode.id)}
                      className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-colors ${
                        procPaymentMode === mode.id
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {mode.label}
                    </button>
                  ))}
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={procRecordExpense}
                    onChange={(e) => setProcRecordExpense(e.target.checked)}
                  />
                  Отразить сумму закупа в категории расходов «Закупка товара»
                </label>
              </div>

              {/* Dedicated "Добавление товара" Block */}
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-xl space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-xs font-semibold text-slate-900">
                    Добавление товара в закуп
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openProductForm()}
                      className="text-xs font-medium text-emerald-700 hover:underline whitespace-nowrap"
                    >
                      + Карточка нового товара
                    </button>
                    <span className="text-slate-300">·</span>
                    <button
                      type="button"
                      onClick={handleAddNewRowToProcurement}
                      className="text-xs font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap"
                    >
                      + Пустая строка
                    </button>
                  </div>
                </div>

                {/* Search / Input Product Name or Barcode + Existing Catalog Select */}
                <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
                  <div className="sm:col-span-6">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Товар (название или штрихкод)
                    </label>
                    <input
                      type="text"
                      list="proc-catalog-datalist"
                      value={procDraftQuery}
                      onChange={(e) => handleProcDraftInputChange(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddDraftToProcurement();
                        }
                      }}
                      placeholder="Введите название, штрихкод или выберите..."
                      className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg"
                    />
                    <datalist id="proc-catalog-datalist">
                      {products.map((p) => (
                        <option key={p.id} value={p.name}>
                          {p.barcode ? `${p.barcode} · ` : ''}
                          {p.category} · ост: {p.stock} {p.unit}
                        </option>
                      ))}
                    </datalist>
                  </div>

                  <div className="sm:col-span-6">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Или выберите из склада
                    </label>
                    <select
                      value={procSelectedProdId}
                      onChange={(e) => {
                        const id = e.target.value;
                        setProcSelectedProdId(id);
                        if (id) {
                          handleAddProductToProcurement(id);
                          setProcSelectedProdId('');
                        }
                      }}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="">Быстро добавить со склада...</option>
                      {products.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (ост: {p.stock} {p.unit} · {formatMoney(p.costPrice)})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Product Details & Price Fields */}
                <div className="grid grid-cols-2 sm:grid-cols-12 gap-2.5 items-end">
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Категория
                    </label>
                    <select
                      value={procDraftCategory}
                      onChange={(e) => setProcDraftCategory(e.target.value)}
                      className="w-full px-2.5 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="sm:col-span-1">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Ед.
                    </label>
                    <select
                      value={procDraftUnit}
                      onChange={(e) => setProcDraftUnit(e.target.value as ProductUnit)}
                      className="w-full px-2 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="шт">шт</option>
                      <option value="кг">кг</option>
                      <option value="л">л</option>
                      <option value="уп">уп</option>
                    </select>
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Кол-во
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={procDraftQty}
                      onChange={(e) => setProcDraftQty(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddDraftToProcurement();
                        }
                      }}
                      className="w-full px-2.5 py-2 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Закуп (смн)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={procDraftCost}
                      onChange={(e) => {
                        const val = e.target.value;
                        setProcDraftCost(val);
                        const c = Number(val);
                        const m = Number(procDraftMarkup);
                        if (val !== '' && !Number.isNaN(c) && !Number.isNaN(m)) {
                          setProcDraftRetail(String(Math.round(c * (1 + m / 100) * 100) / 100));
                        }
                      }}
                      className="w-full px-2.5 py-2 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-1">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Нац. %
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={procDraftMarkup}
                      onChange={(e) => {
                        const val = e.target.value;
                        setProcDraftMarkup(val);
                        const c = Number(procDraftCost);
                        const m = Number(val);
                        if (procDraftCost !== '' && !Number.isNaN(c) && !Number.isNaN(m)) {
                          setProcDraftRetail(String(Math.round(c * (1 + m / 100) * 100) / 100));
                        }
                      }}
                      className="w-full px-2 py-2 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Розница (смн)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={procDraftRetail}
                      onChange={(e) => {
                        const val = e.target.value;
                        setProcDraftRetail(val);
                        const c = Number(procDraftCost);
                        const r = Number(val);
                        if (c > 0 && !Number.isNaN(r)) {
                          setProcDraftMarkup(String(Math.round(((r - c) / c) * 1000) / 10));
                        }
                      }}
                      className="w-full px-2.5 py-2 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Штрихкод
                    </label>
                    <input
                      type="text"
                      placeholder="Опционально"
                      value={procDraftBarcode}
                      onChange={(e) => setProcDraftBarcode(e.target.value)}
                      className="w-full px-2.5 py-2 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="flex flex-wrap items-end justify-between gap-3 pt-1">
                  <div className="w-44">
                    <label className="block text-[11px] font-medium text-slate-600 mb-1">
                      Срок годности (если есть)
                    </label>
                    <input
                      type="date"
                      value={procDraftExpiry}
                      onChange={(e) => setProcDraftExpiry(e.target.value)}
                      className="w-full px-2.5 py-1.5 font-mono text-xs bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {procDraftQuery.trim() && !procDraftMatchedId && (
                      <button
                        type="button"
                        disabled={savingDraftCatalog}
                        onClick={handleSaveDraftToCatalogAndAdd}
                        className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-50 whitespace-nowrap"
                      >
                        <PackagePlus className="w-3.5 h-3.5" />
                        {savingDraftCatalog ? 'Сохранение...' : 'Сохранить в базу и добавить'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleAddDraftToProcurement()}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 whitespace-nowrap"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Добавить товар в закуп
                    </button>
                  </div>
                </div>
              </div>

              {/* Procurement Items List */}
              {procItems.length === 0 ? (
                <div className="py-10 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-xl">
                  Заполните поле добавления товара выше, выберите товары со склада или загрузите дефицитные позиции.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[460px] overflow-y-auto pr-1">
                  {procItems.map((item, idx) => {
                    const markupPct =
                      item.costPrice > 0
                        ? Math.round(((item.retailPrice - item.costPrice) / item.costPrice) * 1000) / 10
                        : 0;
                    const lineSum = Math.round(item.quantity * item.costPrice * 100) / 100;
                    return (
                      <div
                        key={idx}
                        className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-2.5 text-xs"
                      >
                        <div className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-12 sm:col-span-5">
                            <label className="block text-[11px] text-slate-500 mb-0.5">
                              {item.isNew ? 'Новый товар (наименование)' : 'Товар из номенклатуры'}
                            </label>
                            <input
                              type="text"
                              required
                              placeholder="Наименование товара"
                              value={item.name}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x))
                                )
                              }
                              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-medium text-slate-900"
                            />
                          </div>
                          <div className="col-span-6 sm:col-span-3">
                            <label className="block text-[11px] text-slate-500 mb-0.5">Категория</label>
                            <select
                              value={item.category}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx ? { ...x, category: e.target.value } : x
                                  )
                                )
                              }
                              className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
                            >
                              {CATEGORIES.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div className="col-span-4 sm:col-span-2">
                            <label className="block text-[11px] text-slate-500 mb-0.5">Ед. изм.</label>
                            <select
                              value={item.unit}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx ? { ...x, unit: e.target.value as ProductUnit } : x
                                  )
                                )
                              }
                              className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded"
                            >
                              <option value="шт">шт</option>
                              <option value="кг">кг</option>
                              <option value="л">л</option>
                              <option value="уп">уп</option>
                            </select>
                          </div>
                          <div className="col-span-2 flex justify-end pt-4">
                            <button
                              type="button"
                              onClick={() =>
                                setProcItems((prev) => prev.filter((_, i) => i !== idx))
                              }
                              title="Удалить позицию"
                              className="p-1.5 text-slate-400 hover:text-red-600"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">Кол-во</label>
                            <input
                              type="number"
                              step="0.01"
                              min="0.01"
                              value={item.quantity}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx
                                      ? { ...x, quantity: Number(e.target.value) || 0 }
                                      : x
                                  )
                                )
                              }
                              className="w-full px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">
                              Закуп (смн)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.costPrice}
                              onChange={(e) => {
                                const nextCost = Number(e.target.value) || 0;
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx
                                      ? {
                                          ...x,
                                          costPrice: nextCost,
                                          retailPrice:
                                            x.retailPrice > 0
                                              ? x.retailPrice
                                              : Math.round(nextCost * 1.25 * 100) / 100,
                                        }
                                      : x
                                  )
                                );
                              }}
                              className="w-full px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">
                              Наценка (%)
                            </label>
                            <input
                              type="number"
                              step="0.5"
                              value={markupPct}
                              onChange={(e) => {
                                const pct = Number(e.target.value) || 0;
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx
                                      ? {
                                          ...x,
                                          retailPrice:
                                            Math.round(x.costPrice * (1 + pct / 100) * 100) / 100,
                                        }
                                      : x
                                  )
                                );
                              }}
                              className="w-full px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">
                              Розница (смн)
                            </label>
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={item.retailPrice}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx
                                      ? { ...x, retailPrice: Number(e.target.value) || 0 }
                                      : x
                                  )
                                )
                              }
                              className="w-full px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] text-slate-500 mb-0.5">
                              Срок годности
                            </label>
                            <input
                              type="date"
                              value={item.expiryDate}
                              onChange={(e) =>
                                setProcItems((prev) =>
                                  prev.map((x, i) =>
                                    i === idx ? { ...x, expiryDate: e.target.value } : x
                                  )
                                )
                              }
                              className="w-full px-1.5 py-1.5 font-mono bg-white border border-slate-300 rounded"
                            />
                          </div>
                          <div className="text-right pb-1">
                            <div className="text-[11px] text-slate-500">Сумма закупа</div>
                            <div className="font-mono font-bold text-slate-900 tabular-nums">
                              {formatMoney(lineSum)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {procItems.length > 0 && (
                <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="space-y-0.5 text-xs">
                    <div>
                      Итого к закупу:{' '}
                      <strong className="font-mono text-base text-slate-900 tabular-nums">
                        {formatMoney(procTotals.totalCost)}
                      </strong>
                    </div>
                    <div className="text-slate-500 font-mono tabular-nums">
                      Ожидаемая розничная стоимость: {formatMoney(procTotals.totalRetail)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setProcItems([])}
                      className="px-3.5 py-2.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
                    >
                      Очистить
                    </button>
                    <button
                      type="submit"
                      disabled={savingProcurement}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                    >
                      <PackagePlus className="w-4 h-4" />
                      {savingProcurement ? 'Проведение...' : 'Провести закуп на склад'}
                    </button>
                  </div>
                </div>
              )}
            </form>

            {/* Right: Procurement History & Repeat Purchase */}
            <div className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-900">История закупок</h3>
                <span className="font-mono text-xs text-slate-500">{filteredProcInvoices.length}</span>
              </div>

              <input
                type="text"
                value={procHistorySearch}
                onChange={(e) => setProcHistorySearch(e.target.value)}
                placeholder="Поиск по поставщику, № или товару..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
              />

              <div className="grid grid-cols-3 gap-1.5 text-xs">
                {[
                  { id: 'all' as const, label: 'Все' },
                  { id: 'manual' as const, label: 'Ручной закуп' },
                  { id: 'ai' as const, label: 'Фото AI' },
                ].map((tabItem) => (
                  <button
                    key={tabItem.id}
                    type="button"
                    onClick={() => setProcHistoryFilter(tabItem.id)}
                    className={`py-1.5 rounded-lg border font-medium transition-colors ${
                      procHistoryFilter === tabItem.id
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    {tabItem.label}
                  </button>
                ))}
              </div>

              {filteredProcInvoices.length === 0 ? (
                <div className="py-10 text-center text-xs text-slate-500">
                  Записи о закупках пока отсутствуют.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[540px] overflow-y-auto pr-1">
                  {filteredProcInvoices.map((inv) => (
                    <div
                      key={inv.id}
                      className="p-3 rounded-lg border border-slate-200 bg-slate-50 space-y-2 text-xs"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-slate-900">
                            № {inv.invoiceNumber} · {inv.supplierName}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {inv.createdAt.slice(0, 10)} · {inv.parsedByAi ? 'Фото AI' : 'Закуп товара'} ·{' '}
                            {inv.createdByName}
                          </div>
                        </div>
                        <div className="font-mono font-bold text-slate-900 tabular-nums">
                          {formatMoney(inv.totalCost)}
                        </div>
                      </div>

                      <div className="text-[11px] text-slate-600 leading-relaxed">
                        {inv.items
                          .slice(0, 4)
                          .map((it) => `${it.name} (${it.quantity} ${it.unit} × ${formatMoney(it.costPrice)})`)
                          .join(', ')}
                        {inv.items.length > 4 && ` и еще ${inv.items.length - 4}...`}
                      </div>

                      <div className="flex justify-end pt-1">
                        <button
                          type="button"
                          onClick={() => handleRepeatInvoiceProcurement(inv)}
                          className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 hover:underline"
                        >
                          <RefreshCw className="w-3 h-3" />
                          Повторить закуп
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 2: AI Photo Invoice Parsing */}
      {section === 'invoice_ai' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-700">
                <Sparkles className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Приемка товаров по фото накладной
                </h3>
                <p className="text-xs text-slate-600 mt-0.5">
                  Сфотографируйте или загрузите скан бумажной накладной поставщика — система автоматически распознает товары, закупочные цены, количество и сроки годности.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2.5">
              <button
                type="button"
                disabled={parsingPhoto}
                onClick={() => invoicePhotoRef.current?.click()}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                <Camera className="w-4 h-4" />
                {parsingPhoto ? 'Распознавание накладной...' : 'Загрузить фото накладной'}
              </button>
              <input
                ref={invoicePhotoRef}
                type="file"
                accept="image/*"
                capture="environment"
                onChange={handleInvoicePhotoUpload}
                className="hidden"
              />
            </div>

            {invoicePreviewUrl && (
              <img
                src={invoicePreviewUrl}
                alt="Предпросмотр накладной"
                className="w-full max-h-64 object-contain rounded-lg border border-slate-200 bg-slate-50"
              />
            )}

            <div className="border-t border-slate-200 pt-4 space-y-2">
              <h4 className="text-xs font-semibold text-slate-700">
                Последние оприходованные накладные ({invoices.length})
              </h4>
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {invoices.map((inv) => (
                  <div
                    key={inv.id}
                    className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-xs"
                  >
                    <div>
                      <div className="font-medium text-slate-900">
                        № {inv.invoiceNumber} · {inv.supplierName}
                      </div>
                      <div className="text-slate-500">
                        {inv.createdAt.slice(0, 10)} · {inv.items.length} поз.
                      </div>
                    </div>
                    <div className="font-mono font-semibold text-slate-900">
                      {formatMoney(inv.totalCost)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">
                Распознанные позиции накладной
              </h3>
              <button
                type="button"
                onClick={() =>
                  setInvoiceItems((prev) => [
                    ...prev,
                    {
                      name: 'Новый товар',
                      barcode: '',
                      category: 'Бакалея',
                      unit: 'шт',
                      quantity: 10,
                      costPrice: 100,
                      retailPrice: 125,
                      expiryDate: '',
                    },
                  ])
                }
                className="text-xs font-medium text-emerald-700 hover:underline"
              >
                + Добавить строку вручную
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Поставщик"
                value={invoiceSupplier}
                onChange={(e) => setInvoiceSupplier(e.target.value)}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <input
                type="text"
                placeholder="Номер накладной"
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                className="px-3 py-2 text-sm font-mono border border-slate-300 rounded-lg"
              />
            </div>

            {invoiceItems.length === 0 ? (
              <div className="py-12 text-center text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg">
                Загрузите фото накладной слева или добавьте позиции вручную для оприходования.
              </div>
            ) : (
              <div className="space-y-2.5 max-h-96 overflow-y-auto">
                {invoiceItems.map((item, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-lg border border-slate-200 bg-slate-50 grid grid-cols-12 gap-2 items-center text-xs"
                  >
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) =>
                        setInvoiceItems((prev) =>
                          prev.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x))
                        )
                      }
                      className="col-span-12 sm:col-span-4 px-2.5 py-1.5 bg-white border border-slate-300 rounded"
                    />
                    <input
                      type="number"
                      placeholder="Кол-во"
                      value={item.quantity}
                      onChange={(e) =>
                        setInvoiceItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, quantity: Number(e.target.value) || 0 } : x
                          )
                        )
                      }
                      className="col-span-4 sm:col-span-2 px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                    />
                    <input
                      type="number"
                      placeholder="Закуп"
                      value={item.costPrice}
                      onChange={(e) =>
                        setInvoiceItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, costPrice: Number(e.target.value) || 0 } : x
                          )
                        )
                      }
                      className="col-span-4 sm:col-span-2 px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                    />
                    <input
                      type="number"
                      placeholder="Розница"
                      value={item.retailPrice}
                      onChange={(e) =>
                        setInvoiceItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, retailPrice: Number(e.target.value) || 0 } : x
                          )
                        )
                      }
                      className="col-span-4 sm:col-span-2 px-2 py-1.5 font-mono bg-white border border-slate-300 rounded"
                    />
                    <input
                      type="date"
                      value={item.expiryDate || ''}
                      onChange={(e) =>
                        setInvoiceItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, expiryDate: e.target.value } : x
                          )
                        )
                      }
                      className="col-span-10 sm:col-span-2 px-1.5 py-1.5 font-mono bg-white border border-slate-300 rounded"
                    />
                  </div>
                ))}
              </div>
            )}

            {invoiceItems.length > 0 && (
              <div className="flex items-center justify-between pt-3 border-t border-slate-200">
                <div className="text-sm">
                  Сумма закупки:{' '}
                  <strong className="font-mono">
                    {formatMoney(
                      invoiceItems.reduce((acc, i) => acc + i.quantity * i.costPrice, 0)
                    )}
                  </strong>
                </div>
                <button
                  type="button"
                  onClick={handleCommitInvoice}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                >
                  <PackagePlus className="w-4 h-4" />
                  Оприходовать на склад
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* SECTION 3: 15-Day Expiry Control Panel */}
      {section === 'expiry' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Контроль сроков годности (уведомления за 15 дней)
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Товары, срок годности которых истекает в ближайшие 15 дней или уже истек.
            </p>
          </div>

          {expiryAlerts.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              Нет товаров с истекающим в ближайшие 15 дней сроком годности.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 pr-3">Товар</th>
                    <th className="py-2 px-3">Остаток</th>
                    <th className="py-2 px-3">Дата годности</th>
                    <th className="py-2 px-3">Статус</th>
                    <th className="py-2 pl-3 text-right">Быстрое списание</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expiryAlerts.map(({ product, daysLeft }) => (
                    <tr key={product.id}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">{product.name}</td>
                      <td className="py-2.5 px-3 font-mono">
                        {product.stock} {product.unit}
                      </td>
                      <td className="py-2.5 px-3 font-mono">{product.expiryDate}</td>
                      <td className="py-2.5 px-3">
                        {daysLeft <= 0 ? (
                          <span className="text-xs font-semibold text-red-700">
                            Просрочен ({daysLeft} дн.)
                          </span>
                        ) : daysLeft <= 5 ? (
                          <span className="text-xs font-semibold text-red-700">
                            Критично: осталось {daysLeft} дн.
                          </span>
                        ) : (
                          <span className="text-xs font-semibold text-amber-700">
                            Предупреждение: {daysLeft} дн.
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 pl-3 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            handleWriteOff(
                              product.id,
                              product.stock,
                              'expired',
                              'Списание по контролю 15-дневного срока годности'
                            )
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          Списать остаток
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SECTION 4: Write-Offs & Defects */}
      {section === 'writeoffs' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleWriteOff(
                woProductId || products[0]?.id || '',
                Number(woQty) || 0,
                woReason,
                woNotes
              );
              setWoNotes('');
            }}
            className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <h3 className="text-base font-semibold text-slate-900">
              Оформить списание или брак
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Товар</label>
              <select
                value={woProductId || products[0]?.id || ''}
                onChange={(e) => setWoProductId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (ост: {p.stock} {p.unit})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Количество</label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  value={woQty}
                  onChange={(e) => setWoQty(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Причина</label>
                <select
                  value={woReason}
                  onChange={(e) => setWoReason(e.target.value as WriteOffReason)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="expired">Просрочка</option>
                  <option value="damaged">Бой / Порча</option>
                  <option value="defect">Заводской брак</option>
                  <option value="shortage">Недостача</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Комментарий</label>
              <input
                type="text"
                value={woNotes}
                onChange={(e) => setWoNotes(e.target.value)}
                placeholder="Подробности акта списания..."
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700"
            >
              Списать со склада
            </button>
          </form>

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">Журнал списаний и брака</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className="py-2 pr-3">Дата</th>
                    <th className="py-2 px-3">Товар</th>
                    <th className="py-2 px-3">Причина</th>
                    <th className="py-2 px-3 text-right">Кол-во</th>
                    <th className="py-2 pl-3 text-right">Убыток (закуп)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {writeOffs.map((w) => (
                    <tr key={w.id}>
                      <td className="py-2.5 pr-3 font-mono text-xs text-slate-500">
                        {w.createdAt.slice(0, 10)}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900">{w.productName}</div>
                        {w.notes && <div className="text-xs text-slate-500">{w.notes}</div>}
                      </td>
                      <td className="py-2.5 px-3 text-xs text-slate-700">{w.reason}</td>
                      <td className="py-2.5 px-3 font-mono text-right">
                        {w.quantity} {w.unit}
                      </td>
                      <td className="py-2.5 pl-3 font-mono font-semibold text-right text-red-700">
                        {formatMoney(w.costValue)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 5: Category Shelf Inventory Audit */}
      {section === 'inventory' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Быстрая ревизия по отдельным полкам (категориям) без закрытия магазина
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Проверяйте одну категорию в день (например, сегодня «Напитки», завтра «Молочные»).
              </p>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={auditCategory}
                onChange={(e) => {
                  setAuditCategory(e.target.value);
                  setAuditCounts({});
                }}
                className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    Полка: {c}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={handleCompleteCategoryAudit}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
              >
                <ClipboardCheck className="w-4 h-4" />
                Зафиксировать ревизию
              </button>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-xs text-slate-500">
                  <th className="py-2 pr-3">Товар</th>
                  <th className="py-2 px-3 text-right">По учету</th>
                  <th className="py-2 px-3 text-right">Фактически на полке</th>
                  <th className="py-2 pl-3 text-right">Расхождение</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {auditCategoryProducts.map((p) => {
                  const val = auditCounts[p.id];
                  const actual = val !== undefined && val !== '' ? Number(val) : p.stock;
                  const diff = Math.round((actual - p.stock) * 1000) / 1000;
                  return (
                    <tr key={p.id}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900">{p.name}</td>
                      <td className="py-2.5 px-3 font-mono text-right text-slate-600">
                        {p.stock} {p.unit}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <input
                          type="number"
                          step="0.01"
                          value={val ?? String(p.stock)}
                          onChange={(e) =>
                            setAuditCounts((prev) => ({ ...prev, [p.id]: e.target.value }))
                          }
                          className="w-28 px-2.5 py-1.5 font-mono text-sm text-right border border-slate-300 rounded-lg"
                        />
                      </td>
                      <td
                        className={`py-2.5 pl-3 font-mono text-right font-semibold ${
                          diff === 0
                            ? 'text-slate-400'
                            : diff > 0
                            ? 'text-emerald-700'
                            : 'text-red-700'
                        }`}
                      >
                        {diff > 0 ? `+${diff}` : diff} {p.unit}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {inventories.length > 0 && (
            <div className="border-t border-slate-200 pt-4 space-y-2">
              <h4 className="text-xs font-semibold text-slate-700">История ревизий</h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {inventories.slice(0, 6).map((inv) => (
                  <div key={inv.id} className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs">
                    <div className="font-semibold text-slate-900">{inv.category}</div>
                    <div className="text-slate-500 mt-0.5">
                      {inv.createdAt.slice(0, 10)} · {inv.performedByName}
                    </div>
                    <div className="font-mono mt-1 text-slate-800">
                      Расхождений: {inv.discrepancyCount} ({formatMoney(inv.discrepancyValue)})
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION 6: Purchase Requests & Auto-Reorder */}
      {section === 'requests' && (
        <div className="space-y-5">
          {/* Auto-reorder critical stock panel */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  Автозаявка поставщикам при критическом остатке ({lowStockProducts.length})
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Товары, остаток которых достиг или упал ниже установленного минимума.
                </p>
              </div>
              <button
                type="button"
                disabled={lowStockProducts.length === 0}
                onClick={handleGenerateAutoOrder}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-40"
              >
                <Truck className="w-4 h-4" />
                Сформировать автозаявку
              </button>
            </div>

            {lowStockProducts.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {lowStockProducts.map((p) => (
                  <div key={p.id} className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs">
                    <div className="font-semibold text-slate-900">{p.name}</div>
                    <div className="text-slate-600 mt-1 font-mono">
                      Остаток: <strong className="text-red-700">{p.stock}</strong> / Мин: {p.minStock} {p.unit}
                    </div>
                    <div className="text-slate-500 mt-0.5">
                      Поставщик: {p.supplierName || 'Не указан'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Incoming Requisitions Approval */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <h3 className="text-base font-semibold text-slate-900">
              Входящие заявки на закупку от заявщиков и автозаказа
            </h3>
            <div className="space-y-3">
              {purchaseRequests.map((req) => (
                <div
                  key={req.id}
                  className="p-4 rounded-lg border border-slate-200 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono font-bold text-slate-900">{req.requestNumber}</span>
                      <span className="text-slate-400">·</span>
                      <span className="font-medium text-slate-800">{req.requesterName}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-xs text-slate-500">{req.createdAt.slice(0, 10)}</span>
                      <span className="text-slate-400">·</span>
                      <span className="text-xs font-semibold text-emerald-700 uppercase">
                        {req.status}
                      </span>
                    </div>
                    <div className="text-xs text-slate-600">
                      Позиции:{' '}
                      {req.items
                        .map((i) => `${i.name} (${i.quantity} ${i.unit})`)
                        .join(', ')}
                    </div>
                    {req.comment && (
                      <div className="text-xs text-slate-500">Комментарий: {req.comment}</div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {req.status === 'new' && (
                      <button
                        type="button"
                        onClick={() => handleUpdateRequestStatus(req, 'reviewing')}
                        className="px-3 py-1.5 text-xs font-medium border border-slate-300 rounded-lg hover:bg-slate-50"
                      >
                        Взять в работу
                      </button>
                    )}
                    {(req.status === 'new' || req.status === 'reviewing') && (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateRequestStatus(req, 'approved', 'Согласовано к закупке')
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Одобрить
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            handleUpdateRequestStatus(req, 'rejected', 'Отклонено администратором')
                          }
                          className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg hover:bg-red-100"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          Отклонить
                        </button>
                      </>
                    )}
                    {req.status === 'approved' && (
                      <button
                        type="button"
                        onClick={() =>
                          handleUpdateRequestStatus(req, 'delivered', 'Товар принят на склад')
                        }
                        className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                      >
                        Отметить «Доставлено» и оприходовать
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* SECTION 7: Expense Dynamics by Category */}
      {section === 'expenses' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
          <form
            onSubmit={handleAddExpense}
            className="lg:col-span-4 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
          >
            <div className="flex items-center gap-2">
              <Receipt className="w-4 h-4 text-slate-700" />
              <h3 className="text-base font-semibold text-slate-900">Внести расход</h3>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Категория</label>
              <select
                value={expCategory}
                onChange={(e) => setExpCategory(e.target.value as ExpenseCategory)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {EXPENSE_CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Сумма (смн)</label>
                <input
                  type="number"
                  min="1"
                  value={expAmount}
                  onChange={(e) => setExpAmount(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Дата</label>
                <input
                  type="date"
                  value={expDate}
                  onChange={(e) => setExpDate(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Назначение</label>
              <input
                type="text"
                value={expDesc}
                onChange={(e) => setExpDesc(e.target.value)}
                placeholder="Например: Оплата доставки овощей"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800"
            >
              Добавить расход
            </button>
          </form>

          <div className="lg:col-span-8 bg-white border border-slate-200 rounded-xl p-5 space-y-5">
            <h3 className="text-base font-semibold text-slate-900">
              Динамика и структура расходов по категориям
            </h3>
            <div className="space-y-3">
              {expenseByCategory.list.map((row) => (
                <div key={row.category} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-slate-700">{row.category}</span>
                    <span className="font-mono font-semibold text-slate-900">
                      {formatMoney(row.total)}
                    </span>
                  </div>
                  <div className="h-2.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-emerald-600 rounded-full"
                      style={{ width: `${Math.round((row.total / expenseByCategory.maxVal) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="border-t border-slate-200 pt-4 max-h-60 overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500 border-b border-slate-200">
                    <th className="py-2">Дата</th>
                    <th className="py-2">Категория</th>
                    <th className="py-2">Описание</th>
                    <th className="py-2 text-right">Сумма</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expenses.slice(0, 15).map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 font-mono text-slate-500">{e.expenseDate}</td>
                      <td className="py-2 font-medium text-slate-800">{e.category}</td>
                      <td className="py-2 text-slate-600">{e.description}</td>
                      <td className="py-2 font-mono font-semibold text-right">
                        {formatMoney(e.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SECTION 8: Online Store Order Fulfillment (NO revenue aggregates shown to Admin!) */}
      {section === 'online_orders' && (
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <ShoppingBag className="w-5 h-5 text-emerald-700" />
              <h3 className="text-base font-semibold text-slate-900">
                Сборка, проверка QR-оплат и выдача онлайн-заказов
              </h3>
            </div>
            <span className="text-xs text-slate-500">
              Заказы по QR поступают на сборку только после сверки оплаты администратором
            </span>
          </div>

          {onlineOrders.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">
              Онлайн-заказы пока отсутствуют.
            </div>
          ) : (
            <div className="space-y-3">
              {onlineOrders.map((order) => {
                const isAwaitingQr = order.paymentStatus === 'awaiting_verification';
                const isRejected = order.paymentStatus === 'rejected';
                const paymentMethodLabel =
                  order.paymentMethod === 'qr_online'
                    ? 'QR-оплата'
                    : order.paymentMethod === 'card_online'
                    ? 'Карта онлайн'
                    : 'При получении';
                const paymentStatusLabel =
                  order.paymentStatus === 'awaiting_verification'
                    ? 'Ожидает подтверждения оплаты'
                    : order.paymentStatus === 'paid'
                    ? 'Оплата подтверждена'
                    : order.paymentStatus === 'rejected'
                    ? 'Оплата отклонена'
                    : 'Оплата при получении';
                const paymentStatusClass =
                  order.paymentStatus === 'awaiting_verification'
                    ? 'text-amber-700 font-semibold'
                    : order.paymentStatus === 'paid'
                    ? 'text-emerald-700 font-semibold'
                    : order.paymentStatus === 'rejected'
                    ? 'text-red-700 font-semibold'
                    : 'text-slate-600 font-medium';

                return (
                  <div
                    key={order.id}
                    className={`p-4 rounded-lg border flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${
                      isAwaitingQr
                        ? 'border-amber-300 bg-amber-50/40'
                        : isRejected
                        ? 'border-red-200 bg-red-50/30'
                        : 'border-slate-200 bg-white'
                    }`}
                  >
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-mono font-bold text-slate-900">
                          {order.orderNumber}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {formatMoney(order.totalAmount)}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="font-medium text-slate-800">{order.customerName}</span>
                        <span className="text-slate-400">·</span>
                        <span className="font-mono text-xs text-slate-600">
                          {order.customerPhone}
                        </span>
                        <span className="text-slate-400">·</span>
                        <span className="text-xs font-medium text-emerald-700">
                          {order.deliveryType === 'delivery'
                            ? `Доставка: ${order.deliveryAddress || 'не указан'}`
                            : 'Самовывоз'}
                        </span>
                      </div>

                      <div className="text-xs text-slate-600">
                        Состав:{' '}
                        {order.items.map((i) => `${i.name} (${i.quantity} ${i.unit})`).join(', ')}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                        <span>
                          Оплата: {paymentMethodLabel} (
                          <span className={paymentStatusClass}>{paymentStatusLabel}</span>)
                        </span>
                        <span>·</span>
                        <span>
                          Статус заказа: <strong className="text-slate-800">{order.orderStatus}</strong>
                        </span>
                        {order.paymentVerifiedBy && (
                          <>
                            <span>·</span>
                            <span className="text-slate-600">
                              Проверил: {order.paymentVerifiedBy}
                            </span>
                          </>
                        )}
                      </div>

                      {(order.paymentProofNote || order.paymentProofImage) && (
                        <div className="flex flex-wrap items-center gap-3 pt-1">
                          {order.paymentProofNote && (
                            <span className="text-xs text-slate-700 bg-white border border-slate-200 rounded px-2.5 py-1">
                              Комментарий клиента: {order.paymentProofNote}
                            </span>
                          )}
                          {order.paymentProofImage && (
                            <button
                              type="button"
                              onClick={() => setPreviewReceiptOrder(order)}
                              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-800 bg-white border border-emerald-300 rounded hover:bg-emerald-50"
                            >
                              <Eye className="w-3.5 h-3.5" />
                              Открыть скриншот чека
                            </button>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 shrink-0">
                      {isAwaitingQr && (
                        <>
                          <button
                            type="button"
                            disabled={verifyingOrderId === order.id}
                            onClick={() => handleVerifyQrPayment(order)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            Подтвердить оплату
                          </button>
                          <button
                            type="button"
                            disabled={verifyingOrderId === order.id}
                            onClick={() => handleRejectQrPayment(order)}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
                          >
                            <XCircle className="w-3.5 h-3.5" />
                            Отклонить оплату
                          </button>
                        </>
                      )}

                      {!isAwaitingQr && !isRejected && order.orderStatus === 'new' && (
                        <button
                          type="button"
                          onClick={() => handleUpdateOrderStatus(order, 'packing')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                        >
                          Начать сборку
                        </button>
                      )}
                      {!isAwaitingQr && !isRejected && order.orderStatus === 'packing' && (
                        <button
                          type="button"
                          onClick={() => handleUpdateOrderStatus(order, 'delivering')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                        >
                          Передать в доставку / выдачу
                        </button>
                      )}
                      {!isAwaitingQr && !isRejected && order.orderStatus === 'delivering' && (
                        <button
                          type="button"
                          onClick={() => handleUpdateOrderStatus(order, 'completed')}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-700 rounded-lg hover:bg-emerald-800"
                        >
                          Завершить заказ
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {previewReceiptOrder && previewReceiptOrder.paymentProofImage && (
            <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
              <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-900">
                      Скриншот чека оплаты · {previewReceiptOrder.orderNumber}
                    </h4>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {previewReceiptOrder.customerName} ·{' '}
                      <span className="font-mono font-semibold text-slate-800">
                        {formatMoney(previewReceiptOrder.totalAmount)}
                      </span>
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewReceiptOrder(null)}
                    className="text-xs text-slate-500 hover:text-slate-900 underline"
                  >
                    Закрыть
                  </button>
                </div>
                {previewReceiptOrder.paymentProofNote && (
                  <div className="text-xs text-slate-700 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                    Комментарий: {previewReceiptOrder.paymentProofNote}
                  </div>
                )}
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-2 flex justify-center">
                  <img
                    src={previewReceiptOrder.paymentProofImage}
                    alt={`Чек заказа ${previewReceiptOrder.orderNumber}`}
                    className="max-h-[60vh] object-contain rounded"
                  />
                </div>
                {previewReceiptOrder.paymentStatus === 'awaiting_verification' && (
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      disabled={verifyingOrderId === previewReceiptOrder.id}
                      onClick={async () => {
                        const target = previewReceiptOrder;
                        setPreviewReceiptOrder(null);
                        await handleRejectQrPayment(target);
                      }}
                      className="px-3 py-2 text-xs font-medium text-red-700 border border-red-300 rounded-lg hover:bg-red-50"
                    >
                      Отклонить оплату
                    </button>
                    <button
                      type="button"
                      disabled={verifyingOrderId === previewReceiptOrder.id}
                      onClick={async () => {
                        const target = previewReceiptOrder;
                        setPreviewReceiptOrder(null);
                        await handleVerifyQrPayment(target);
                      }}
                      className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                    >
                      Подтвердить оплату
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* SECTION: Margin & Retail Price Calculator */}
      {section === 'margin_calc' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left: Inputs */}
            <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                    <Calculator className="w-4 h-4 text-emerald-600" />
                    Калькулятор маржи и розничной цены
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Автоматический расчет рекомендованной розничной цены на основе себестоимости и желаемого процента наценки
                  </p>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Товар из каталога (опционально — для подстановки закупочной цены и сохранения в карточку)
                </label>
                <select
                  value={calcProductId}
                  onChange={(e) => handleSelectCalcProduct(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="custom">Произвольный расчет (без привязки к товару)</option>
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — закуп {formatMoney(p.costPrice)} / сейчас в рознице {formatMoney(p.retailPrice)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Себестоимость / Закуп (смн {selectedCalcProduct ? `за ${selectedCalcProduct.unit}` : 'за ед.'})
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={calcCost}
                    onChange={(e) => setCalcCost(e.target.value)}
                    placeholder="0.00"
                    className="w-full px-3.5 py-2.5 font-mono tabular-nums text-base font-semibold border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Желаемая наценка (%)
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={calcMarkupPercent}
                    onChange={(e) => setCalcMarkupPercent(e.target.value)}
                    placeholder="30"
                    className="w-full px-3.5 py-2.5 font-mono tabular-nums text-base font-semibold border border-slate-300 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-700 mb-1.5">
                  Быстрый выбор процента наценки
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {[15, 20, 25, 30, 35, 40, 50, 75, 100].map((pct) => {
                    const isActive = Number(calcMarkupPercent) === pct;
                    return (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => setCalcMarkupPercent(String(pct))}
                        className={`px-3 py-1.5 text-xs font-mono font-medium rounded-lg border transition-colors ${
                          isActive
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                        }`}
                      >
                        +{pct}%
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-slate-700 mb-1.5">
                  Округление розничной цены
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { id: 'none' as const, label: 'Без округления' },
                    { id: 'ceil' as const, label: 'Вверх до смн' },
                    { id: 'round' as const, label: 'До целого смн' },
                    { id: 'nine' as const, label: 'До .90 смн' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setCalcRounding(opt.id)}
                      className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${
                        calcRounding === opt.id
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Calculated Result & Actions */}
            <div className="lg:col-span-5 bg-slate-900 text-white rounded-xl p-5 flex flex-col justify-between space-y-5">
              <div className="space-y-4">
                <div className="flex items-center justify-between text-xs text-slate-400">
                  <span>Рекомендованная розничная цена</span>
                  {selectedCalcProduct && (
                    <span className="font-mono text-slate-300">
                      Сейчас: {formatMoney(selectedCalcProduct.retailPrice)}
                    </span>
                  )}
                </div>

                <div className="flex items-baseline justify-between gap-3 border-b border-slate-800 pb-4">
                  <div className="text-3xl sm:text-4xl font-mono tabular-nums font-bold text-emerald-400">
                    {formatMoney(marginCalcResult.recommendedRetail)}
                  </div>
                  <span className="text-xs text-slate-400">
                    за 1 {selectedCalcProduct ? selectedCalcProduct.unit : 'ед.'}
                  </span>
                </div>

                {calcRounding !== 'none' &&
                  marginCalcResult.rawRetail !== marginCalcResult.recommendedRetail && (
                    <div className="text-xs text-slate-400 font-mono tabular-nums">
                      Точная цена до округления: {formatMoney(marginCalcResult.rawRetail)}
                    </div>
                  )}

                <div className="grid grid-cols-3 gap-3 pt-1">
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    <div className="text-[11px] text-slate-400">Прибыль с ед.</div>
                    <div className="text-base font-mono tabular-nums font-semibold text-white mt-0.5">
                      {formatMoney(marginCalcResult.profitPerUnit)}
                    </div>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    <div className="text-[11px] text-slate-400">Наценка (факт)</div>
                    <div className="text-base font-mono tabular-nums font-semibold text-emerald-300 mt-0.5">
                      {marginCalcResult.actualMarkupPercent.toFixed(1)}%
                    </div>
                  </div>
                  <div className="bg-slate-800/80 rounded-lg p-3">
                    <div className="text-[11px] text-slate-400">Маржа в цене</div>
                    <div className="text-base font-mono tabular-nums font-semibold text-amber-300 mt-0.5">
                      {marginCalcResult.grossMarginPercent.toFixed(1)}%
                    </div>
                  </div>
                </div>

                <p className="text-[11px] text-slate-400 leading-relaxed">
                  Наценка считается от себестоимости: Себестоимость × (1 + Наценка% / 100). Маржинальность показывает долю прибыли в итоговой розничной цене.
                </p>
              </div>

              <div className="space-y-2 pt-2 border-t border-slate-800">
                {selectedCalcProduct ? (
                  <button
                    type="button"
                    disabled={applyingCalcPrice || marginCalcResult.recommendedRetail <= 0}
                    onClick={handleApplyCalcPriceToProduct}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 disabled:opacity-50 rounded-lg transition-colors"
                  >
                    {applyingCalcPrice
                      ? 'Сохранение цены...'
                      : `Применить цену к «${selectedCalcProduct.name}»`}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleCreateProductFromCalc}
                    className="w-full py-2.5 px-4 text-sm font-semibold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-lg transition-colors"
                  >
                    Создать новый товар с этой ценой
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Reference Table for current cost price */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">
                Сетка цен для себестоимости {formatMoney(marginCalcResult.cost)}
              </h3>
              <span className="text-xs text-slate-500">
                Нажмите на строку, чтобы подставить наценку в калькулятор
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left">
                <thead className="text-xs text-slate-500 border-b border-slate-200">
                  <tr>
                    <th className="py-2 pr-3 font-medium">Наценка</th>
                    <th className="py-2 px-3 font-medium text-right">Розница</th>
                    <th className="py-2 px-3 font-medium text-right">Прибыль / ед.</th>
                    <th className="py-2 pl-3 font-medium text-right">Маржа в цене</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {[15, 20, 25, 30, 40, 50, 70, 100].map((pct) => {
                    const row = computeRecommendedRetail(marginCalcResult.cost, pct, calcRounding);
                    const active = Number(calcMarkupPercent) === pct;
                    return (
                      <tr
                        key={pct}
                        onClick={() => setCalcMarkupPercent(String(pct))}
                        className={`cursor-pointer transition-colors ${
                          active ? 'bg-emerald-50/70' : 'hover:bg-slate-50'
                        }`}
                      >
                        <td className="py-2 pr-3 font-mono tabular-nums font-medium text-slate-900">
                          +{pct}%
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums font-semibold text-emerald-700 text-right">
                          {formatMoney(row.recommendedRetail)}
                        </td>
                        <td className="py-2 px-3 font-mono tabular-nums text-slate-700 text-right">
                          {formatMoney(row.profitPerUnit)}
                        </td>
                        <td className="py-2 pl-3 font-mono tabular-nums text-slate-600 text-right">
                          {row.grossMarginPercent.toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SECTION: Supplier Payments & Returns */}
      {section === 'suppliers' && (
        <div className="space-y-5">
          {/* Summary KPI strip */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Начислено по накладным</div>
              <div className="font-mono tabular-nums text-xl font-bold text-slate-900 mt-1">
                {formatMoney(invoices.reduce((a, b) => a + b.totalCost, 0))}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Накладных: {invoices.length}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Оплачено поставщикам</div>
              <div className="font-mono tabular-nums text-xl font-bold text-emerald-700 mt-1">
                {formatMoney(supplierPayments.reduce((a, b) => a + b.amount, 0))}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Платежей проведено: {supplierPayments.length}
              </div>
            </div>
            <div className="bg-white border border-slate-200 rounded-xl p-4">
              <div className="text-xs text-slate-500">Возвраты товара поставщикам</div>
              <div className="font-mono tabular-nums text-xl font-bold text-amber-700 mt-1">
                {formatMoney(supplierReturns.reduce((a, b) => a + b.totalRefund, 0))}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                Оформлено актов: {supplierReturns.length} · Ожидает зачёта: {pendingSupplierReturnsCount}
              </div>
            </div>
          </div>

          {/* Supplier Reconciliation Table */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2">
                <Truck className="w-4 h-4 text-emerald-700" />
                Сверка взаиморасчётов с поставщиками
              </h3>
              <input
                type="text"
                value={supplierFilter}
                onChange={(e) => setSupplierFilter(e.target.value)}
                placeholder="Фильтр по поставщику..."
                className="w-full sm:w-64 px-3 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            {supplierBalances.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">
                Поставщики появятся здесь после загрузки накладных, оплаты или оформления возврата.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                  <thead className="text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="py-2 pr-3 font-medium">Поставщик</th>
                      <th className="py-2 px-3 font-medium text-right">Начислено (накладные)</th>
                      <th className="py-2 px-3 font-medium text-right">Оплачено</th>
                      <th className="py-2 px-3 font-medium text-right">Возврат в зачёт</th>
                      <th className="py-2 px-3 font-medium text-right">Остаток к оплате</th>
                      <th className="py-2 pl-3 font-medium text-right">Действия</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {supplierBalances
                      .filter(
                        (row) =>
                          !supplierFilter.trim() ||
                          row.supplierName.toLowerCase().includes(supplierFilter.trim().toLowerCase())
                      )
                      .map((row) => (
                        <tr key={row.supplierName} className="hover:bg-slate-50">
                          <td className="py-2.5 pr-3 font-medium text-slate-900">
                            {row.supplierName}
                            {row.returnedPendingTotal > 0 && (
                              <span className="text-[11px] text-amber-700 ml-2 font-normal">
                                (ожидает зачёта {formatMoney(row.returnedPendingTotal)})
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-700">
                            {formatMoney(row.invoicedTotal)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-emerald-700">
                            {formatMoney(row.paidTotal)}
                          </td>
                          <td className="py-2.5 px-3 font-mono tabular-nums text-right text-slate-700">
                            {formatMoney(row.returnedOffsetTotal)}
                          </td>
                          <td
                            className={`py-2.5 px-3 font-mono tabular-nums text-right font-semibold ${
                              row.balanceOwed > 0
                                ? 'text-amber-700'
                                : row.balanceOwed < 0
                                ? 'text-emerald-700'
                                : 'text-slate-600'
                            }`}
                          >
                            {formatMoney(row.balanceOwed)}
                          </td>
                          <td className="py-2.5 pl-3 text-right space-x-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => {
                                setSupplierSubMode('payments');
                                setPaySupplierName(row.supplierName);
                                if (row.balanceOwed > 0) setPayAmount(String(row.balanceOwed));
                              }}
                              className="text-emerald-700 hover:underline font-medium"
                            >
                              Оплатить
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setSupplierSubMode('returns');
                                setRetSupplierName(row.supplierName);
                              }}
                              className="text-slate-600 hover:text-slate-900 hover:underline font-medium"
                            >
                              Возврат
                            </button>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Sub-mode Toggle */}
          <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
            <button
              type="button"
              onClick={() => setSupplierSubMode('payments')}
              className={`px-4 py-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
                supplierSubMode === 'payments'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Banknote className="w-3.5 h-3.5 text-emerald-600" />
              Оплата поставщикам
            </button>
            <button
              type="button"
              onClick={() => setSupplierSubMode('returns')}
              className={`px-4 py-2 text-xs font-medium rounded-md whitespace-nowrap shrink-0 transition-colors flex items-center gap-1.5 ${
                supplierSubMode === 'returns'
                  ? 'bg-white text-slate-900 shadow-xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <RotateCcw className="w-3.5 h-3.5 text-amber-600" />
              Возврат товара поставщику
            </button>
          </div>

          <datalist id="known-suppliers-list">
            {knownSuppliers.map((sup) => (
              <option key={sup} value={sup} />
            ))}
          </datalist>

          {supplierSubMode === 'payments' ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Payment Form */}
              <form
                onSubmit={handleRecordSupplierPayment}
                className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <h3 className="text-base font-semibold text-slate-900">
                  Провести оплату поставщику
                </h3>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Поставщик
                  </label>
                  <input
                    type="text"
                    required
                    list="known-suppliers-list"
                    value={paySupplierName}
                    onChange={(e) => setPaySupplierName(e.target.value)}
                    placeholder="Выберите или введите поставщика"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Привязать к накладной (опционально)
                  </label>
                  <select
                    value={payInvoiceId}
                    onChange={(e) => {
                      const invId = e.target.value;
                      setPayInvoiceId(invId);
                      const inv = invoices.find((x) => x.id === invId);
                      if (inv) {
                        setPaySupplierName(inv.supplierName);
                        if (!payAmount) setPayAmount(String(inv.totalCost));
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Без привязки к накладной</option>
                    {invoices
                      .filter(
                        (inv) =>
                          !paySupplierName.trim() ||
                          inv.supplierName.toLowerCase().includes(paySupplierName.trim().toLowerCase())
                      )
                      .map((inv) => (
                        <option key={inv.id} value={inv.id}>
                          №{inv.invoiceNumber} · {inv.supplierName} ({formatMoney(inv.totalCost)})
                        </option>
                      ))}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Сумма оплаты (смн)
                    </label>
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      value={payAmount}
                      onChange={(e) => setPayAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 font-mono tabular-nums text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Дата оплаты
                    </label>
                    <input
                      type="date"
                      required
                      value={payDate}
                      onChange={(e) => setPayDate(e.target.value)}
                      className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Способ оплаты
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {[
                      { id: 'bank_transfer' as const, label: 'Р/с перевод' },
                      { id: 'cash' as const, label: 'Наличные' },
                      { id: 'card' as const, label: 'Карта' },
                    ].map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        onClick={() => setPayMethod(m.id)}
                        className={`px-2.5 py-2 text-xs font-medium rounded-lg border transition-colors ${
                          payMethod === m.id
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Примечание / № платежа
                  </label>
                  <input
                    type="text"
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                    placeholder="Напр. частичная оплата за молочную партию"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={paySyncExpense}
                    onChange={(e) => setPaySyncExpense(e.target.checked)}
                  />
                  Отразить также в «Расходах» (категория «Закупка товара»)
                </label>

                <button
                  type="submit"
                  disabled={savingSupplierOp}
                  className="w-full py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                >
                  {savingSupplierOp ? 'Проведение...' : 'Провести оплату поставщику'}
                </button>
              </form>

              {/* Payments History */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-base font-semibold text-slate-900">
                  История оплат поставщикам
                </h3>
                {supplierPayments.length === 0 ? (
                  <div className="py-12 text-center text-sm text-slate-500">
                    Оплаты поставщикам ещё не регистрировались.
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-[480px] overflow-y-auto">
                    <table className="w-full text-xs text-left">
                      <thead className="text-slate-500 border-b border-slate-200 sticky top-0 bg-white">
                        <tr>
                          <th className="py-2 pr-2 font-medium">Дата</th>
                          <th className="py-2 px-2 font-medium">Поставщик</th>
                          <th className="py-2 px-2 font-medium">Накладная / Способ</th>
                          <th className="py-2 px-2 font-medium">Примечание</th>
                          <th className="py-2 pl-2 font-medium text-right">Сумма</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {supplierPayments
                          .filter(
                            (p) =>
                              !supplierFilter.trim() ||
                              p.supplierName
                                .toLowerCase()
                                .includes(supplierFilter.trim().toLowerCase())
                          )
                          .map((p) => (
                            <tr key={p.id}>
                              <td className="py-2.5 pr-2 font-mono text-slate-500 whitespace-nowrap">
                                {p.paymentDate}
                              </td>
                              <td className="py-2.5 px-2 font-medium text-slate-900">
                                {p.supplierName}
                              </td>
                              <td className="py-2.5 px-2 text-slate-600">
                                {p.invoiceNumber ? `№${p.invoiceNumber} · ` : ''}
                                {p.paymentMethod === 'cash'
                                  ? 'Наличные'
                                  : p.paymentMethod === 'card'
                                  ? 'Карта'
                                  : 'Р/с перевод'}
                              </td>
                              <td className="py-2.5 px-2 text-slate-500">
                                {p.notes || p.createdByName}
                              </td>
                              <td className="py-2.5 pl-2 font-mono tabular-nums font-semibold text-right text-emerald-700 whitespace-nowrap">
                                {formatMoney(p.amount)}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* Supplier Return Form */}
              <form
                onSubmit={handleRecordSupplierReturn}
                className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4"
              >
                <div>
                  <h3 className="text-base font-semibold text-slate-900">
                    Возврат товара поставщику
                  </h3>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Остаток товара автоматически спишется со склада и отобразится в сверке
                  </p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Товар со склада
                  </label>
                  <select
                    required
                    value={retProductId}
                    onChange={(e) => {
                      const prodId = e.target.value;
                      setRetProductId(prodId);
                      const p = products.find((x) => x.id === prodId);
                      if (p) {
                        if (p.supplierName) setRetSupplierName(p.supplierName);
                        setRetUnitCost(String(p.costPrice));
                      }
                    }}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="">Выберите товар для возврата</option>
                    {products
                      .filter((p) => p.stock > 0)
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — ост. {p.stock} {p.unit} (закуп {formatMoney(p.costPrice)})
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1">
                    Поставщик
                  </label>
                  <input
                    type="text"
                    required
                    list="known-suppliers-list"
                    value={retSupplierName}
                    onChange={(e) => setRetSupplierName(e.target.value)}
                    placeholder="Кому возвращаем товар"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Количество
                    </label>
                    <input
                      type="number"
                      min="0.001"
                      step="0.01"
                      required
                      value={retQty}
                      onChange={(e) => setRetQty(e.target.value)}
                      className="w-full px-3 py-2 font-mono tabular-nums text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Цена возврата (смн)
                    </label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      required
                      value={retUnitCost}
                      onChange={(e) => setRetUnitCost(e.target.value)}
                      className="w-full px-3 py-2 font-mono tabular-nums text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-lg px-3.5 py-2.5 text-xs">
                  <span className="text-slate-600">Сумма возврата поставщику:</span>
                  <span className="font-mono tabular-nums font-bold text-sm text-slate-900">
                    {formatMoney(
                      Math.max(0, (Number(retQty) || 0) * (Number(retUnitCost) || 0))
                    )}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Причина возврата
                    </label>
                    <select
                      value={retReason}
                      onChange={(e) => setRetReason(e.target.value as SupplierReturnReason)}
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="defect">Брак / повреждение</option>
                      <option value="expiring">Истекает срок годности</option>
                      <option value="wrong_delivery">Пересорт / ошибка</option>
                      <option value="overstock">Излишек / нереализовано</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Взаиморасчёт
                    </label>
                    <select
                      value={retSettlement}
                      onChange={(e) =>
                        setRetSettlement(e.target.value as SupplierReturnSettlement)
                      }
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg bg-white"
                    >
                      <option value="offset_debt">Зачесть в долг поставщику</option>
                      <option value="cash_refund">Возврат денег от поставщика</option>
                      <option value="pending_credit">Ожидает подтверждения</option>
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      № накладной (опц.)
                    </label>
                    <input
                      type="text"
                      value={retInvoiceNum}
                      onChange={(e) => setRetInvoiceNum(e.target.value)}
                      placeholder="Н-104"
                      className="w-full px-3 py-2 font-mono text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-700 mb-1">
                      Примечание
                    </label>
                    <input
                      type="text"
                      value={retNotes}
                      onChange={(e) => setRetNotes(e.target.value)}
                      placeholder="Комментарий к акту"
                      className="w-full px-3 py-2 text-xs border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={savingSupplierOp}
                  className="w-full py-2.5 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  {savingSupplierOp
                    ? 'Оформление...'
                    : 'Оформить возврат и списать со склада'}
                </button>
              </form>

              {/* Returns History */}
              <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl p-5 space-y-3">
                <h3 className="text-base font-semibold text-slate-900">
                  Журнал возвратов поставщикам
                </h3>
                {supplierReturns.length === 0 ? (
                  <div className="py-12 text-center text-sm text-slate-500">
                    Возвраты поставщикам пока не оформлялись.
                  </div>
                ) : (
                  <div className="space-y-2.5 max-h-[540px] overflow-y-auto">
                    {supplierReturns
                      .filter(
                        (r) =>
                          !supplierFilter.trim() ||
                          r.supplierName
                            .toLowerCase()
                            .includes(supplierFilter.trim().toLowerCase())
                      )
                      .map((r) => (
                        <div
                          key={r.id}
                          className="p-3.5 rounded-lg border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                        >
                          <div className="space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono font-bold text-slate-900">
                                {r.returnNumber}
                              </span>
                              <span className="text-slate-400">·</span>
                              <span className="font-semibold text-slate-800">
                                {r.supplierName}
                              </span>
                              <span className="text-slate-400">·</span>
                              <span className="text-slate-500">
                                {r.createdAt.slice(0, 10)}
                              </span>
                            </div>
                            <div className="text-slate-700">
                              {r.productName} —{' '}
                              <span className="font-mono font-semibold">
                                {r.quantity} {r.unit}
                              </span>{' '}
                              × {formatMoney(r.unitCost)}
                            </div>
                            <div className="text-slate-500">
                              Причина:{' '}
                              {r.reason === 'defect'
                                ? 'Брак / повреждение'
                                : r.reason === 'expiring'
                                ? 'Истекает срок годности'
                                : r.reason === 'wrong_delivery'
                                ? 'Пересорт / ошибка'
                                : 'Излишек'}
                              {' · '}
                              Статус:{' '}
                              <strong
                                className={
                                  r.settlementType === 'offset_debt'
                                    ? 'text-emerald-700'
                                    : r.settlementType === 'cash_refund'
                                    ? 'text-emerald-700'
                                    : 'text-amber-700'
                                }
                              >
                                {r.settlementType === 'offset_debt'
                                  ? 'Зачтено в долг'
                                  : r.settlementType === 'cash_refund'
                                  ? 'Деньги возвращены'
                                  : 'Ожидает подтверждения'}
                              </strong>
                              {r.notes ? ` · ${r.notes}` : ''}
                            </div>
                          </div>

                          <div className="flex flex-col sm:items-end gap-1.5 shrink-0">
                            <div className="font-mono tabular-nums text-sm font-bold text-slate-900">
                              {formatMoney(r.totalRefund)}
                            </div>
                            {r.settlementType === 'pending_credit' && (
                              <div className="flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateSupplierReturnSettlement(r, 'offset_debt')
                                  }
                                  className="px-2 py-1 text-[11px] font-medium text-white bg-emerald-600 rounded hover:bg-emerald-700"
                                >
                                  Зачесть в долг
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleUpdateSupplierReturnSettlement(r, 'cash_refund')
                                  }
                                  className="px-2 py-1 text-[11px] font-medium text-slate-700 border border-slate-300 rounded hover:bg-slate-50"
                                >
                                  Деньги получены
                                </button>
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal: Add / Edit Product */}
      {productModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={handleSaveProduct}
            className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <h3 className="text-lg font-semibold text-slate-900">
              {editingProduct ? 'Редактировать товар' : 'Новый товар в номенклатуре'}
            </h3>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Наименование</label>
              <input
                type="text"
                required
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Категория</label>
                <select
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ед. изм.</label>
                <select
                  value={formUnit}
                  onChange={(e) => setFormUnit(e.target.value as ProductUnit)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="шт">шт</option>
                  <option value="кг">кг</option>
                  <option value="л">л</option>
                  <option value="уп">уп</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Штрихкод (если есть)
                </label>
                <input
                  type="text"
                  value={formBarcode}
                  onChange={(e) => setFormBarcode(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  PLU-код весов (5 цифр)
                </label>
                <input
                  type="text"
                  value={formPlu}
                  onChange={(e) => setFormPlu(e.target.value)}
                  placeholder="00101"
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Закуп (смн)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={formCost}
                  onChange={(e) => {
                    const nextCostStr = e.target.value;
                    setFormCost(nextCostStr);
                    const costNum = Number(nextCostStr);
                    const markupNum = Number(formMarkup);
                    if (formMarkup !== '' && !Number.isNaN(costNum) && costNum >= 0 && !Number.isNaN(markupNum)) {
                      const nextRetail = Math.round(costNum * (1 + markupNum / 100) * 100) / 100;
                      setFormRetail(String(nextRetail));
                    }
                  }}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Розница (смн)</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={formRetail}
                  onChange={(e) => {
                    const nextRetailStr = e.target.value;
                    setFormRetail(nextRetailStr);
                    const costNum = Number(formCost);
                    const retailNum = Number(nextRetailStr);
                    if (costNum > 0 && retailNum >= 0) {
                      const pct = ((retailNum - costNum) / costNum) * 100;
                      setFormMarkup(String(Math.round(pct * 10) / 10));
                    }
                  }}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Остаток</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={formStock}
                  onChange={(e) => setFormStock(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Мин. ост.</label>
                <input
                  type="number"
                  step="0.01"
                  required
                  value={formMinStock}
                  onChange={(e) => setFormMinStock(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            {/* Inline Markup Calculator in Product Modal */}
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-700 flex items-center gap-1.5">
                  <Calculator className="w-3.5 h-3.5 text-emerald-600" />
                  Расчет розничной цены по наценке
                </span>
                <span className="text-xs font-mono tabular-nums text-slate-600">
                  Маржа:{' '}
                  {Number(formRetail) > 0
                    ? `${(((Number(formRetail) - (Number(formCost) || 0)) / Number(formRetail)) * 100).toFixed(1)}%`
                    : '0.0%'}{' '}
                  · Прибыль:{' '}
                  {formatMoney((Number(formRetail) || 0) - (Number(formCost) || 0))}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-slate-600">Наценка %:</span>
                  <input
                    type="number"
                    step="0.1"
                    value={formMarkup}
                    onChange={(e) => {
                      const nextMarkupStr = e.target.value;
                      setFormMarkup(nextMarkupStr);
                      const costNum = Number(formCost);
                      const markupNum = Number(nextMarkupStr);
                      if (!Number.isNaN(costNum) && costNum >= 0 && !Number.isNaN(markupNum)) {
                        const nextRetail = Math.round(costNum * (1 + markupNum / 100) * 100) / 100;
                        setFormRetail(String(nextRetail));
                      }
                    }}
                    placeholder="30"
                    className="w-20 px-2.5 py-1 font-mono text-xs border border-slate-300 rounded-md bg-white"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  {[20, 25, 30, 40, 50].map((pct) => (
                    <button
                      key={pct}
                      type="button"
                      onClick={() => {
                        setFormMarkup(String(pct));
                        const costNum = Number(formCost) || 0;
                        const nextRetail = Math.round(costNum * (1 + pct / 100) * 100) / 100;
                        setFormRetail(String(nextRetail));
                      }}
                      className={`px-2 py-1 text-[11px] font-mono rounded border transition-colors ${
                        Number(formMarkup) === pct
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      +{pct}%
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Срок годности
                </label>
                <input
                  type="date"
                  value={formExpiry}
                  onChange={(e) => setFormExpiry(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Поставщик</label>
                <input
                  type="text"
                  value={formSupplier}
                  onChange={(e) => setFormSupplier(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-4 pt-1 text-xs text-slate-700">
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formWeighted}
                  onChange={(e) => setFormWeighted(e.target.checked)}
                />
                Весовой товар
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formQuick}
                  onChange={(e) => setFormQuick(e.target.checked)}
                />
                Быстрая кнопка на кассе
              </label>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formOnline}
                  onChange={(e) => setFormOnline(e.target.checked)}
                />
                Показывать в онлайн-магазине
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setProductModalOpen(false)}
                className="px-4 py-2 text-sm text-slate-600"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
              >
                Сохранить товар
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
