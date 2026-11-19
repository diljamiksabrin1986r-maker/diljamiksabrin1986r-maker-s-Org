import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  Barcode,
  Calculator,
  Clock,
  CreditCard,
  PauseCircle,
  PlayCircle,
  Plus,
  Minus,
  QrCode,
  RefreshCw,
  RotateCcw,
  Scale,
  Search,
  Trash2,
  Wallet,
  Wifi,
  WifiOff,
  Lock,
  ArrowDownUp,
  CheckCircle2,
} from 'lucide-react';
import {
  doc,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { createSafeId, db, handleFirestoreError, OperationType, sha256Hex } from '../firebase';
import type {
  CartItem,
  CashMovement,
  HeldReceipt,
  OfflineSaleQueueItem,
  PosSecuritySettings,
  Product,
  Sale,
  SecurityLog,
  SecurityLogAction,
  Shift,
  StoreSettings,
  UserProfile,
} from '../types';
import { buildWeightedBarcodeSample, parseRetailBarcode } from '../utils/barcode';
import { formatMoney } from '../utils/exportReports';
import {
  enqueueOfflineSale,
  enqueueOfflineSecurityLog,
  getOfflineQueue,
  getOfflineSecurityQueue,
  loadHeldReceipts,
  saveHeldReceipts,
  saveOfflineQueue,
  saveOfflineSecurityQueue,
} from '../utils/offlineSync';

interface CashierPOSViewProps {
  user: UserProfile;
  products: Product[];
  activeShift: Shift | null;
  storeSettings: StoreSettings | null;
  posSecurity: PosSecuritySettings | null;
  isBrowserOnline: boolean;
  onLocalStockAdjust: (deltas: { productId: string; delta: number }[]) => void;
}

export const CashierPOSView: React.FC<CashierPOSViewProps> = ({
  user,
  products,
  activeShift,
  storeSettings,
  posSecurity,
  isBrowserOnline,
  onLocalStockAdjust,
}) => {
  const effectiveOnline = isBrowserOnline;

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('Все');
  const [barcodeInput, setBarcodeInput] = useState('');
  const [statusNotice, setStatusNotice] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [heldReceipts, setHeldReceipts] = useState<HeldReceipt[]>(() => loadHeldReceipts());
  const [offlineQueue, setOfflineQueue] = useState<OfflineSaleQueueItem[]>(() => getOfflineQueue());
  const [syncingQueue, setSyncingQueue] = useState(false);

  // Modals
  const [manualModalOpen, setManualModalOpen] = useState(false);
  const [manualBarcode, setManualBarcode] = useState('');
  const [weightProduct, setWeightProduct] = useState<Product | null>(null);
  const [manualWeightKg, setManualWeightKg] = useState('0.500');

  const [paymentModalOpen, setPaymentModalOpen] = useState(false);
  const [payMode, setPayMode] = useState<'cash' | 'card' | 'qr' | 'split'>('cash');
  const [cashTendered, setCashTendered] = useState('');
  const [splitCash, setSplitCash] = useState('');
  const [splitCard, setSplitCard] = useState('');
  const [splitQr, setSplitQr] = useState('');
  const [qrPaymentUrl, setQrPaymentUrl] = useState('');
  const [processingSale, setProcessingSale] = useState(false);

  const [shiftModalOpen, setShiftModalOpen] = useState(false);
  const [openingCashInput, setOpeningCashInput] = useState('5000');
  const [closingCashInput, setClosingCashInput] = useState('');
  const [cashMoveType, setCashMoveType] = useState<'in' | 'out'>('out');
  const [cashMoveAmount, setCashMoveAmount] = useState('');
  const [cashMoveReason, setCashMoveReason] = useState('');
  const [zReportResult, setZReportResult] = useState<Shift | null>(null);

  const [returnModalOpen, setReturnModalOpen] = useState(false);
  const [returnProductId, setReturnProductId] = useState('');
  const [returnQty, setReturnQty] = useState('1');
  const [returnReason, setReturnReason] = useState('Возврат от покупателя');
  const [adminPinInput, setAdminPinInput] = useState('');
  const [returnError, setReturnError] = useState('');

  const barcodeFieldRef = useRef<HTMLInputElement>(null);
  const scanBufferRef = useRef<{ buf: string; lastTime: number }>({ buf: '', lastTime: 0 });

  const writeHiddenSecurityLog = useCallback(
    async (action: SecurityLogAction, details: string, amountImpact: number, authorizedBy?: string) => {
      const logId = createSafeId('sec');
      const logEntry: SecurityLog = {
        id: logId,
        action,
        actorId: user.uid,
        actorName: user.displayName,
        actorRole: user.role,
        details: details.slice(0, 500),
        amountImpact,
        ...(authorizedBy ? { authorizedBy: authorizedBy.slice(0, 120) } : {}),
        createdAt: new Date().toISOString(),
      };

      if (!effectiveOnline) {
        enqueueOfflineSecurityLog(logEntry);
        return;
      }

      try {
        await setDoc(doc(db, 'security_logs', logId), logEntry);
      } catch {
        // Queue locally so transient disconnects never lose audit events
        enqueueOfflineSecurityLog(logEntry);
      }
    },
    [effectiveOnline, user.uid, user.displayName, user.role]
  );

  const syncOfflineSecurityLogs = useCallback(async () => {
    if (!effectiveOnline) return;
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
  }, [effectiveOnline, user.uid]);

  useEffect(() => {
    if (!effectiveOnline) return;
    syncOfflineSecurityLogs();
    const timer = window.setInterval(() => {
      syncOfflineSecurityLogs();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [effectiveOnline, syncOfflineSecurityLogs]);

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
      setStatusNotice({ type: 'ok', text: `Добавлено: ${product.name} (${cleanQty} ${product.unit})` });
    },
    []
  );

  const handleScanCode = useCallback(
    (rawCode: string) => {
      const parsed = parseRetailBarcode(rawCode, products);
      if (!parsed.matchedProduct) {
        setStatusNotice({
          type: 'err',
          text: `Штрихкод «${parsed.rawCode}» не найден в базе. Проверьте код или выберите товар вручную.`,
        });
        return;
      }
      if (parsed.matchedProduct.isWeighted && !parsed.isWeightedBarcode) {
        setWeightProduct(parsed.matchedProduct);
        setManualWeightKg('0.500');
        return;
      }
      addProductToCart(parsed.matchedProduct, parsed.quantity, parsed.overrideLineTotal);
    },
    [products, addProductToCart]
  );

  // Global USB HID barcode scanner capture
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isInput =
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
      if (isInput && target !== barcodeFieldRef.current) return;
      if (target === barcodeFieldRef.current) return;

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
  }, [handleScanCode]);

  const syncOfflineReceipts = useCallback(async () => {
    const queue = getOfflineQueue();
    if (queue.length === 0 || !effectiveOnline) return;
    setSyncingQueue(true);
    try {
      const remaining: OfflineSaleQueueItem[] = [];
      for (const item of queue) {
        try {
          const batch = writeBatch(db);
          const syncedSale: Sale = { ...item.sale, syncedFromOffline: true };
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
        setStatusNotice({ type: 'ok', text: 'Офлайн-чеки успешно синхронизированы с базой.' });
      }
    } finally {
      setSyncingQueue(false);
    }
  }, [effectiveOnline, products]);

  // Auto-sync when returning online
  useEffect(() => {
    if (effectiveOnline && offlineQueue.length > 0) {
      syncOfflineReceipts();
    }
  }, [effectiveOnline, offlineQueue.length, syncOfflineReceipts]);

  const cartTotal = useMemo(
    () => Math.round(cart.reduce((acc, i) => acc + i.lineTotal, 0) * 100) / 100,
    [cart]
  );

  useEffect(() => {
    if (!paymentModalOpen || (payMode !== 'qr' && payMode !== 'split')) return;
    const qrSum = payMode === 'qr' ? cartTotal : Number(splitQr) || 0;
    const merchant = storeSettings?.qrMerchantId || 'FRESHMART-SBP-001';
    const payload = `ST00012|Name=${storeSettings?.storeName || 'FreshMart'}|PersonalAcc=${merchant}|Sum=${Math.round(qrSum * 100)}|Purpose=Oplata_cheka`;
    QRCode.toDataURL(payload, { width: 220, margin: 1 })
      .then(setQrPaymentUrl)
      .catch(() => setQrPaymentUrl(''));
  }, [paymentModalOpen, payMode, cartTotal, splitQr, storeSettings]);

  const categories = useMemo(() => {
    const set = new Set(products.map((p) => p.category));
    return ['Все', ...Array.from(set)];
  }, [products]);

  const quickItems = useMemo(
    () => products.filter((p) => p.isQuickItem || !p.barcode),
    [products]
  );

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return products.filter((p) => {
      if (selectedCategory !== 'Все' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.barcode || '').includes(q) ||
        (p.pluCode || '').includes(q)
      );
    });
  }, [products, selectedCategory, searchQuery]);

  const handleProductTileClick = (product: Product) => {
    if (product.isWeighted) {
      setWeightProduct(product);
      setManualWeightKg('0.500');
    } else {
      addProductToCart(product, 1);
    }
  };

  const handleRemoveCartItem = (item: CartItem) => {
    setCart((prev) => prev.filter((i) => i.productId !== item.productId));
    writeHiddenSecurityLog(
      'remove_cart_item',
      `Удалена позиция из открытого чека: ${item.name} (${item.quantity} ${item.unit})`,
      item.lineTotal
    );
  };

  const handleUpdateCartQty = (item: CartItem, delta: number) => {
    const nextQty = Math.round((item.quantity + delta) * 1000) / 1000;
    if (nextQty <= 0) {
      handleRemoveCartItem(item);
      return;
    }
    if (delta < 0) {
      writeHiddenSecurityLog(
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
  };

  const handleCancelReceipt = () => {
    if (cart.length === 0) return;
    writeHiddenSecurityLog(
      'cancel_receipt',
      `Отменен открытый чек (${cart.length} поз.) на сумму ${formatMoney(cartTotal)}`,
      cartTotal
    );
    setCart([]);
    setStatusNotice({ type: 'err', text: 'Текущий чек очищен.' });
  };

  const handleHoldReceipt = () => {
    if (cart.length === 0) return;
    const held: HeldReceipt = {
      id: createSafeId('hold'),
      label: `Чек #${heldReceipts.length + 1} (${cart.length} поз. · ${formatMoney(cartTotal)})`,
      items: cart,
      createdAt: new Date().toISOString(),
    };
    const next = [held, ...heldReceipts];
    setHeldReceipts(next);
    saveHeldReceipts(next);
    setCart([]);
    setStatusNotice({ type: 'ok', text: 'Чек отложен. Можно обслужить следующего покупателя.' });
  };

  const handleRestoreHeld = (held: HeldReceipt) => {
    if (cart.length > 0) {
      setStatusNotice({
        type: 'err',
        text: 'Сначала завершите или отложите текущий активный чек.',
      });
      return;
    }
    setCart(held.items);
    const next = heldReceipts.filter((h) => h.id !== held.id);
    setHeldReceipts(next);
    saveHeldReceipts(next);
  };

  const openPaymentModal = () => {
    if (cart.length === 0) return;
    if (!activeShift) {
      setShiftModalOpen(true);
      setStatusNotice({ type: 'err', text: 'Откройте кассовую смену перед оформлением продажи.' });
      return;
    }
    setPayMode('cash');
    setCashTendered(String(Math.ceil(cartTotal)));
    setSplitCash(String(Math.floor(cartTotal / 2)));
    setSplitCard(String(Math.round((cartTotal - Math.floor(cartTotal / 2)) * 100) / 100));
    setSplitQr('0');
    setPaymentModalOpen(true);
  };

  const handleCompleteSale = async () => {
    if (cart.length === 0 || !activeShift) return;

    let cashAmount = 0;
    let cardAmount = 0;
    let qrAmount = 0;

    if (payMode === 'cash') {
      const tendered = Number(cashTendered) || 0;
      if (tendered < cartTotal) {
        setStatusNotice({ type: 'err', text: 'Полученная сумма наличных меньше суммы чека.' });
        return;
      }
      cashAmount = cartTotal;
    } else if (payMode === 'card') {
      cardAmount = cartTotal;
    } else if (payMode === 'qr') {
      qrAmount = cartTotal;
    } else {
      cashAmount = Number(splitCash) || 0;
      cardAmount = Number(splitCard) || 0;
      qrAmount = Number(splitQr) || 0;
      const sum = Math.round((cashAmount + cardAmount + qrAmount) * 100) / 100;
      if (Math.abs(sum - cartTotal) > 0.05) {
        setStatusNotice({
          type: 'err',
          text: `Сумма раздельной оплаты (${formatMoney(sum)}) должна равняться итогу чека (${formatMoney(cartTotal)}).`,
        });
        return;
      }
    }

    setProcessingSale(true);
    try {
      const saleId = createSafeId('sale');
      const costTotal =
        Math.round(cart.reduce((acc, i) => acc + i.costPrice * i.quantity, 0) * 100) / 100;
      const saleRecord: Sale = {
        id: saleId,
        receiptNumber: `ЧК-${Date.now().toString().slice(-6)}`,
        type: 'sale',
        channel: 'pos',
        shiftId: activeShift.id,
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
        qrAmount,
        paymentMethod: payMode,
        syncedFromOffline: !effectiveOnline,
        createdAt: new Date().toISOString(),
      };

      const stockDeltas = cart.map((i) => ({ productId: i.productId, delta: -i.quantity }));

      if (!effectiveOnline) {
        const updatedQueue = enqueueOfflineSale({
          sale: saleRecord,
          stockDeltas,
          queuedAt: new Date().toISOString(),
        });
        setOfflineQueue(updatedQueue);
        onLocalStockAdjust(stockDeltas);
        setCart([]);
        setPaymentModalOpen(false);
        setStatusNotice({
          type: 'ok',
          text: `Чек ${saleRecord.receiptNumber} пробит ОФЛАЙН и поставлен в очередь синхронизации.`,
        });
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
            updatedAt: new Date().toISOString(),
          });
        }
      }

      const nextCashSales = Math.round((activeShift.cashSalesTotal + cashAmount) * 100) / 100;
      const nextCardSales = Math.round((activeShift.cardSalesTotal + cardAmount) * 100) / 100;
      const nextQrSales = Math.round((activeShift.qrSalesTotal + qrAmount) * 100) / 100;
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
        qrSalesTotal: nextQrSales,
        expectedCash: nextExpected,
      });

      await batch.commit();
      setCart([]);
      setPaymentModalOpen(false);
      setStatusNotice({
        type: 'ok',
        text: `Оплата проведена · Чек ${saleRecord.receiptNumber} (${formatMoney(cartTotal)})`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'sales');
    } finally {
      setProcessingSale(false);
    }
  };

  const handleOpenShift = async () => {
    const openingCash = Math.max(0, Number(openingCashInput) || 0);
    const shiftId = createSafeId('shift');
    const newShift: Shift = {
      id: shiftId,
      cashierId: user.uid,
      cashierName: user.displayName,
      status: 'open',
      openingCash,
      cashSalesTotal: 0,
      cardSalesTotal: 0,
      qrSalesTotal: 0,
      returnsTotal: 0,
      cashInTotal: 0,
      cashOutTotal: 0,
      expectedCash: openingCash,
      movements: [],
      openedAt: new Date().toISOString(),
    };
    try {
      await setDoc(doc(db, 'shifts', shiftId), newShift);
      setZReportResult(null);
      setShiftModalOpen(false);
      setStatusNotice({ type: 'ok', text: `Смена открыта. Наличные на начало: ${formatMoney(openingCash)}` });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, 'shifts');
    }
  };

  const handleCashMovement = async () => {
    if (!activeShift) return;
    const amt = Number(cashMoveAmount) || 0;
    if (amt <= 0 || !cashMoveReason.trim()) return;

    const movement: CashMovement = {
      id: createSafeId('mov'),
      type: cashMoveType,
      amount: amt,
      reason: cashMoveReason.trim(),
      createdAt: new Date().toISOString(),
    };

    const nextIn = cashMoveType === 'in' ? activeShift.cashInTotal + amt : activeShift.cashInTotal;
    const nextOut = cashMoveType === 'out' ? activeShift.cashOutTotal + amt : activeShift.cashOutTotal;
    const nextExpected =
      Math.round(
        (activeShift.openingCash +
          activeShift.cashSalesTotal +
          nextIn -
          nextOut -
          activeShift.returnsTotal) *
          100
      ) / 100;

    try {
      await updateDoc(doc(db, 'shifts', activeShift.id), {
        cashInTotal: nextIn,
        cashOutTotal: nextOut,
        expectedCash: nextExpected,
        movements: [...activeShift.movements, movement],
      });
      if (cashMoveType === 'out') {
        writeHiddenSecurityLog(
          'cash_out',
          `Изъятие наличных из кассы: ${cashMoveReason.trim()}`,
          amt
        );
      }
      setCashMoveAmount('');
      setCashMoveReason('');
      setStatusNotice({
        type: 'ok',
        text: `${cashMoveType === 'in' ? 'Внесено' : 'Изъято'} ${formatMoney(amt)}`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `shifts/${activeShift.id}`);
    }
  };

  const handleCloseShift = async () => {
    if (!activeShift) return;
    const actualCash = Number(closingCashInput);
    if (Number.isNaN(actualCash) || actualCash < 0) {
      setStatusNotice({ type: 'err', text: 'Укажите фактический остаток наличных в кассе.' });
      return;
    }
    const discrepancy = Math.round((actualCash - activeShift.expectedCash) * 100) / 100;
    const closedAt = new Date().toISOString();
    try {
      await updateDoc(doc(db, 'shifts', activeShift.id), {
        status: 'closed',
        actualCash,
        discrepancy,
        closedAt,
      });
      setZReportResult({
        ...activeShift,
        status: 'closed',
        actualCash,
        discrepancy,
        closedAt,
      });
      setClosingCashInput('');
      setStatusNotice({ type: 'ok', text: 'Смена закрыта. Z-отчет сформирован.' });
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `shifts/${activeShift.id}`);
    }
  };

  const handleProcessReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    setReturnError('');
    if (!activeShift) {
      setReturnError('Сначала откройте смену.');
      return;
    }
    const product = products.find((p) => p.id === returnProductId);
    const qty = Number(returnQty) || 0;
    if (!product || qty <= 0) {
      setReturnError('Выберите товар и укажите корректное количество.');
      return;
    }

    const enteredHash = await sha256Hex(adminPinInput.trim());
    const expectedHash = posSecurity?.adminPinHash || (await sha256Hex('1234'));
    if (enteredHash !== expectedHash) {
      setReturnError('Неверный ПИН-код администратора. Возврат заблокирован.');
      return;
    }

    const totalReturn = Math.round(qty * product.retailPrice * 100) / 100;
    const costReturn = Math.round(qty * product.costPrice * 100) / 100;
    const saleId = createSafeId('ret');

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'sales', saleId), {
        id: saleId,
        receiptNumber: `ВЗ-${Date.now().toString().slice(-6)}`,
        type: 'return',
        channel: 'pos',
        shiftId: activeShift.id,
        cashierId: user.uid,
        cashierName: user.displayName,
        items: [
          {
            productId: product.id,
            name: product.name,
            category: product.category,
            unit: product.unit,
            quantity: qty,
            unitPrice: product.retailPrice,
            costPrice: product.costPrice,
            lineTotal: totalReturn,
          },
        ],
        totalAmount: totalReturn,
        costTotal: costReturn,
        cashAmount: totalReturn,
        cardAmount: 0,
        qrAmount: 0,
        paymentMethod: 'cash',
        syncedFromOffline: false,
        authorizedBy: 'PIN Администратора',
        createdAt: new Date().toISOString(),
      } satisfies Sale);

      batch.update(doc(db, 'products', product.id), {
        stock: Math.round((product.stock + qty) * 1000) / 1000,
        updatedAt: new Date().toISOString(),
      });

      const nextReturns = Math.round((activeShift.returnsTotal + totalReturn) * 100) / 100;
      const nextExpected =
        Math.round(
          (activeShift.openingCash +
            activeShift.cashSalesTotal +
            activeShift.cashInTotal -
            activeShift.cashOutTotal -
            nextReturns) *
            100
        ) / 100;

      batch.update(doc(db, 'shifts', activeShift.id), {
        returnsTotal: nextReturns,
        expectedCash: nextExpected,
      });

      await batch.commit();
      writeHiddenSecurityLog(
        'return_sale',
        `Оформлен возврат: ${product.name} (${qty} ${product.unit}) · Причина: ${returnReason}`,
        totalReturn,
        'Подтверждено PIN администратора'
      );

      setReturnModalOpen(false);
      setAdminPinInput('');
      setStatusNotice({
        type: 'ok',
        text: `Возврат оформлен: ${product.name} на сумму ${formatMoney(totalReturn)}`,
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'sales');
    }
  };

  return (
    <div className="space-y-4">
      {/* Top Cashier Operational Bar — Strictly NO admin reports or sales history */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-4 text-sm">
          <div className="flex items-center gap-2 font-medium">
            {effectiveOnline ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-700">
                <Wifi className="w-4 h-4" />
                Онлайн-касса подключена
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-amber-700">
                <WifiOff className="w-4 h-4" />
                Автономный режим (чеки сохраняются локально)
              </span>
            )}
          </div>

          {offlineQueue.length > 0 && (
            <>
              <span className="text-slate-300">·</span>
              <button
                type="button"
                onClick={syncOfflineReceipts}
                disabled={!effectiveOnline || syncingQueue}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-amber-50 text-amber-800 border border-amber-200 rounded-lg hover:bg-amber-100 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${syncingQueue ? 'animate-spin' : ''}`} />
                Синхронизировать чеки ({offlineQueue.length})
              </button>
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => {
              setReturnProductId(products[0]?.id || '');
              setReturnError('');
              setAdminPinInput('');
              setReturnModalOpen(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors"
          >
            <Lock className="w-3.5 h-3.5 text-slate-500" />
            Возврат (PIN админа)
          </button>

          <button
            type="button"
            onClick={() => {
              setZReportResult(null);
              setShiftModalOpen(true);
            }}
            className={`inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg transition-colors ${
              activeShift
                ? 'bg-slate-900 text-white hover:bg-slate-800'
                : 'bg-emerald-600 text-white hover:bg-emerald-700'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            {activeShift
              ? `Смена открыта · В кассе ${formatMoney(activeShift.expectedCash)}`
              : 'Открыть смену'}
          </button>
        </div>
      </div>

      {statusNotice && (
        <div
          className={`px-4 py-2.5 rounded-lg border text-sm flex items-center justify-between ${
            statusNotice.type === 'ok'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
              : 'bg-red-50 border-red-200 text-red-900'
          }`}
        >
          <span>{statusNotice.text}</span>
          <button
            type="button"
            onClick={() => setStatusNotice(null)}
            className="text-xs underline ml-4"
          >
            Скрыть
          </button>
        </div>
      )}

      {/* Main Split POS Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Scanner, Quick Window, Product Prices Grid */}
        <div className="lg:col-span-7 space-y-5">
          {/* Barcode Scanner & Manual Weight Entry */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!barcodeInput.trim()) return;
                handleScanCode(barcodeInput);
                setBarcodeInput('');
              }}
              className="flex flex-col sm:flex-row gap-2.5"
            >
              <div className="relative flex-1">
                <Barcode className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  ref={barcodeFieldRef}
                  type="text"
                  value={barcodeInput}
                  onChange={(e) => setBarcodeInput(e.target.value)}
                  placeholder="Сканируйте штрихкод или весовую этикетку (например: 2200101012504)..."
                  className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2.5 text-sm font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800 whitespace-nowrap"
              >
                Считать код
              </button>
              <button
                type="button"
                onClick={() => setManualModalOpen(true)}
                className="inline-flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 whitespace-nowrap"
              >
                <Calculator className="w-4 h-4" />
                Вес / ШК вручную
              </button>
            </form>

            {/* Quick Scale Barcode Demo Helper */}
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Весовые штрихкоды (электронные весы):</span>
              <button
                type="button"
                onClick={() => handleScanCode(buildWeightedBarcodeSample('00101', 1250))}
                className="font-mono text-slate-700 hover:text-emerald-700 underline underline-offset-2"
              >
                Сыр 1.250 кг ({buildWeightedBarcodeSample('00101', 1250)})
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() => handleScanCode(buildWeightedBarcodeSample('00201', 1850))}
                className="font-mono text-slate-700 hover:text-emerald-700 underline underline-offset-2"
              >
                Яблоки 1.850 кг ({buildWeightedBarcodeSample('00201', 1850)})
              </button>
            </div>
          </div>

          {/* Quick-Access Window: Лепешки, Памперсы, Жвачки, Товары без штрихкода */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                Быстрое окно: Лепешки, Памперсы, Жвачки и товары без штрихкода
              </h3>
              <span className="text-xs text-slate-500 font-mono">
                {quickItems.length} позиций
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
              {quickItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleProductTileClick(item)}
                  className="text-left p-3 rounded-lg border border-slate-200 bg-slate-50 hover:bg-emerald-50 hover:border-emerald-300 transition-colors flex flex-col justify-between min-h-[82px]"
                >
                  <div className="text-sm font-medium text-slate-900 line-clamp-2">
                    {item.name}
                  </div>
                  <div className="flex items-center justify-between mt-2 text-xs">
                    <span className="font-mono font-semibold text-emerald-700">
                      {formatMoney(item.retailPrice)} / {item.unit}
                    </span>
                    {item.isWeighted && (
                      <Scale className="w-3.5 h-3.5 text-slate-500" />
                    )}
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* Catalog Search & Retail Prices */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Поиск товара по названию, PLU или штрихкоду..."
                  className="w-full pl-10 pr-4 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setSelectedCategory(cat)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                    selectedCategory === cat
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[380px] overflow-y-auto pr-1">
              {filteredProducts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => handleProductTileClick(p)}
                  className="p-3 rounded-lg border border-slate-200 hover:border-emerald-400 hover:bg-slate-50 text-left transition-colors flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-900 truncate">{p.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {p.category} · Ост: <span className="font-mono">{p.stock} {p.unit}</span>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm font-bold text-slate-900">
                      {formatMoney(p.retailPrice)}
                    </div>
                    <div className="text-[11px] text-slate-500">за 1 {p.unit}</div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Active Receipt, Held Receipts, Checkout */}
        <div className="lg:col-span-5 space-y-4">
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold">Текущий чек покупателя</h2>
                <p className="text-xs text-slate-300 mt-0.5">
                  Позиций: <span className="font-mono">{cart.length}</span>
                </p>
              </div>
              {cart.length > 0 && (
                <button
                  type="button"
                  onClick={handleCancelReceipt}
                  className="text-xs text-red-300 hover:text-red-200 underline underline-offset-4"
                >
                  Отменить чек
                </button>
              )}
            </div>

            <div className="p-4 space-y-2.5 max-h-[360px] overflow-y-auto">
              {cart.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">
                  Отсканируйте товар или выберите из быстрого окна слева
                </div>
              ) : (
                cart.map((item) => (
                  <div
                    key={item.productId}
                    className="p-3 rounded-lg border border-slate-200 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900 truncate">
                        {item.name}
                      </div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">
                        {item.quantity} {item.unit} × {formatMoney(item.unitPrice)}
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleUpdateCartQty(item, item.isWeighted ? -0.1 : -1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100"
                        aria-label="Уменьшить количество"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleUpdateCartQty(item, item.isWeighted ? 0.1 : 1)}
                        className="w-8 h-8 rounded-lg border border-slate-200 flex items-center justify-center text-slate-700 hover:bg-slate-100"
                        aria-label="Увеличить количество"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                      <div className="w-20 text-right font-mono text-sm font-semibold text-slate-900">
                        {formatMoney(item.lineTotal)}
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRemoveCartItem(item)}
                        className="p-1.5 text-slate-400 hover:text-red-600"
                        aria-label="Удалить позицию"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="px-5 py-4 bg-slate-50 border-t border-slate-200 space-y-4">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-medium text-slate-600">Итого к оплате</span>
                <span className="font-mono text-2xl font-bold text-slate-900">
                  {formatMoney(cartTotal)}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <button
                  type="button"
                  onClick={handleHoldReceipt}
                  disabled={cart.length === 0}
                  className="inline-flex items-center justify-center gap-1.5 px-4 py-3 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 disabled:opacity-40 transition-colors"
                >
                  <PauseCircle className="w-4 h-4" />
                  Отложить чек
                </button>
                <button
                  type="button"
                  onClick={openPaymentModal}
                  disabled={cart.length === 0}
                  className="inline-flex items-center justify-center gap-2 px-4 py-3 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors"
                >
                  <CreditCard className="w-4 h-4" />
                  Оплата / QR
                </button>
              </div>
            </div>
          </div>

          {/* Held Receipts Panel */}
          {heldReceipts.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2.5">
              <h3 className="text-sm font-semibold text-slate-900">
                Отложенные чеки ({heldReceipts.length})
              </h3>
              <div className="space-y-2">
                {heldReceipts.map((h) => (
                  <div
                    key={h.id}
                    className="flex items-center justify-between p-2.5 bg-amber-50 border border-amber-200 rounded-lg"
                  >
                    <span className="text-xs font-medium text-amber-900 truncate">{h.label}</span>
                    <button
                      type="button"
                      onClick={() => handleRestoreHeld(h)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-amber-900 bg-white border border-amber-300 rounded-md hover:bg-amber-100 shrink-0"
                    >
                      <PlayCircle className="w-3.5 h-3.5" />
                      Вернуть
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal: Manual Weight / Barcode Input */}
      {manualModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <h3 className="text-lg font-semibold text-slate-900">
              Ручной ввод штрихкода или веса
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (manualBarcode.trim()) {
                  handleScanCode(manualBarcode);
                  setManualBarcode('');
                  setManualModalOpen(false);
                }
              }}
              className="space-y-3"
            >
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">
                  Штрихкод или PLU-код товара
                </label>
                <input
                  type="text"
                  value={manualBarcode}
                  onChange={(e) => setManualBarcode(e.target.value)}
                  placeholder="Например: 4607065001122 или 2200101012504"
                  className="w-full px-3.5 py-2.5 font-mono text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                  autoFocus
                />
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setManualModalOpen(false)}
                  className="px-4 py-2 text-sm text-slate-600 hover:text-slate-900"
                >
                  Закрыть
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                >
                  Найти и добавить
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Weighted Product Weight Entry */}
      {weightProduct && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-sm bg-white border border-slate-200 rounded-xl p-6 space-y-4">
            <div>
              <h3 className="text-base font-semibold text-slate-900">{weightProduct.name}</h3>
              <p className="text-xs text-slate-500 mt-0.5 font-mono">
                Цена: {formatMoney(weightProduct.retailPrice)} / кг
              </p>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">
                Вес в килограммах (кг)
              </label>
              <input
                type="number"
                step="0.005"
                min="0.01"
                value={manualWeightKg}
                onChange={(e) => setManualWeightKg(e.target.value)}
                className="w-full px-4 py-2.5 font-mono text-lg border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
                autoFocus
              />
              <div className="grid grid-cols-4 gap-1.5 mt-2">
                {['0.250', '0.500', '1.000', '1.500'].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setManualWeightKg(preset)}
                    className="py-1.5 text-xs font-mono bg-slate-100 hover:bg-slate-200 rounded-md"
                  >
                    {preset} кг
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between pt-2 border-t border-slate-200">
              <span className="text-xs text-slate-500">Сумма:</span>
              <span className="font-mono text-base font-bold text-slate-900">
                {formatMoney((Number(manualWeightKg) || 0) * weightProduct.retailPrice)}
              </span>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWeightProduct(null)}
                className="px-4 py-2 text-sm text-slate-600"
              >
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  addProductToCart(weightProduct, Number(manualWeightKg) || 0);
                  setWeightProduct(null);
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
              >
                Добавить в чек
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Checkout (Cash / Card / QR / Split Payment) */}
      {paymentModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Оплата чека</h3>
              <span className="font-mono text-xl font-bold text-emerald-700">
                {formatMoney(cartTotal)}
              </span>
            </div>

            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  ['cash', 'Наличные', Wallet],
                  ['card', 'Карта', CreditCard],
                  ['qr', 'QR на экран', QrCode],
                  ['split', 'Раздельная', ArrowDownUp],
                ] as const
              ).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setPayMode(mode)}
                  className={`p-2.5 rounded-lg border text-xs font-medium flex flex-col items-center gap-1.5 transition-colors ${
                    payMode === mode
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="whitespace-nowrap">{label}</span>
                </button>
              ))}
            </div>

            {payMode === 'cash' && (
              <div className="space-y-3 bg-slate-50 p-4 rounded-lg border border-slate-200">
                <div>
                  <label className="block text-xs font-medium text-slate-600 mb-1">
                    Получено от покупателя (смн)
                  </label>
                  <input
                    type="number"
                    value={cashTendered}
                    onChange={(e) => setCashTendered(e.target.value)}
                    className="w-full px-3.5 py-2 font-mono text-base bg-white border border-slate-300 rounded-lg"
                  />
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-slate-600">Сдача:</span>
                  <span className="font-mono font-bold text-slate-900">
                    {formatMoney(Math.max(0, (Number(cashTendered) || 0) - cartTotal))}
                  </span>
                </div>
              </div>
            )}

            {payMode === 'card' && (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700">
                Приложите банковскую карту к терминалу или подтвердите банковский перевод на сумму{' '}
                <strong className="font-mono">{formatMoney(cartTotal)}</strong>.
              </div>
            )}

            {payMode === 'qr' && (
              <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex flex-col items-center gap-3 text-center">
                <p className="text-xs text-slate-600">
                  Покажите этот QR-код покупателю для мгновенной оплаты по QR
                </p>
                {qrPaymentUrl && (
                  <img
                    src={qrPaymentUrl}
                    alt="QR для оплаты"
                    className="w-48 h-48 rounded-lg border border-slate-200 bg-white p-2"
                  />
                )}
                <div className="font-mono text-base font-bold text-slate-900">
                  К оплате: {formatMoney(cartTotal)}
                </div>
              </div>
            )}

            {payMode === 'split' && (
              <div className="space-y-3 bg-slate-50 p-4 rounded-lg border border-slate-200">
                <div className="grid grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Наличные (смн)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={splitCash}
                      onChange={(e) => setSplitCash(e.target.value)}
                      className="w-full px-3 py-2 font-mono text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      Карта / Перевод (смн)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={splitCard}
                      onChange={(e) => setSplitCard(e.target.value)}
                      className="w-full px-3 py-2 font-mono text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-slate-600 mb-1">
                      QR-код (смн)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={splitQr}
                      onChange={(e) => setSplitQr(e.target.value)}
                      className="w-full px-3 py-2 font-mono text-sm bg-white border border-slate-300 rounded-lg"
                    />
                  </div>
                </div>
                {Number(splitQr) > 0 && qrPaymentUrl && (
                  <div className="flex items-center gap-3 pt-2 border-t border-slate-200">
                    <img
                      src={qrPaymentUrl}
                      alt="QR для частичной оплаты"
                      className="w-20 h-20 bg-white border border-slate-200 rounded p-1"
                    />
                    <div className="text-xs text-slate-600">
                      QR-код сформирован на сумму{' '}
                      <span className="font-mono font-semibold">{formatMoney(Number(splitQr))}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setPaymentModalOpen(false)}
                className="px-4 py-2 text-sm text-slate-600"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={processingSale}
                onClick={handleCompleteSale}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                <CheckCircle2 className="w-4 h-4" />
                {processingSale ? 'Проведение...' : 'Пробить чек'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Shift Open / Cash In-Out / Z-Report Close */}
      {shiftModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-5 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">
                Кассовая смена и Z-отчет
              </h3>
              <button
                type="button"
                onClick={() => setShiftModalOpen(false)}
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                Закрыть
              </button>
            </div>

            {zReportResult ? (
              <div className="space-y-3 bg-slate-50 p-4 rounded-lg border border-slate-200 font-mono text-xs">
                <div className="text-sm font-bold text-slate-900">Z-ОТЧЕТ ЗАКРЫТИЯ СМЕНЫ</div>
                <div className="flex justify-between">
                  <span>Кассир:</span>
                  <span>{zReportResult.cashierName}</span>
                </div>
                <div className="flex justify-between">
                  <span>Наличные на начало:</span>
                  <span>{formatMoney(zReportResult.openingCash)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Продажи наличными:</span>
                  <span>{formatMoney(zReportResult.cashSalesTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Продажи картой / QR:</span>
                  <span>{formatMoney(zReportResult.cardSalesTotal + zReportResult.qrSalesTotal)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Внесения / Изъятия:</span>
                  <span>
                    +{formatMoney(zReportResult.cashInTotal)} / -{formatMoney(zReportResult.cashOutTotal)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Возвраты:</span>
                  <span>-{formatMoney(zReportResult.returnsTotal)}</span>
                </div>
                <div className="border-t border-slate-300 pt-2 flex justify-between font-bold text-sm">
                  <span>Ожидалось в кассе:</span>
                  <span>{formatMoney(zReportResult.expectedCash)}</span>
                </div>
                <div className="flex justify-between font-bold text-sm">
                  <span>Фактически в кассе:</span>
                  <span>{formatMoney(zReportResult.actualCash || 0)}</span>
                </div>
                <div
                  className={`flex justify-between font-bold text-sm ${
                    (zReportResult.discrepancy || 0) === 0 ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  <span>Расхождение:</span>
                  <span>{formatMoney(zReportResult.discrepancy || 0)}</span>
                </div>
              </div>
            ) : !activeShift ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">
                    Сумма наличных в денежном ящике на начало смены (смн)
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={openingCashInput}
                    onChange={(e) => setOpeningCashInput(e.target.value)}
                    className="w-full px-3.5 py-2.5 font-mono text-base border border-slate-300 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={handleOpenShift}
                  className="w-full py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                >
                  Открыть кассовую смену
                </button>
              </div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-3 text-xs bg-slate-50 p-3.5 rounded-lg border border-slate-200">
                  <div>
                    <div className="text-slate-500">На начало смены</div>
                    <div className="font-mono font-semibold text-sm mt-0.5">
                      {formatMoney(activeShift.openingCash)}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500">Ожидается наличных</div>
                    <div className="font-mono font-bold text-sm text-emerald-700 mt-0.5">
                      {formatMoney(activeShift.expectedCash)}
                    </div>
                  </div>
                </div>

                {/* Cash In / Out */}
                <div className="space-y-2.5 border-t border-slate-200 pt-4">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Внесение / Изъятие наличных (например, выдача поставщику)
                  </h4>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setCashMoveType('out')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                        cashMoveType === 'out'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      Изъятие из кассы
                    </button>
                    <button
                      type="button"
                      onClick={() => setCashMoveType('in')}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg border ${
                        cashMoveType === 'in'
                          ? 'bg-slate-900 text-white border-slate-900'
                          : 'bg-white text-slate-700 border-slate-300'
                      }`}
                    >
                      Внесение в кассу
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      type="number"
                      placeholder="Сумма смн"
                      value={cashMoveAmount}
                      onChange={(e) => setCashMoveAmount(e.target.value)}
                      className="px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                    />
                    <input
                      type="text"
                      placeholder="Причина (напр. поставщику)"
                      value={cashMoveReason}
                      onChange={(e) => setCashMoveReason(e.target.value)}
                      className="col-span-2 px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleCashMovement}
                    className="px-4 py-2 text-xs font-medium text-white bg-slate-900 rounded-lg hover:bg-slate-800"
                  >
                    Провести операцию
                  </button>
                </div>

                {/* Close Shift Z-Report */}
                <div className="space-y-2.5 border-t border-slate-200 pt-4">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Закрытие смены и сверка остатка (Z-отчет)
                  </h4>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      placeholder="Фактическая сумма наличных в ящике (смн)"
                      value={closingCashInput}
                      onChange={(e) => setClosingCashInput(e.target.value)}
                      className="flex-1 px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                    />
                    <button
                      type="button"
                      onClick={handleCloseShift}
                      className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 whitespace-nowrap"
                    >
                      Закрыть смену
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Admin-PIN Protected Return */}
      {returnModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
          <form
            onSubmit={handleProcessReturn}
            className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-4"
          >
            <div className="flex items-center gap-2.5">
              <RotateCcw className="w-5 h-5 text-red-600" />
              <h3 className="text-lg font-semibold text-slate-900">
                Возврат товара от покупателя
              </h3>
            </div>
            <p className="text-xs text-slate-600">
              Оформление возврата возможно только после ввода ПИН-кода администратора (по умолчанию 1234, меняется руководителем).
            </p>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Товар</label>
              <select
                value={returnProductId}
                onChange={(e) => setReturnProductId(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({formatMoney(p.retailPrice)})
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
                  value={returnQty}
                  onChange={(e) => setReturnQty(e.target.value)}
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  PIN администратора
                </label>
                <input
                  type="password"
                  inputMode="numeric"
                  value={adminPinInput}
                  onChange={(e) => setAdminPinInput(e.target.value)}
                  placeholder="••••"
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">Причина возврата</label>
              <input
                type="text"
                value={returnReason}
                onChange={(e) => setReturnReason(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            {returnError && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {returnError}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReturnModalOpen(false)}
                className="px-4 py-2 text-sm text-slate-600"
              >
                Отмена
              </button>
              <button
                type="submit"
                className="px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700"
              >
                Подтвердить возврат
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
