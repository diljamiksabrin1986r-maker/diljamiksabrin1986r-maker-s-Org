import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  ImagePlus,
  Minus,
  Package,
  Plus,
  QrCode,
  Search,
  ShoppingBag,
  ShoppingCart,
  Trash2,
  Truck,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { doc, writeBatch } from 'firebase/firestore';
import { createSafeId, db, handleFirestoreError, OperationType } from '../firebase';
import type { OnlineOrder, Product, Sale, StoreSettings, UserProfile } from '../types';
import { formatMoney } from '../utils/exportReports';
import { STORE_IMAGES, getCategoryImage } from '../utils/seedData';

interface StorefrontViewProps {
  user: UserProfile | null;
  products: Product[];
  myOrders: OnlineOrder[];
  storeSettings?: StoreSettings | null;
  onRequireAuth: () => void;
}

interface StoreCartItem {
  product: Product;
  quantity: number;
}

export const StorefrontView: React.FC<StorefrontViewProps> = ({
  user,
  products,
  myOrders,
  storeSettings,
  onRequireAuth,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('Все');
  const [cart, setCart] = useState<StoreCartItem[]>([]);
  const [cartOpen, setCartOpen] = useState(false);

  // Checkout state
  const [customerName, setCustomerName] = useState(user?.displayName || '');
  const [customerPhone, setCustomerPhone] = useState('');
  const [deliveryType, setDeliveryType] = useState<'delivery' | 'pickup'>('delivery');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<
    'card_online' | 'qr_online' | 'cash_on_delivery'
  >('card_online');
  const [placingOrder, setPlacingOrder] = useState(false);
  const [confirmedOrder, setConfirmedOrder] = useState<OnlineOrder | null>(null);
  const [showOrdersDrawer, setShowOrdersDrawer] = useState(false);
  const [qrPaymentUrl, setQrPaymentUrl] = useState('');
  const [copiedMerchant, setCopiedMerchant] = useState(false);
  const [paymentProofNote, setPaymentProofNote] = useState('');
  const [paymentProofImage, setPaymentProofImage] = useState('');
  const [proofUploadError, setProofUploadError] = useState('');

  const onlineProducts = useMemo(
    () => products.filter((p) => p.activeOnline && p.stock > 0),
    [products]
  );

  const categories = useMemo(() => {
    const set = new Set(onlineProducts.map((p) => p.category));
    return ['Все', ...Array.from(set)];
  }, [onlineProducts]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return onlineProducts.filter((p) => {
      if (selectedCategory !== 'Все' && p.category !== selectedCategory) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q);
    });
  }, [onlineProducts, selectedCategory, searchQuery]);

  const cartCount = useMemo(
    () => cart.reduce((acc, item) => acc + (item.product.isWeighted ? 1 : item.quantity), 0),
    [cart]
  );

  const cartTotal = useMemo(
    () =>
      Math.round(
        cart.reduce((acc, item) => acc + item.product.retailPrice * item.quantity, 0) * 100
      ) / 100,
    [cart]
  );

  const merchantId = storeSettings?.qrMerchantId || 'FRESHMART-SBP-001';
  const storeTitle = storeSettings?.storeName || 'FreshMart Pro';

  useEffect(() => {
    if (!cartOpen || paymentMethod !== 'qr_online' || cartTotal <= 0) {
      setQrPaymentUrl('');
      return;
    }
    const payload = `ST00012|Name=${storeTitle}|PersonalAcc=${merchantId}|Sum=${Math.round(
      cartTotal * 100
    )}|Currency=TJS|Purpose=Online_zakaz`;
    QRCode.toDataURL(payload, { width: 220, margin: 1 })
      .then(setQrPaymentUrl)
      .catch(() => setQrPaymentUrl(''));
  }, [cartOpen, paymentMethod, cartTotal, merchantId, storeTitle]);

  const handleCopyMerchant = () => {
    navigator.clipboard
      ?.writeText(merchantId)
      .then(() => {
        setCopiedMerchant(true);
        setTimeout(() => setCopiedMerchant(false), 2000);
      })
      .catch(() => {});
  };

  const handleReceiptImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setProofUploadError('');
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setProofUploadError('Загрузите изображение (JPG, PNG или скриншот чека).');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const maxSide = 480;
        const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setProofUploadError('Не удалось обработать изображение.');
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const compressed = canvas.toDataURL('image/jpeg', 0.55);
        if (compressed.length > 240000) {
          const fallback = canvas.toDataURL('image/jpeg', 0.35);
          if (fallback.length > 240000) {
            setProofUploadError('Скриншот слишком большой. Выберите более компактное изображение.');
            return;
          }
          setPaymentProofImage(fallback);
        } else {
          setPaymentProofImage(compressed);
        }
      };
      img.onerror = () => setProofUploadError('Не удалось прочитать файл изображения.');
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const addToCart = (product: Product) => {
    const step = product.isWeighted ? 0.5 : 1;
    setCart((prev) => {
      const existing = prev.find((i) => i.product.id === product.id);
      if (existing) {
        return prev.map((i) =>
          i.product.id === product.id
            ? {
                ...i,
                quantity: Math.min(product.stock, Math.round((i.quantity + step) * 100) / 100),
              }
            : i
        );
      }
      return [...prev, { product, quantity: Math.min(product.stock, step) }];
    });
  };

  const updateCartQty = (productId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((i) =>
          i.product.id === productId
            ? {
                ...i,
                quantity: Math.min(
                  i.product.stock,
                  Math.round((i.quantity + delta) * 100) / 100
                ),
              }
            : i
        )
        .filter((i) => i.quantity > 0)
    );
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (cart.length === 0) return;
    if (!user) {
      onRequireAuth();
      return;
    }

    setPlacingOrder(true);
    const orderId = createSafeId('ord');
    const saleId = createSafeId('sale');
    const now = new Date().toISOString();
    const orderNumber = `ОНЛ-${Date.now().toString().slice(-5)}`;
    const isQrPayment = paymentMethod === 'qr_online';
    const paymentStatus: OnlineOrder['paymentStatus'] = isQrPayment
      ? 'awaiting_verification'
      : paymentMethod === 'card_online'
      ? 'paid'
      : 'pending';

    const trimmedProofNote = paymentProofNote.trim().slice(0, 200);

    const order: OnlineOrder = {
      id: orderId,
      orderNumber,
      customerId: user.uid,
      customerName: customerName.trim() || user.displayName,
      customerPhone: customerPhone.trim(),
      deliveryAddress: deliveryType === 'delivery' ? deliveryAddress.trim() : 'Самовывоз из магазина',
      deliveryType,
      items: cart.map((i) => ({
        productId: i.product.id,
        name: i.product.name,
        unit: i.product.unit,
        quantity: i.quantity,
        unitPrice: i.product.retailPrice,
        lineTotal: Math.round(i.quantity * i.product.retailPrice * 100) / 100,
      })),
      totalAmount: cartTotal,
      paymentMethod,
      paymentStatus,
      ...(isQrPayment && trimmedProofNote ? { paymentProofNote: trimmedProofNote } : {}),
      ...(isQrPayment && paymentProofImage ? { paymentProofImage } : {}),
      orderStatus: 'new',
      createdAt: now,
      updatedAt: now,
    };

    const costTotal =
      Math.round(cart.reduce((acc, i) => acc + i.product.costPrice * i.quantity, 0) * 100) / 100;

    try {
      const batch = writeBatch(db);
      batch.set(doc(db, 'online_orders', orderId), order);

      // For QR online payment, do NOT record revenue in `sales` until admin verifies bank receipt
      if (!isQrPayment) {
        const sale: Sale = {
          id: saleId,
          receiptNumber: orderNumber,
          type: 'sale',
          channel: 'online',
          cashierId: user.uid,
          cashierName: `Онлайн-заказ (${order.customerName})`,
          items: cart.map((i) => ({
            productId: i.product.id,
            name: i.product.name,
            category: i.product.category,
            unit: i.product.unit,
            quantity: i.quantity,
            unitPrice: i.product.retailPrice,
            costPrice: i.product.costPrice,
            lineTotal: Math.round(i.quantity * i.product.retailPrice * 100) / 100,
          })),
          totalAmount: cartTotal,
          costTotal,
          cashAmount: paymentMethod === 'cash_on_delivery' ? cartTotal : 0,
          cardAmount: paymentMethod === 'card_online' ? cartTotal : 0,
          qrAmount: 0,
          paymentMethod: 'online',
          syncedFromOffline: false,
          createdAt: now,
        };
        batch.set(doc(db, 'sales', saleId), sale);
      }

      for (const item of cart) {
        const nextStock = Math.max(
          0,
          Math.round((item.product.stock - item.quantity) * 1000) / 1000
        );
        batch.update(doc(db, 'products', item.product.id), {
          stock: nextStock,
          updatedAt: now,
        });
      }
      await batch.commit();
      setCart([]);
      setPaymentProofNote('');
      setPaymentProofImage('');
      setProofUploadError('');
      setConfirmedOrder(order);
      setCartOpen(false);
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'online_orders');
    } finally {
      setPlacingOrder(false);
    }
  };

  return (
    <div className="space-y-8">
      {/* Editorial Hero Section */}
      <section className="relative rounded-2xl overflow-hidden border border-slate-200 bg-slate-900">
        <img
          src={STORE_IMAGES.hero}
          alt="Свежие продукты FreshMart"
          referrerPolicy="no-referrer"
          className="w-full h-64 sm:h-80 object-cover opacity-80"
        />
        <div className="absolute inset-0 bg-gradient-to-r from-slate-950/85 via-slate-950/55 to-transparent flex items-center">
          <div className="p-6 sm:p-10 max-w-xl space-y-4">
            <h1 className="text-2xl sm:text-4xl font-bold text-white tracking-tight text-balance">
              Свежие продукты, горячие лепешки и фермерская молочка с доставкой
            </h1>
            <p className="text-sm text-slate-200 leading-relaxed">
              Единая витрина с актуальными остатками в реальном времени. Оплачивайте онлайн картой, по QR-коду или при получении.
            </p>
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <a
                href="#storefront-catalog"
                className="px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-500 transition-colors"
              >
                Перейти к покупкам
              </a>
              <button
                type="button"
                onClick={() => setShowOrdersDrawer(true)}
                className="px-4 py-2.5 text-sm font-medium text-white bg-white/15 backdrop-blur-sm rounded-lg hover:bg-white/25 transition-colors"
              >
                Мои заказы ({myOrders.length})
              </button>
            </div>
          </div>
        </div>
      </section>

      {confirmedOrder && (
        <div
          className={`border rounded-xl p-5 flex flex-wrap items-center justify-between gap-4 ${
            confirmedOrder.paymentStatus === 'awaiting_verification'
              ? 'bg-amber-50 border-amber-200'
              : 'bg-emerald-50 border-emerald-200'
          }`}
        >
          <div className="flex items-start gap-3">
            {confirmedOrder.paymentStatus === 'awaiting_verification' ? (
              <Clock className="w-6 h-6 text-amber-700 shrink-0 mt-0.5" />
            ) : (
              <CheckCircle2 className="w-6 h-6 text-emerald-700 shrink-0 mt-0.5" />
            )}
            <div>
              <h3
                className={`text-base font-semibold ${
                  confirmedOrder.paymentStatus === 'awaiting_verification'
                    ? 'text-amber-950'
                    : 'text-emerald-950'
                }`}
              >
                {confirmedOrder.paymentStatus === 'awaiting_verification'
                  ? `Заказ ${confirmedOrder.orderNumber} создан и ожидает подтверждения оплаты`
                  : `Заказ ${confirmedOrder.orderNumber} принят в сборку!`}
              </h3>
              <p
                className={`text-sm mt-0.5 ${
                  confirmedOrder.paymentStatus === 'awaiting_verification'
                    ? 'text-amber-900'
                    : 'text-emerald-900'
                }`}
              >
                Сумма: <span className="font-mono font-bold">{formatMoney(confirmedOrder.totalAmount)}</span> ·{' '}
                {confirmedOrder.paymentStatus === 'awaiting_verification'
                  ? 'Оплата по QR проверяется администратором (после поступления средств / SMS банка заказ пойдет в сборку)'
                  : confirmedOrder.paymentStatus === 'paid'
                  ? 'Оплачен онлайн картой'
                  : 'Оплата при получении'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setConfirmedOrder(null)}
            className="text-xs font-medium text-slate-700 underline"
          >
            Закрыть
          </button>
        </div>
      )}

      {/* Catalog Toolbar */}
      <section id="storefront-catalog" className="space-y-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setSelectedCategory(cat)}
                className={`px-3.5 py-2 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 transition-colors ${
                  selectedCategory === cat
                    ? 'bg-slate-900 text-white'
                    : 'bg-white border border-slate-200 text-slate-700 hover:bg-slate-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <div className="relative flex-1 sm:w-64">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Поиск продуктов..."
                className="w-full pl-9 pr-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              />
            </div>

            <button
              type="button"
              onClick={() => setCartOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 whitespace-nowrap shrink-0"
            >
              <ShoppingCart className="w-4 h-4" />
              Корзина ({cartCount}) · <span className="font-mono">{formatMoney(cartTotal)}</span>
            </button>
          </div>
        </div>

        {/* 3-Column Product Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredProducts.map((p) => {
            const imgSrc = p.imageUrl || getCategoryImage(p.category);
            return (
              <article
                key={p.id}
                className="bg-white border border-slate-200 rounded-xl overflow-hidden flex flex-col transition-transform duration-150 hover:-translate-y-0.5"
              >
                <div className="aspect-[4/3] bg-slate-100 overflow-hidden relative">
                  <img
                    src={imgSrc}
                    alt={p.name}
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }}
                  />
                </div>
                <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
                  <div>
                    <div className="text-xs text-slate-500">
                      {p.category} · В наличии <span className="font-mono">{p.stock} {p.unit}</span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-900 mt-1">{p.name}</h3>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-slate-100">
                    <div>
                      <span className="font-mono text-lg font-bold text-slate-900">
                        {formatMoney(p.retailPrice)}
                      </span>
                      <span className="text-xs text-slate-500"> / {p.unit}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => addToCart(p)}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-emerald-600 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      В корзину
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {/* Slide-Over Cart & Checkout Drawer */}
      {cartOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50">
          <div className="w-full max-w-md bg-white h-full flex flex-col border-l border-slate-200">
            <div className="px-5 py-4 border-b border-slate-200 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShoppingBag className="w-5 h-5 text-emerald-700" />
                <h3 className="text-base font-semibold text-slate-900">Ваш заказ</h3>
              </div>
              <button
                type="button"
                onClick={() => setCartOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-900"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {cart.length === 0 ? (
                <div className="py-12 text-center text-sm text-slate-500">
                  Корзина пуста. Добавьте продукты из витрины.
                </div>
              ) : (
                <>
                  <div className="space-y-3">
                    {cart.map((item) => (
                      <div
                        key={item.product.id}
                        className="p-3 rounded-lg border border-slate-200 flex items-center justify-between gap-3"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900 truncate">
                            {item.product.name}
                          </div>
                          <div className="text-xs font-mono text-slate-500">
                            {formatMoney(item.product.retailPrice)} × {item.quantity} {item.product.unit}
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() =>
                              updateCartQty(item.product.id, item.product.isWeighted ? -0.5 : -1)
                            }
                            className="w-7 h-7 rounded border border-slate-200 flex items-center justify-center"
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              updateCartQty(item.product.id, item.product.isWeighted ? 0.5 : 1)
                            }
                            className="w-7 h-7 rounded border border-slate-200 flex items-center justify-center"
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => updateCartQty(item.product.id, -9999)}
                            className="p-1 text-slate-400 hover:text-red-600"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <form id="online-checkout-form" onSubmit={handlePlaceOrder} className="space-y-3 pt-3 border-t border-slate-200">
                    <h4 className="text-sm font-semibold text-slate-900">Оформление и онлайн-оплата</h4>
                    <input
                      type="text"
                      required
                      placeholder="Ваше имя"
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                    <input
                      type="tel"
                      required
                      placeholder="Телефон для связи"
                      value={customerPhone}
                      onChange={(e) => setCustomerPhone(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setDeliveryType('delivery')}
                        className={`py-2 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 ${
                          deliveryType === 'delivery'
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-300'
                        }`}
                      >
                        <Truck className="w-3.5 h-3.5" />
                        Доставка
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeliveryType('pickup')}
                        className={`py-2 text-xs font-medium rounded-lg border flex items-center justify-center gap-1.5 ${
                          deliveryType === 'pickup'
                            ? 'bg-slate-900 text-white border-slate-900'
                            : 'bg-white text-slate-700 border-slate-300'
                        }`}
                      >
                        <Package className="w-3.5 h-3.5" />
                        Самовывоз
                      </button>
                    </div>
                    {deliveryType === 'delivery' && (
                      <input
                        type="text"
                        required
                        placeholder="Адрес доставки"
                        value={deliveryAddress}
                        onChange={(e) => setDeliveryAddress(e.target.value)}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                      />
                    )}

                    <div className="space-y-1.5">
                      <div className="text-xs font-medium text-slate-700">Способ оплаты</div>
                      <div className="grid grid-cols-3 gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('card_online')}
                          className={`p-2 rounded-lg border flex flex-col items-center gap-1 ${
                            paymentMethod === 'card_online'
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-800 font-semibold'
                              : 'border-slate-200 text-slate-600'
                          }`}
                        >
                          <CreditCard className="w-4 h-4" />
                          Карта онлайн
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('qr_online')}
                          className={`p-2 rounded-lg border flex flex-col items-center gap-1 ${
                            paymentMethod === 'qr_online'
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-800 font-semibold'
                              : 'border-slate-200 text-slate-600'
                          }`}
                        >
                          <QrCode className="w-4 h-4" />
                          QR-оплата
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('cash_on_delivery')}
                          className={`p-2 rounded-lg border flex flex-col items-center gap-1 ${
                            paymentMethod === 'cash_on_delivery'
                              ? 'bg-emerald-50 border-emerald-500 text-emerald-800 font-semibold'
                              : 'border-slate-200 text-slate-600'
                          }`}
                        >
                          <ShoppingBag className="w-4 h-4" />
                          При получении
                        </button>
                      </div>
                    </div>

                    {paymentMethod === 'qr_online' && (
                      <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col items-center text-center space-y-3">
                        <div className="text-xs font-semibold text-slate-800">
                          QR-код для онлайн-оплаты ({storeTitle})
                        </div>
                        {qrPaymentUrl ? (
                          <div className="bg-white p-2.5 rounded-lg border border-slate-200">
                            <img
                              src={qrPaymentUrl}
                              alt="QR-код для онлайн-оплаты"
                              className="w-40 h-40 object-contain"
                            />
                          </div>
                        ) : (
                          <div className="w-40 h-40 rounded-lg border border-dashed border-slate-300 flex items-center justify-center text-xs text-slate-400">
                            Генерация QR...
                          </div>
                        )}
                        <div className="text-sm font-mono font-bold text-slate-900 tabular-nums">
                          К оплате: {formatMoney(cartTotal)}
                        </div>
                        <div className="flex items-center justify-center gap-1.5 text-xs text-slate-600">
                          <span>Реквизиты:</span>
                          <span className="font-mono font-medium text-slate-900">{merchantId}</span>
                          <button
                            type="button"
                            onClick={handleCopyMerchant}
                            title="Скопировать реквизиты"
                            className="p-1 text-slate-500 hover:text-emerald-700"
                          >
                            {copiedMerchant ? (
                              <Check className="w-3.5 h-3.5 text-emerald-600" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>

                        <div className="w-full text-left space-y-2 pt-2 border-t border-slate-200">
                          <input
                            type="text"
                            maxLength={200}
                            value={paymentProofNote}
                            onChange={(e) => setPaymentProofNote(e.target.value)}
                            placeholder="Номер перевода или комментарий к оплате (необязательно)"
                            className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded-lg"
                          />

                          <div className="flex items-center justify-between gap-2">
                            <label className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-100 cursor-pointer">
                              <ImagePlus className="w-3.5 h-3.5 text-emerald-700" />
                              {paymentProofImage ? 'Заменить скриншот чека' : 'Прикрепить скриншот чека'}
                              <input
                                type="file"
                                accept="image/*"
                                onChange={handleReceiptImageUpload}
                                className="hidden"
                              />
                            </label>
                            {paymentProofImage && (
                              <button
                                type="button"
                                onClick={() => setPaymentProofImage('')}
                                className="text-xs text-red-600 hover:underline"
                              >
                                Удалить
                              </button>
                            )}
                          </div>

                          {proofUploadError && (
                            <div className="text-xs text-red-600 flex items-center gap-1">
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                              {proofUploadError}
                            </div>
                          )}

                          {paymentProofImage && (
                            <div className="rounded-lg border border-slate-200 bg-white p-1.5 inline-block">
                              <img
                                src={paymentProofImage}
                                alt="Скриншот чека оплаты"
                                className="max-h-28 rounded object-contain"
                              />
                            </div>
                          )}
                        </div>

                        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">
                          После оплаты заказ получит статус «Ожидает подтверждения оплаты». Администратор сверит поступление и переведет заказ в сборку.
                        </p>
                      </div>
                    )}
                  </form>
                </>
              )}
            </div>

            {cart.length > 0 && (
              <div className="p-5 border-t border-slate-200 bg-slate-50 space-y-3">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm text-slate-600">Итого:</span>
                  <span className="font-mono text-xl font-bold text-slate-900">
                    {formatMoney(cartTotal)}
                  </span>
                </div>
                <button
                  type="submit"
                  form="online-checkout-form"
                  disabled={placingOrder}
                  className="w-full py-3 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                >
                  {!user
                    ? 'Войти через Google и оформить'
                    : placingOrder
                    ? 'Оформление...'
                    : paymentMethod === 'qr_online'
                    ? 'Я оплатил(а) по QR — отправить на проверку'
                    : paymentMethod === 'cash_on_delivery'
                    ? 'Оформить заказ'
                    : 'Оплатить и оформить заказ'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Customer Online Orders Tracker */}
      {showOrdersDrawer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 space-y-4 max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-900">Мои онлайн-заказы</h3>
              <button
                type="button"
                onClick={() => setShowOrdersDrawer(false)}
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                Закрыть
              </button>
            </div>
            {myOrders.length === 0 ? (
              <p className="text-sm text-slate-500 py-8 text-center">
                У вас пока нет оформленных онлайн-заказов.
              </p>
            ) : (
              <div className="space-y-3">
                {myOrders.map((o) => {
                  const paymentLabel =
                    o.paymentStatus === 'awaiting_verification'
                      ? 'Ожидает подтверждения оплаты'
                      : o.paymentStatus === 'paid'
                      ? 'Оплачен'
                      : o.paymentStatus === 'rejected'
                      ? 'Оплата отклонена'
                      : 'При получении';
                  const paymentColor =
                    o.paymentStatus === 'awaiting_verification'
                      ? 'text-amber-700'
                      : o.paymentStatus === 'paid'
                      ? 'text-emerald-700'
                      : o.paymentStatus === 'rejected'
                      ? 'text-red-700'
                      : 'text-slate-600';
                  return (
                    <div key={o.id} className="p-3.5 rounded-lg border border-slate-200 space-y-1.5 text-xs">
                      <div className="flex justify-between font-semibold text-sm">
                        <span className="font-mono">{o.orderNumber}</span>
                        <span className={paymentColor}>{paymentLabel}</span>
                      </div>
                      <div className="text-slate-600">
                        {o.items.map((i) => `${i.name} × ${i.quantity}`).join(', ')}
                      </div>
                      {o.paymentProofNote && (
                        <div className="text-slate-500">Комментарий оплаты: {o.paymentProofNote}</div>
                      )}
                      <div className="flex justify-between text-slate-500 pt-1">
                        <span>
                          {o.createdAt.slice(0, 16).replace('T', ' ')} · Статус заказа: {o.orderStatus}
                        </span>
                        <span className="font-mono font-bold text-slate-900">
                          {formatMoney(o.totalAmount)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
