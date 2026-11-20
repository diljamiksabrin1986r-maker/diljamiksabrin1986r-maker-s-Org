import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Banknote,
  Barcode,
  CheckCircle2,
  CreditCard,
  Folder,
  FolderOpen,
  ImagePlus,
  LogOut,
  Minus,
  Package,
  Plus,
  RefreshCw,
  Scale,
  Trash2,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { doc, setDoc, writeBatch } from 'firebase/firestore';
import { createSafeId, db, handleFirestoreError, OperationType } from '../firebase';
import type {
  CartItem,
  OfflineSaleQueueItem,
  PosSecuritySettings,
  Product,
  ProductUnit,
  Sale,
  SecurityLog,
  SecurityLogAction,
  Shift,
  StoreSettings,
  UserProfile,
} from '../types';
import {
  buildWeightedBarcodeSample,
  generateNextPluCode,
  normalizePluCode,
  parseRetailBarcode,
} from '../utils/barcode';
import { formatMoney } from '../utils/exportReports';
import { compressProductImageFile } from '../utils/imageCompress';
import {
  enqueueOfflineSale,
  enqueueOfflineSecurityLog,
  getOfflineQueue,
  getOfflineSecurityQueue,
  saveOfflineQueue,
  saveOfflineSecurityQueue,
} from '../utils/offlineSync';
import { syncWeightedProductsToScales } from '../utils/scaleSync';
import { DEFAULT_QUICK_CATEGORIES, resolveQuickCategory } from '../utils/seedData';

interface CashierPOSViewProps {
  user: UserProfile;
  products: Product[];
  activeShift: Shift | null;
  storeSettings: StoreSettings | null;
  posSecurity: PosSecuritySettings | null;
  isBrowserOnline: boolean;
  canWriteCloud: boolean;
  isCashierFullscreen?: boolean;
  onExitShift?: () => void;
  onLocalStockAdjust: (deltas: { productId: string; delta: number }[]) => void;
  onLocalSaleRecorded?: (sale: Sale) => void;
  onProductSaved?: (product: Product) => Promise<void> | void;
}

const DEFAULT_CATEGORY_ORDER = [...DEFAULT_QUICK_CATEGORIES] as string[];

export const CashierPOSView: React.FC<CashierPOSViewProps> = ({
  user,
  products,
  activeShift,
  isBrowserOnline,
  canWriteCloud,
  isCashierFullscreen = false,
  onExitShift,
  onLocalStockAdjust,
  onLocalSaleRecorded,
  onProductSaved,
}) => {
  const effectiveOnline = isBrowserOnline;

  const [barcodeInput, setBarcodeInput] = useState('');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [lastAddedItem, setLastAddedItem] = useState<{
    name: string;
    quantity: number;
    unit: string;
    unitPrice: number;
  } | null>(null);
  const [statusNotice, setStatusNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(
    null
  );

  // Quick Items Category Folder State
  const [selectedQuickCategory, setSelectedQuickCategory] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Record<string, boolean>>({});

  // Quick Product Creation Modal State
  const [quickModalOpen, setQuickModalOpen] = useState(false);
  const [qpName, setQpName] = useState('');
  const [qpPrice, setQpPrice] = useState('');
  const [qpCategory, setQpCategory] = useState<string>(DEFAULT_QUICK_CATEGORIES[0]);
  const [qpUnit, setQpUnit] = useState<ProductUnit>('шт');
  const [qpWeighted, setQpWeighted] = useState(false);
  const [qpPlu, setQpPlu] = useState('');
  const [qpImageUrl, setQpImageUrl] = useState('');
  const [qpImageError, setQpImageError] = useState('');
  const [qpSaving, setQpSaving] = useState(false);

  // Scale Sync Toast Notification
  const [scaleToast, setScaleToast] = useState<{
    ok: boolean;
    text: string;
    retryProduct?: Product;
  } | null>(null);

  const [offlineQueue, setOfflineQueue] = useState<OfflineSaleQueueItem[]>(() => getOfflineQueue());
  const [syncingQueue, setSyncingQueue] = useState(false);

  // Compact weight prompt for weighted items without embedded scale weight
  const [weightProduct, setWeightProduct] = useState<Product | null>(null);
  const [manualWeightKg, setManualWeightKg] = useState('0.500');

  // Checkout Modal (Cash / Card + Change Calculator)
  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [payMode, setPayMode] = useState<'cash' | 'card'>('cash');
  const [cashTendered, setCashTendered] = useState('');
  const [processingSale, setProcessingSale] = useState(false);

  const barcodeFieldRef = useRef<HTMLInputElement>(null);
  const cashInputRef = useRef<HTMLInputElement>(null);
  const scanBufferRef = useRef<{ buf: string; lastTime: number }>({ buf: '', lastTime: 0 });

  const focusScanner = useCallback(() => {
    window.requestAnimationFrame(() => {
      if (!paymentModalOpen && !weightProduct && !quickModalOpen) {
        barcodeFieldRef.current?.focus();
      }
    });
  }, [paymentModalOpen, weightProduct, quickModalOpen]);

  useEffect(() => {
    focusScanner();
  }, [focusScanner]);

  useEffect(() => {
    if (paymentModalOpen && payMode === 'cash') {
      window.requestAnimationFrame(() => {
        cashInputRef.current?.focus();
        cashInputRef.current?.select();
      });
    }
  }, [paymentModalOpen, payMode]);

  useEffect(() => {
    if (!scaleToast) return;
    const t = window.setTimeout(() => setScaleToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [scaleToast]);

  // Hidden audit trail — queues locally when offline/local and auto-syncs when cloud is online
  const writeHiddenSecurityLog = useCallback(
    async (action: SecurityLogAction, details: string, amountImpact: number) => {
      const logId = createSafeId('sec');
      const logEntry: SecurityLog = {
        id: logId,
        action,
        actorId: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        details: details.slice(0, 500),
        amountImpact,
        createdAt: new Date().toISOString(),
      };

      if (!effectiveOnline || !canWriteCloud) {
        enqueueOfflineSecurityLog(logEntry);
        return;
      }

      try {
        await setDoc(doc(db, 'security_logs', logId), logEntry);
      } catch {
        enqueueOfflineSecurityLog(logEntry);
      }
    },
    [effectiveOnline, canWriteCloud, user.uid, user.displayName, user.role]
  );

  const syncOfflineSecurityLogs = useCallback(async () => {
    if (!effectiveOnline || !canWriteCloud) return;
    const queued = getOfflineSecurityQueue();
    if (queued.length === 0) return;

    const remaining: SecurityLog[] = [];
    for (const log of queued) {
      if (log.actorId !== user.uid) {
        remaining.push(log);
        continue;
      }
      try {
        await setDoc(doc(db, 'security_logs', log.id), log);
      } catch {
        remaining.push(log);
      }
    }
    saveOfflineSecurityQueue(remaining);
  }, [effectiveOnline, canWriteCloud, user.uid]);

  useEffect(() => {
    if (!effectiveOnline || !canWriteCloud) return;
    void syncOfflineSecurityLogs();
    const timer = window.setInterval(() => {
      void syncOfflineSecurityLogs();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [effectiveOnline, canWriteCloud, syncOfflineSecurityLogs]);

  const syncOfflineReceipts = useCallback(async () => {
    const queue = getOfflineQueue();
    if (queue.length === 0 || !effectiveOnline || !canWriteCloud) return;
    setSyncingQueue(true);
    try {
      const remaining: OfflineSaleQueueItem[] = [];
      for (const item of queue) {
        try {
          const batch = writeBatch(db);
          const syncedSale: Sale = {
            ...item.sale,
            cashierId: user.uid,
            syncedFromOffline: true,
          };
          batch.set(doc(db, 'sales', syncedSale.id), syncedSale);
          for (const d of item.stockDeltas) {
            const p = products.find((prod) => prod.id === d.productId);
            if (p) {
              const nextStock = Math.max(0, Math.round((p.stock + d.delta) * 1000) / 1000);
              batch.update(doc(db, 'products', p.id), {
                stock: nextStock,
                updatedAt: new Date().toISOString(),
              });
            }
          }
          await batch.commit();
        } catch {
          remaining.push(item);
        }
      }
      saveOfflineQueue(remaining);
      setOfflineQueue(remaining);
      if (remaining.length === 0) {
        setStatusNotice({ type: 'ok', text: 'Офлайн-чеки синхронизированы с базой.' });
      }
    } finally {
      setSyncingQueue(false);
    }
  }, [effectiveOnline, canWriteCloud, products, user.uid]);

  useEffect(() => {
    if (effectiveOnline && canWriteCloud && offlineQueue.length > 0) {
      void syncOfflineReceipts();
    }
  }, [effectiveOnline, canWriteCloud, offlineQueue.length, syncOfflineReceipts]);

  const addProductToCart = useCallback(
    (product: Product, qty: number, overrideLineTotal?: number) => {
      const cleanQty = Math.round(qty * 1000) / 1000;
      if (cleanQty <= 0) return;

      setCart((prev) => {
        const existingIdx = prev.findIndex((i) => i.productId === product.id && !overrideLineTotal);
        if (existingIdx >= 0) {
          return prev.map((item, idx) => {
            if (idx !== existingIdx) return item;
            const nextQty = Math.round((item.quantity + cleanQty) * 1000) / 1000;
            return {
              ...item,
              quantity: nextQty,
              lineTotal: Math.round(nextQty * item.unitPrice * 100) / 100,
            };
          });
        }
        const lineTotal =
          overrideLineTotal !== undefined
            ? Math.round(overrideLineTotal * 100) / 100
            : Math.round(cleanQty * product.retailPrice * 100) / 100;
        return [
          ...prev,
          {
            productId: product.id,
            name: product.name,
            unit: product.unit,
            isWeighted: product.isWeighted,
            quantity: cleanQty,
            unitPrice: product.retailPrice,
            costPrice: product.costPrice,
            lineTotal,
          },
        ];
      });

      setLastAddedItem({
        name: product.name,
        quantity: cleanQty,
        unit: product.unit,
        unitPrice: product.retailPrice,
      });
      setStatusNotice(null);
      focusScanner();
    },
    [focusScanner]
  );

  const handleScanCode = useCallback(
    (rawCode: string) => {
      const trimmed = rawCode.trim();
      if (!trimmed) return;
      const parsed = parseRetailBarcode(trimmed, products);
      if (!parsed.matchedProduct) {
        setStatusNotice({
          type: 'err',
          text: `Штрихкод или PLU «${parsed.rawCode}» не найден на складе.`,
        });
        focusScanner();
        return;
      }
      if (parsed.matchedProduct.isWeighted && !parsed.isWeightedBarcode) {
        setWeightProduct(parsed.matchedProduct);
        setManualWeightKg('0.500');
        return;
      }
      addProductToCart(parsed.matchedProduct, parsed.quantity, parsed.overrideLineTotal);
    },
    [products, addProductToCart, focusScanner]
  );

  // Global USB HID barcode scanner capture (works even if focus leaves the input)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (paymentModalOpen || weightProduct || quickModalOpen) return;
      const target = e.target as HTMLElement | null;
      if (target === barcodeFieldRef.current) return;
      const isInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (isInput) return;

      const now = Date.now();
      if (now - scanBufferRef.current.lastTime > 120) {
        scanBufferRef.current.buf = '';
      }
      scanBufferRef.current.lastTime = now;

      if (e.key === 'Enter' && scanBufferRef.current.buf.length >= 4) {
        e.preventDefault();
        const code = scanBufferRef.current.buf;
        scanBufferRef.current.buf = '';
        handleScanCode(code);
        return;
      }
      if (/^[0-9]$/.test(e.key)) {
        scanBufferRef.current.buf += e.key;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleScanCode, paymentModalOpen, weightProduct, quickModalOpen]);

  // Group quick items into category folders (Хлеб, Лепёшки, Напитки, Жвачки, etc.)
  const quickCategoryGroups = useMemo(() => {
    const map = new Map<string, Product[]>();
    for (const baseCat of DEFAULT_CATEGORY_ORDER) {
      map.set(baseCat, []);
    }

    const quickCandidates = products.filter(
      (p) => p.isQuickItem || !p.barcode || Boolean(p.quickCategory)
    );

    for (const p of quickCandidates) {
      const cat = resolveQuickCategory(p);
      const list = map.get(cat) || [];
      list.push(p);
      map.set(cat, list);
    }

    return Array.from(map.entries())
      .map(([name, items]) => ({
        name,
        items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
      }))
      .sort((a, b) => {
        const ia = DEFAULT_CATEGORY_ORDER.indexOf(a.name);
        const ib = DEFAULT_CATEGORY_ORDER.indexOf(b.name);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.name.localeCompare(b.name, 'ru');
      });
  }, [products]);

  const activeCategoryItems = useMemo(() => {
    if (!selectedQuickCategory) return [];
    const found = quickCategoryGroups.find((g) => g.name === selectedQuickCategory);
    return found ? found.items : [];
  }, [quickCategoryGroups, selectedQuickCategory]);

  const openQuickProductModal = (categoryName?: string) => {
    const targetCat = categoryName || selectedQuickCategory || DEFAULT_QUICK_CATEGORIES[0];
    setQpName('');
    setQpPrice('');
    setQpCategory(targetCat);
    const isWeightedCat = targetCat === 'Весовые';
    setQpWeighted(isWeightedCat);
    setQpUnit(isWeightedCat ? 'кг' : 'шт');
    setQpPlu(isWeightedCat ? generateNextPluCode(products) : '');
    setQpImageUrl('');
    setQpImageError('');
    setQuickModalOpen(true);
  };

  const handleQuickImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setQpImageError('');
    if (!file) return;
    try {
      const compressed = await compressProductImageFile(file);
      setQpImageUrl(compressed);
    } catch (err) {
      setQpImageError(err instanceof Error ? err.message : 'Ошибка загрузки изображения');
    } finally {
      e.target.value = '';
    }
  };

  const handleSaveQuickProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = qpName.trim().slice(0, 160);
    const price = Math.max(0, Math.round((Number(qpPrice) || 0) * 100) / 100);
    const cleanQuickCat = (qpCategory.trim() || DEFAULT_QUICK_CATEGORIES[0]).slice(0, 80);
    if (!cleanName || price <= 0) {
      setQpImageError('Укажите наименование и цену больше 0 смн.');
      return;
    }

    const normalizedPlu = qpPlu.trim()
      ? normalizePluCode(qpPlu)
      : qpWeighted
      ? generateNextPluCode(products)
      : '';

    const mappedStoreCategory =
      cleanQuickCat === 'Хлеб' || cleanQuickCat === 'Лепёшки'
        ? 'Выпечка'
        : cleanQuickCat === 'Напитки'
        ? 'Напитки'
        : cleanQuickCat === 'Жвачки'
        ? 'Кондитерка'
        : cleanQuickCat === 'Пакеты и хозтовары'
        ? 'Хозтовары'
        : cleanQuickCat === 'Весовые'
        ? 'Овощи и фрукты'
        : 'Бакалея';

    const newProduct: Product = {
      id: createSafeId('prod'),
      name: cleanName,
      barcode: qpWeighted && normalizedPlu ? buildWeightedBarcodeSample(normalizedPlu, 500) : '',
      pluCode: normalizedPlu,
      category: mappedStoreCategory,
      quickCategory: cleanQuickCat,
      unit: qpWeighted ? 'кг' : qpUnit,
      isWeighted: qpWeighted,
      isQuickItem: true,
      retailPrice: price,
      costPrice: Math.round(price * 0.72 * 100) / 100,
      stock: 50,
      minStock: 10,
      expiryDate: '',
      supplierName: '',
      imageUrl: qpImageUrl,
      activeOnline: true,
      updatedAt: new Date().toISOString(),
    };

    setQpSaving(true);
    try {
      await onProductSaved?.(newProduct);
      setSelectedQuickCategory(cleanQuickCat);
      setQuickModalOpen(false);
      setStatusNotice({
        type: 'ok',
        text: `Товар «${newProduct.name}» добавлен в категорию «${cleanQuickCat}».`,
      });

      if (newProduct.isWeighted && newProduct.pluCode) {
        const res = await syncWeightedProductsToScales([newProduct]);
        setScaleToast({
          ok: res.ok,
          text: res.message,
          retryProduct: res.ok ? undefined : newProduct,
        });
      }
      focusScanner();
    } finally {
      setQpSaving(false);
    }
  };

  const sampleScannerCodes = useMemo(() => {
    const standard = products
      .filter((p) => p.barcode && p.barcode.length >= 8 && !p.isWeighted)
      .slice(0, 2)
      .map((p) => ({
        id: p.id,
        code: p.barcode || '',
        label: `${p.barcode} (${p.name.split(' ')[0]})`,
      }));
    const weighted = products.find((p) => p.isWeighted && p.pluCode);
    if (weighted && weighted.pluCode) {
      const plu6 = normalizePluCode(weighted.pluCode);
      const sampleCode = buildWeightedBarcodeSample(plu6, 750);
      standard.push({
        id: `${weighted.id}_w`,
        code: sampleCode,
        label: `${sampleCode} (PLU ${plu6} · 0.75кг)`,
      });
    }
    return standard;
  }, [products]);

  const cartTotal = useMemo(
    () => Math.round(cart.reduce((acc, i) => acc + i.lineTotal, 0) * 100) / 100,
    [cart]
  );

  const totalItemsCount = useMemo(
    () =>
      Math.round(
        cart.reduce((acc, i) => acc + (i.isWeighted ? 1 : i.quantity), 0) * 100
      ) / 100,
    [cart]
  );

  const handleQuickProductClick = (product: Product) => {
    if (product.isWeighted) {
      setWeightProduct(product);
      setManualWeightKg('0.500');
    } else {
      addProductToCart(product, 1);
    }
  };

  const handleRemoveCartItem = (item: CartItem) => {
    setCart((prev) => prev.filter((i) => i.productId !== item.productId));
    void writeHiddenSecurityLog(
      'remove_cart_item',
      `Удалена позиция из чека: ${item.name} (${item.quantity} ${item.unit})`,
      item.lineTotal
    );
    focusScanner();
  };

  const handleUpdateCartQty = (item: CartItem, delta: number) => {
    const nextQty = Math.round((item.quantity + delta) * 1000) / 1000;
    if (nextQty <= 0) {
      handleRemoveCartItem(item);
      return;
    }
    if (delta < 0) {
      void writeHiddenSecurityLog(
        'remove_cart_item',
        `Уменьшено количество в чеке: ${item.name} (на ${Math.abs(delta)} ${item.unit})`,
        Math.round(Math.abs(delta) * item.unitPrice * 100) / 100
      );
    }
    setCart((prev) =>
      prev.map((i) =>
        i.productId === item.productId
          ? {
              ...i,
              quantity: nextQty,
              lineTotal: Math.round(nextQty * i.unitPrice * 100) / 100,
            }
          : i
      )
    );
    focusScanner();
  };

  const handleClearReceipt = () => {
    if (cart.length === 0) return;
    void writeHiddenSecurityLog(
      'cancel_receipt',
      `Отменен открытый чек (${cart.length} поз.) на сумму ${formatMoney(cartTotal)}`,
      cartTotal
    );
    setCart([]);
    setLastAddedItem(null);
    setStatusNotice({ type: 'err', text: 'Текущий чек очищен.' });
    focusScanner();
  };

  const openPaymentModal = () => {
    if (cart.length === 0) return;
    setPayMode('cash');
    setCashTendered(String(Math.ceil(cartTotal)));
    setPaymentModalOpen(true);
  };

  const numericCashTendered = Number(cashTendered) || 0;
  const changeAmount = Math.max(0, Math.round((numericCashTendered - cartTotal) * 100) / 100);
  const cashInsufficient = payMode === 'cash' && numericCashTendered < cartTotal;

  const handleCompleteSale = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (cart.length === 0 || processingSale) return;
    if (payMode === 'cash' && numericCashTendered < cartTotal) {
      setStatusNotice({
        type: 'err',
        text: 'Сумма наличных меньше итога чека.',
      });
      return;
    }

    setProcessingSale(true);
    const nowIso = new Date().toISOString();
    const saleId = createSafeId('sale');
    const costTotal =
      Math.round(cart.reduce((acc, i) => acc + i.costPrice * i.quantity, 0) * 100) / 100;
    const cashAmount = payMode === 'cash' ? cartTotal : 0;
    const cardAmount = payMode === 'card' ? cartTotal : 0;

    const saleRecord: Sale = {
      id: saleId,
      receiptNumber: `ЧК-${Date.now().toString().slice(-6)}`,
      type: 'sale',
      channel: 'pos',
      ...(activeShift ? { shiftId: activeShift.id } : {}),
      cashierId: user.uid,
      cashierName: user.displayName,
      items: cart.map((i) => ({
        productId: i.productId,
        name: i.name,
        category: products.find((p) => p.id === i.productId)?.category || 'Прочее',
        unit: i.unit,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        costPrice: i.costPrice,
        lineTotal: i.lineTotal,
      })),
      totalAmount: cartTotal,
      costTotal,
      cashAmount,
      cardAmount,
      qrAmount: 0,
      paymentMethod: payMode,
      syncedFromOffline: !effectiveOnline || !canWriteCloud,
      createdAt: nowIso,
    };

    const stockDeltas = cart.map((i) => ({ productId: i.productId, delta: -i.quantity }));

    try {
      if (!effectiveOnline || !canWriteCloud) {
        if (!effectiveOnline) {
          const updatedQueue = enqueueOfflineSale({
            sale: saleRecord,
            stockDeltas,
            queuedAt: nowIso,
          });
          setOfflineQueue(updatedQueue);
        }
        onLocalStockAdjust(stockDeltas);
        onLocalSaleRecorded?.(saleRecord);
        setCart([]);
        setLastAddedItem(null);
        setPaymentModalOpen(false);
        setStatusNotice({
          type: 'ok',
          text:
            payMode === 'cash'
              ? `Чек ${saleRecord.receiptNumber} закрыт (${formatMoney(cartTotal)}) · Сдача: ${formatMoney(changeAmount)}`
              : `Чек ${saleRecord.receiptNumber} оплачен картой (${formatMoney(cartTotal)})`,
        });
        focusScanner();
        return;
      }

      const batch = writeBatch(db);
      batch.set(doc(db, 'sales', saleId), saleRecord);

      for (const item of cart) {
        const prod = products.find((p) => p.id === item.productId);
        if (prod) {
          const nextStock = Math.max(0, Math.round((prod.stock - item.quantity) * 1000) / 1000);
          batch.update(doc(db, 'products', prod.id), {
            stock: nextStock,
            updatedAt: nowIso,
          });
        }
      }

      if (activeShift) {
        const nextCashSales = Math.round((activeShift.cashSalesTotal + cashAmount) * 100) / 100;
        const nextCardSales = Math.round((activeShift.cardSalesTotal + cardAmount) * 100) / 100;
        const nextExpected =
          Math.round(
            (activeShift.openingCash +
              nextCashSales +
              activeShift.cashInTotal -
              activeShift.cashOutTotal -
              activeShift.returnsTotal) *
              100
          ) / 100;

        batch.update(doc(db, 'shifts', activeShift.id), {
          cashSalesTotal: nextCashSales,
          cardSalesTotal: nextCardSales,
          expectedCash: nextExpected,
        });
      }

      await batch.commit();
      onLocalSaleRecorded?.(saleRecord);
      setCart([]);
      setLastAddedItem(null);
      setPaymentModalOpen(false);
      setStatusNotice({
        type: 'ok',
        text:
          payMode === 'cash'
            ? `Чек ${saleRecord.receiptNumber} закрыт (${formatMoney(cartTotal)}) · Сдача: ${formatMoney(changeAmount)}`
            : `Чек ${saleRecord.receiptNumber} оплачен картой (${formatMoney(cartTotal)})`,
      });
      focusScanner();
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'sales');
    } finally {
      setProcessingSale(false);
    }
  };

  return (
    <div
      className={`flex flex-col bg-slate-50 ${
        isCashierFullscreen
          ? 'min-h-screen'
          : 'min-h-[calc(100vh-8rem)] border border-slate-200 rounded-2xl overflow-hidden'
      }`}
    >
      {/* Minimalist Full-Screen Cashier Top Bar (STRICTLY no admin tabs or reports) */}
      {isCashierFullscreen && (
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 h-14 flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span className="text-base font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0">
              FreshMart Pro Imon
            </span>
            <span className="text-slate-300">·</span>
            <span className="text-sm font-medium text-slate-600 whitespace-nowrap shrink-0">
              Касса (POS)
            </span>
            <span className="hidden sm:inline text-slate-300">·</span>
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap shrink-0">
              {effectiveOnline ? (
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <Wifi className="w-3.5 h-3.5" />
                  Онлайн
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-amber-700">
                  <WifiOff className="w-3.5 h-3.5" />
                  Офлайн
                </span>
              )}
            </span>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {offlineQueue.length > 0 && canWriteCloud && (
              <button
                type="button"
                onClick={() => void syncOfflineReceipts()}
                disabled={!effectiveOnline || syncingQueue}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncingQueue ? 'animate-spin' : ''}`} />
                Синхронизация ({offlineQueue.length})
              </button>
            )}
            <button
              type="button"
              onClick={onExitShift}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-slate-800 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Выйти / Сменить смену
            </button>
          </div>
        </header>
      )}

      {/* BAND 1: Quick Goods — Category Folders & Product Photo Tiles */}
      <section className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 shrink-0 space-y-2.5">
        {selectedQuickCategory === null ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs text-slate-500">
                <span className="font-semibold text-slate-700">Быстрые товары</span>
                <span>·</span>
                <span>Выберите категорию</span>
              </div>
              <div className="flex items-center gap-3">
                {!isCashierFullscreen && offlineQueue.length > 0 && canWriteCloud && (
                  <button
                    type="button"
                    onClick={() => void syncOfflineReceipts()}
                    disabled={!effectiveOnline || syncingQueue}
                    className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700 hover:underline disabled:opacity-50 whitespace-nowrap"
                  >
                    <RefreshCw className={`w-3 h-3 ${syncingQueue ? 'animate-spin' : ''}`} />
                    Синхронизировать офлайн-чеки ({offlineQueue.length})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => openQuickProductModal()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Добавить товар
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {quickCategoryGroups.map((group) => (
                <button
                  key={group.name}
                  type="button"
                  onClick={() => {
                    setSelectedQuickCategory(group.name);
                    focusScanner();
                  }}
                  className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-400 active:scale-[0.98] transition-all whitespace-nowrap shrink-0"
                >
                  <Folder className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span className="text-sm font-semibold text-slate-900">{group.name}</span>
                  <span className="text-xs font-mono text-slate-500 tabular-nums">
                    · {group.items.length}
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedQuickCategory(null);
                    focusScanner();
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  Назад к категориям
                </button>
                <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900 min-w-0">
                  <FolderOpen className="w-4 h-4 text-emerald-700 shrink-0" />
                  <span className="truncate">{selectedQuickCategory}</span>
                  <span className="text-xs font-mono font-normal text-slate-500 tabular-nums shrink-0">
                    · {activeCategoryItems.length}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => openQuickProductModal(selectedQuickCategory)}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                Добавить товар
              </button>
            </div>

            {activeCategoryItems.length === 0 ? (
              <div className="py-5 px-4 rounded-xl border border-dashed border-slate-200 bg-slate-50/70 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-500">
                <span>В категории «{selectedQuickCategory}» пока нет товаров.</span>
                <button
                  type="button"
                  onClick={() => openQuickProductModal(selectedQuickCategory)}
                  className="font-semibold text-emerald-700 hover:underline whitespace-nowrap"
                >
                  + Добавить первый товар
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-6 gap-2.5 max-h-52 overflow-y-auto pr-0.5">
                {activeCategoryItems.map((item) => {
                  const hasValidImage = Boolean(item.imageUrl && !failedImages[item.id]);
                  const inCartItem = cart.find((c) => c.productId === item.id);
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => handleQuickProductClick(item)}
                      className={`group text-left rounded-xl border bg-white overflow-hidden flex flex-col transition-all active:scale-[0.98] ${
                        inCartItem
                          ? 'border-emerald-500 bg-emerald-50/30'
                          : 'border-slate-200 hover:border-emerald-400 hover:bg-slate-50/60'
                      }`}
                    >
                      <div className="h-20 w-full bg-slate-100 relative overflow-hidden flex items-center justify-center shrink-0">
                        {hasValidImage ? (
                          <img
                            src={item.imageUrl}
                            alt={item.name}
                            referrerPolicy="no-referrer"
                            onError={() =>
                              setFailedImages((prev) => ({ ...prev, [item.id]: true }))
                            }
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-150"
                          />
                        ) : (
                          <div className="flex flex-col items-center justify-center text-slate-400">
                            {item.isWeighted ? (
                              <Scale className="w-6 h-6" />
                            ) : (
                              <Package className="w-6 h-6" />
                            )}
                          </div>
                        )}
                        {inCartItem && (
                          <span className="absolute top-1.5 right-1.5 px-1.5 py-0.5 rounded-md bg-emerald-600 text-white font-mono text-[11px] font-bold tabular-nums">
                            ×{inCartItem.quantity}
                          </span>
                        )}
                      </div>
                      <div className="p-2 flex-1 flex flex-col justify-between gap-1">
                        <div className="text-xs font-semibold text-slate-900 leading-snug line-clamp-2">
                          {item.name}
                        </div>
                        <div className="flex items-center justify-between gap-1 text-[11px] font-mono tabular-nums">
                          <span className="font-bold text-emerald-700">
                            {formatMoney(item.retailPrice)}
                          </span>
                          <span className="text-slate-400">/{item.unit}</span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>

      {/* BAND 2: Active Auto-Focused Barcode Scanner Field */}
      <section className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3 shrink-0 space-y-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!barcodeInput.trim()) return;
            handleScanCode(barcodeInput);
            setBarcodeInput('');
          }}
          className="flex items-center gap-2.5"
        >
          <div className="relative flex-1">
            <Barcode className="w-5 h-5 text-emerald-600 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              ref={barcodeFieldRef}
              type="text"
              autoFocus
              value={barcodeInput}
              onChange={(e) => setBarcodeInput(e.target.value)}
              placeholder="Сканер штрихкода активен (EAN-13 / весовой 6-значный PLU) — сканируйте или введите код..."
              className="w-full pl-11 pr-4 py-3 text-base font-mono bg-slate-50 border-2 border-slate-300 rounded-xl focus:outline-none focus:border-emerald-600 focus:bg-white transition-colors"
            />
          </div>
          <button
            type="submit"
            className="px-5 py-3 text-sm font-semibold text-white bg-slate-900 rounded-xl hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            Добавить
          </button>
        </form>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          {sampleScannerCodes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 text-slate-500">
              <span>Быстрая проверка сканера:</span>
              {sampleScannerCodes.map((sample, idx) => (
                <React.Fragment key={sample.id}>
                  {idx > 0 && <span className="text-slate-300">·</span>}
                  <button
                    type="button"
                    onClick={() => handleScanCode(sample.code)}
                    className="font-mono text-slate-700 hover:text-emerald-700 underline underline-offset-2"
                  >
                    {sample.label}
                  </button>
                </React.Fragment>
              ))}
            </div>
          )}

          {statusNotice && (
            <div
              className={`font-medium flex items-center gap-1.5 ${
                statusNotice.type === 'ok' ? 'text-emerald-700' : 'text-red-700'
              }`}
            >
              {statusNotice.type === 'ok' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
              <span>{statusNotice.text}</span>
            </div>
          )}
        </div>
      </section>

      {/* BAND 3 (CENTER): Current Receipt ONLY */}
      <section className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
        <div className="max-w-5xl mx-auto bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col min-h-[260px]">
          <div className="px-5 py-3 border-b border-slate-200 flex items-center justify-between gap-4 bg-slate-50/70">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
              <span>Текущий чек</span>
              <span className="text-slate-300">·</span>
              <span className="text-xs font-normal text-slate-500 font-mono tabular-nums">
                Позиций: {cart.length} ({totalItemsCount} ед.)
              </span>
            </div>
            {cart.length > 0 && (
              <button
                type="button"
                onClick={handleClearReceipt}
                className="text-xs font-medium text-red-600 hover:text-red-700 underline underline-offset-2 whitespace-nowrap"
              >
                Очистить чек
              </button>
            )}
          </div>

          {cart.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 px-6 text-center">
              <Barcode className="w-10 h-10 text-slate-300 mb-3" />
              <div className="text-base font-semibold text-slate-700">Чек пуст</div>
              <p className="text-sm text-slate-500 mt-1 max-w-md">
                Отсканируйте штрихкод товара или выберите категорию в блоке «Быстрые товары» выше.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500 bg-white">
                    <th className="py-2.5 pl-5 pr-2 w-10">#</th>
                    <th className="py-2.5 px-3">Наименование</th>
                    <th className="py-2.5 px-3 text-center">Количество</th>
                    <th className="py-2.5 px-3 text-right">Цена</th>
                    <th className="py-2.5 px-3 text-right">Сумма</th>
                    <th className="py-2.5 pl-2 pr-5 text-right w-14">Удал.</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {cart.map((item, idx) => {
                    const isLast = lastAddedItem?.name === item.name;
                    return (
                      <tr
                        key={item.productId}
                        className={isLast ? 'bg-emerald-50/50' : 'hover:bg-slate-50/70'}
                      >
                        <td className="py-3 pl-5 pr-2 font-mono text-xs text-slate-400 tabular-nums">
                          {idx + 1}
                        </td>
                        <td className="py-3 px-3 font-medium text-slate-900">{item.name}</td>
                        <td className="py-3 px-3">
                          <div className="flex items-center justify-center gap-2">
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCartQty(item, item.isWeighted ? -0.1 : -1)
                              }
                              aria-label="Уменьшить количество"
                              className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center text-slate-700"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                            <span className="font-mono font-semibold text-slate-900 min-w-[68px] text-center tabular-nums">
                              {item.quantity} {item.unit}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateCartQty(item, item.isWeighted ? 0.1 : 1)
                              }
                              aria-label="Увеличить количество"
                              className="w-8 h-8 rounded-lg border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center text-slate-700"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                        <td className="py-3 px-3 font-mono text-right text-slate-600 tabular-nums whitespace-nowrap">
                          {formatMoney(item.unitPrice)}
                        </td>
                        <td className="py-3 px-3 font-mono font-bold text-right text-slate-900 tabular-nums whitespace-nowrap">
                          {formatMoney(item.lineTotal)}
                        </td>
                        <td className="py-3 pl-2 pr-5 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoveCartItem(item)}
                            aria-label="Удалить позицию"
                            className="p-2 text-slate-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* BAND 4 (BOTTOM): Prominent Last Item + Grand Total + Close Receipt CTA */}
      <footer className="bg-slate-900 text-white border-t border-slate-800 px-4 sm:px-6 py-4 shrink-0">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-xs text-slate-400">Последний добавленный товар</div>
            {lastAddedItem ? (
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <div className="text-xl sm:text-2xl font-bold text-white truncate max-w-full">
                  {lastAddedItem.name}
                </div>
                <div className="font-mono text-sm text-emerald-300 tabular-nums whitespace-nowrap">
                  +{lastAddedItem.quantity} {lastAddedItem.unit} ·{' '}
                  {formatMoney(lastAddedItem.unitPrice)}
                </div>
              </div>
            ) : (
              <div className="text-lg font-medium text-slate-500 mt-0.5">
                Ожидание сканирования...
              </div>
            )}
          </div>

          <div className="flex flex-wrap sm:flex-nowrap items-center justify-between md:justify-end gap-5 shrink-0">
            <div className="text-left sm:text-right">
              <div className="text-xs text-slate-400">Общий итог</div>
              <div className="font-mono text-3xl sm:text-4xl font-bold text-emerald-400 tabular-nums leading-tight">
                {formatMoney(cartTotal)}
              </div>
            </div>

            <button
              type="button"
              disabled={cart.length === 0}
              onClick={openPaymentModal}
              className="px-7 py-4 text-base sm:text-lg font-bold text-slate-950 bg-emerald-400 hover:bg-emerald-300 rounded-xl disabled:opacity-35 disabled:hover:bg-emerald-400 transition-colors whitespace-nowrap shrink-0"
            >
              Оплатить / Закрыть чек
            </button>
          </div>
        </div>
      </footer>

      {/* Modal: Add Quick Product into Category */}
      {quickModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={handleSaveQuickProduct}
            className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-base font-bold text-slate-900">
                Новый товар в быстрые категории
              </h3>
              <button
                type="button"
                onClick={() => {
                  setQuickModalOpen(false);
                  focusScanner();
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Категория быстрых товаров
              </label>
              <input
                type="text"
                list="pos-quick-categories-list"
                required
                value={qpCategory}
                onChange={(e) => setQpCategory(e.target.value)}
                placeholder="Например: Хлеб, Лепёшки, Напитки, Жвачки"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
              <datalist id="pos-quick-categories-list">
                {quickCategoryGroups.map((g) => (
                  <option key={g.name} value={g.name} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Название товара
              </label>
              <input
                type="text"
                required
                autoFocus
                value={qpName}
                onChange={(e) => setQpName(e.target.value)}
                placeholder="Например: Батон нарезной 400г"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Цена продажи (смн)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0.01"
                  required
                  value={qpPrice}
                  onChange={(e) => setQpPrice(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ед. изм.</label>
                <select
                  value={qpWeighted ? 'кг' : qpUnit}
                  disabled={qpWeighted}
                  onChange={(e) => setQpUnit(e.target.value as ProductUnit)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white disabled:bg-slate-100"
                >
                  <option value="шт">шт</option>
                  <option value="кг">кг</option>
                  <option value="л">л</option>
                  <option value="уп">уп</option>
                </select>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <label className="inline-flex items-center gap-2 text-xs font-medium text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={qpWeighted}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setQpWeighted(checked);
                    if (checked) {
                      setQpUnit('кг');
                      if (!qpPlu.trim()) setQpPlu(generateNextPluCode(products));
                    }
                  }}
                />
                Весовой товар (автосинхронизация с весами по 6-значному PLU)
              </label>

              {qpWeighted && (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={qpPlu}
                    onChange={(e) => setQpPlu(e.target.value.replace(/\D+/g, '').slice(0, 6))}
                    onBlur={() => {
                      if (qpPlu.trim()) setQpPlu(normalizePluCode(qpPlu));
                    }}
                    placeholder="000105"
                    className="flex-1 px-3 py-1.5 font-mono text-sm bg-white border border-slate-300 rounded-lg"
                  />
                  <button
                    type="button"
                    onClick={() => setQpPlu(generateNextPluCode(products))}
                    className="px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap"
                  >
                    Авто PLU
                  </button>
                </div>
              )}
            </div>

            {/* Product Photo Upload */}
            <div className="space-y-2">
              <label className="block text-xs font-medium text-slate-700">
                Фотография товара (опционально)
              </label>
              <div className="flex items-center gap-3">
                <div className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-100 overflow-hidden flex items-center justify-center shrink-0">
                  {qpImageUrl ? (
                    <img
                      src={qpImageUrl}
                      alt="Превью товара"
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <Package className="w-6 h-6 text-slate-400" />
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 cursor-pointer">
                    <ImagePlus className="w-3.5 h-3.5 text-emerald-700" />
                    {qpImageUrl ? 'Заменить фото' : 'Загрузить фото'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleQuickImageUpload}
                      className="hidden"
                    />
                  </label>
                  {qpImageUrl && (
                    <button
                      type="button"
                      onClick={() => setQpImageUrl('')}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Убрать
                    </button>
                  )}
                </div>
              </div>
              {qpImageError && <p className="text-xs text-red-600">{qpImageError}</p>}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => {
                  setQuickModalOpen(false);
                  focusScanner();
                }}
                className="px-4 py-2 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={qpSaving}
                className="px-5 py-2 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                {qpSaving ? 'Сохранение...' : 'Сохранить товар'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Compact Modal: Weighted Product Manual Weight */}
      {weightProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-sm bg-white border border-slate-200 rounded-2xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Вес товара (кг)</h3>
              <button
                type="button"
                onClick={() => {
                  setWeightProduct(null);
                  focusScanner();
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="text-sm text-slate-700">
              {weightProduct.name} ·{' '}
              <span className="font-mono font-semibold">
                {formatMoney(weightProduct.retailPrice)}/кг
              </span>
              {weightProduct.pluCode && (
                <div className="text-xs font-mono text-slate-500 mt-0.5">
                  PLU {normalizePluCode(weightProduct.pluCode)}
                </div>
              )}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const kg = Number(manualWeightKg) || 0;
                if (kg > 0) {
                  addProductToCart(weightProduct, kg);
                  setWeightProduct(null);
                }
              }}
              className="space-y-4"
            >
              <input
                type="number"
                step="0.005"
                min="0.005"
                autoFocus
                value={manualWeightKg}
                onChange={(e) => setManualWeightKg(e.target.value)}
                className="w-full px-4 py-3 text-xl font-mono font-bold border border-slate-300 rounded-xl"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setWeightProduct(null);
                    focusScanner();
                  }}
                  className="px-4 py-2 text-sm font-medium text-slate-600 border border-slate-300 rounded-lg"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                >
                  В чек
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Checkout Modal: Cash / Card + Change Calculator */}
      {paymentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={handleCompleteSale}
            className="w-full max-w-md bg-white border border-slate-200 rounded-2xl p-6 space-y-5"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-900">Оплата и закрытие чека</h3>
              <button
                type="button"
                onClick={() => {
                  setPaymentModalOpen(false);
                  focusScanner();
                }}
                className="text-slate-400 hover:text-slate-700"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-slate-900 text-white flex items-baseline justify-between">
              <span className="text-sm text-slate-300">К оплате</span>
              <span className="font-mono text-3xl font-bold text-emerald-400 tabular-nums">
                {formatMoney(cartTotal)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => setPayMode('cash')}
                className={`py-3.5 px-4 rounded-xl border-2 text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                  payMode === 'cash'
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <Banknote className="w-5 h-5" />
                Наличные
              </button>
              <button
                type="button"
                onClick={() => setPayMode('card')}
                className={`py-3.5 px-4 rounded-xl border-2 text-sm font-semibold flex items-center justify-center gap-2 transition-colors ${
                  payMode === 'card'
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <CreditCard className="w-5 h-5" />
                Карта
              </button>
            </div>

            {payMode === 'cash' ? (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Получено наличными (смн)
                  </label>
                  <input
                    ref={cashInputRef}
                    type="number"
                    step="0.01"
                    min="0"
                    value={cashTendered}
                    onChange={(e) => setCashTendered(e.target.value)}
                    className="w-full px-4 py-3 text-2xl font-mono font-bold text-slate-900 bg-slate-50 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white tabular-nums"
                  />
                </div>

                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setCashTendered(String(cartTotal))}
                    className="px-3 py-1.5 text-xs font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg whitespace-nowrap"
                  >
                    Без сдачи
                  </button>
                  {[20, 50, 100, 200, 500].map((denom) => (
                    <button
                      key={denom}
                      type="button"
                      onClick={() => setCashTendered(String(denom))}
                      className="px-3 py-1.5 text-xs font-mono font-medium bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg whitespace-nowrap"
                    >
                      {denom} смн
                    </button>
                  ))}
                </div>

                <div
                  className={`p-4 rounded-xl border flex items-baseline justify-between ${
                    cashInsufficient
                      ? 'bg-red-50 border-red-200 text-red-800'
                      : 'bg-emerald-50 border-emerald-200 text-emerald-950'
                  }`}
                >
                  <span className="text-sm font-semibold">
                    {cashInsufficient ? 'Недостаточно средств' : 'Сдача покупателю'}
                  </span>
                  <span className="font-mono text-2xl font-bold tabular-nums">
                    {cashInsufficient
                      ? `-${formatMoney(Math.round((cartTotal - numericCashTendered) * 100) / 100)}`
                      : formatMoney(changeAmount)}
                  </span>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 text-sm text-slate-700">
                Оплата банковской картой на сумму{' '}
                <span className="font-mono font-bold text-slate-900">{formatMoney(cartTotal)}</span>.
                После подтверждения терминалом нажмите кнопку ниже.
              </div>
            )}

            <button
              type="submit"
              disabled={processingSale || cashInsufficient}
              className="w-full py-3.5 text-base font-bold text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl disabled:opacity-40 transition-colors"
            >
              {processingSale ? 'Закрытие чека...' : 'Подтвердить оплату и закрыть чек'}
            </button>
          </form>
        </div>
      )}

      {/* Floating Toast: Automatic Scales Sync */}
      {scaleToast && (
        <div
          role="status"
          className={`fixed bottom-24 right-5 z-50 max-w-sm rounded-xl border px-4 py-3 shadow-lg flex items-start gap-2.5 text-xs ${
            scaleToast.ok
              ? 'bg-slate-900 text-white border-slate-700'
              : 'bg-red-50 text-red-900 border-red-200'
          }`}
        >
          {scaleToast.ok ? (
            <Scale className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
          )}
          <div className="flex-1 leading-relaxed">{scaleToast.text}</div>
          {scaleToast.retryProduct && (
            <button
              type="button"
              onClick={async () => {
                const target = scaleToast.retryProduct!;
                const res = await syncWeightedProductsToScales([target]);
                setScaleToast({
                  ok: res.ok,
                  text: res.message,
                  retryProduct: res.ok ? undefined : target,
                });
              }}
              className="font-semibold underline whitespace-nowrap shrink-0"
            >
              Повторить
            </button>
          )}
          <button
            type="button"
            onClick={() => setScaleToast(null)}
            className="opacity-70 hover:opacity-100 shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
