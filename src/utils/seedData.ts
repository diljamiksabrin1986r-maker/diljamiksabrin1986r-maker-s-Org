import { collection, doc, getDoc, getDocs, limit, query, setDoc, writeBatch } from 'firebase/firestore';
import { db, sha256Hex } from '../firebase';
import type {
  Expense,
  PosSecuritySettings,
  Product,
  PurchaseRequest,
  Sale,
  StoreSettings,
  Supplier,
  WriteOff,
} from '../types';
import { buildWeightedBarcodeSample } from './barcode';

export const STORE_IMAGES = {
  hero: '/src/assets/images/store_hero_fresh_1795000643546.jpg',
  bakery: '/src/assets/images/cat_bakery_bread_1795000644450.jpg',
  dairy: '/src/assets/images/cat_dairy_milk_1795000644768.jpg',
  produce: '/src/assets/images/cat_produce_fruits_1795000643470.jpg',
  pantry: '/src/assets/images/cat_grocery_pantry_1795000645556.jpg',
};

export const DEFAULT_QUICK_CATEGORIES = [
  'Хлеб',
  'Лепёшки',
  'Напитки',
  'Жвачки',
  'Пакеты и хозтовары',
  'Весовые',
] as const;

export function resolveQuickCategory(product: Product): string {
  if (product.quickCategory && product.quickCategory.trim()) {
    return product.quickCategory.trim();
  }
  const lower = product.name.toLowerCase();
  if (lower.includes('лепешк') || lower.includes('лепёшк')) return 'Лепёшки';
  if (lower.includes('хлеб') || lower.includes('батон') || lower.includes('булк')) return 'Хлеб';
  if (lower.includes('жвачк') || lower.includes('orbit') || lower.includes('dirol')) return 'Жвачки';
  if (lower.includes('пакет') || lower.includes('памперс') || product.category === 'Хозтовары') {
    return 'Пакеты и хозтовары';
  }
  if (
    product.category === 'Напитки' ||
    lower.includes('вода') ||
    lower.includes('сок') ||
    lower.includes('кола') ||
    lower.includes('лимонад')
  ) {
    return 'Напитки';
  }
  if (product.isWeighted) return 'Весовые';
  return product.category || 'Прочее';
}

export function getCategoryImage(category: string): string {
  switch (category) {
    case 'Выпечка':
    case 'Хлеб':
    case 'Лепёшки':
      return STORE_IMAGES.bakery;
    case 'Молочные':
      return STORE_IMAGES.dairy;
    case 'Овощи и фрукты':
    case 'Весовые':
      return STORE_IMAGES.produce;
    default:
      return STORE_IMAGES.pantry;
  }
}

function daysFromNowISO(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86400000).toISOString();
}

export const INITIAL_SUPPLIERS: Supplier[] = [
  {
    id: 'sup_tandyr_bakery',
    name: 'Тандыр Пекарня №1',
    phone: '+992 90 111 22 33',
    notes: 'Ежедневная утренняя доставка хлеба и горячих лепёшек',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
  {
    id: 'sup_ferma_dubrava',
    name: 'Ферма Дубрава',
    phone: '+992 93 450 10 20',
    notes: 'Свежее молоко, сметана, творог',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
  {
    id: 'sup_agrosad_yug',
    name: 'АгроСад Юг',
    phone: '+992 98 700 45 12',
    notes: 'Овощи и фрукты (весовые поставки)',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
  {
    id: 'sup_aqua_istochnik',
    name: 'АкваИсточник',
    phone: '+992 91 820 33 44',
    notes: 'Вода, газированные напитки и соки',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
  {
    id: 'sup_konditer_opt',
    name: 'КондитерОпт',
    phone: '+992 90 555 66 77',
    notes: 'Жвачки, шоколад и прикассовые товары',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
  {
    id: 'sup_paket_service',
    name: 'ПакетСервис',
    phone: '+992 92 310 88 99',
    notes: 'Пакеты-майки, упаковка и хозтовары',
    createdBy: 'system',
    createdAt: daysAgoISO(30),
    updatedAt: daysAgoISO(1),
  },
];

export const INITIAL_PRODUCTS: Product[] = [
  {
    id: 'prod_lepeshka_tandyr',
    name: 'Лепёшка тандырная горячая 300г',
    barcode: '',
    pluCode: '000001',
    category: 'Выпечка',
    quickCategory: 'Лепёшки',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 6,
    costPrice: 3.8,
    stock: 42,
    minStock: 15,
    expiryDate: daysFromNowISO(3),
    supplierName: 'Тандыр Пекарня №1',
    imageUrl: STORE_IMAGES.bakery,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_lepeshka_kunzhut',
    name: 'Лепёшка домашняя с кунжутом',
    barcode: '',
    pluCode: '000002',
    category: 'Выпечка',
    quickCategory: 'Лепёшки',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 8,
    costPrice: 5,
    stock: 28,
    minStock: 10,
    expiryDate: daysFromNowISO(4),
    supplierName: 'Тандыр Пекарня №1',
    imageUrl: STORE_IMAGES.bakery,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_bread_white',
    name: 'Хлеб белый формовой 500г',
    barcode: '',
    pluCode: '000006',
    category: 'Выпечка',
    quickCategory: 'Хлеб',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 8,
    costPrice: 5,
    stock: 36,
    minStock: 12,
    expiryDate: daysFromNowISO(3),
    supplierName: 'Тандыр Пекарня №1',
    imageUrl: STORE_IMAGES.bakery,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_pampers_single',
    name: 'Памперсы Pampers Active (поштучно)',
    barcode: '',
    pluCode: '000003',
    category: 'Детские товары',
    quickCategory: 'Пакеты и хозтовары',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 35,
    costPrice: 22,
    stock: 64,
    minStock: 20,
    expiryDate: daysFromNowISO(365),
    supplierName: 'БэбиТрейд',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_gum_orbit',
    name: 'Жвачка Orbit Сладкая Мята',
    barcode: '4607065001122',
    pluCode: '000004',
    category: 'Кондитерка',
    quickCategory: 'Жвачки',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 6,
    costPrice: 3.8,
    stock: 9,
    minStock: 20,
    expiryDate: daysFromNowISO(180),
    supplierName: 'КондитерОпт',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_paket_mayka',
    name: 'Пакет-майка фирменный прочный',
    barcode: '',
    pluCode: '000005',
    category: 'Хозтовары',
    quickCategory: 'Пакеты и хозтовары',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 1,
    costPrice: 0.4,
    stock: 340,
    minStock: 100,
    expiryDate: daysFromNowISO(900),
    supplierName: 'ПакетСервис',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: false,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_milk_farm',
    name: 'Молоко фермерское цельное 1л',
    barcode: '4601001001011',
    pluCode: '000010',
    category: 'Молочные',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: false,
    retailPrice: 14,
    costPrice: 9.5,
    stock: 18,
    minStock: 12,
    expiryDate: daysFromNowISO(7),
    supplierName: 'Ферма Дубрава',
    imageUrl: STORE_IMAGES.dairy,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_cheese_aged',
    name: 'Сыр твердый выдержанный (весовой)',
    barcode: buildWeightedBarcodeSample('000101', 500),
    pluCode: '000101',
    category: 'Молочные',
    quickCategory: 'Весовые',
    unit: 'кг',
    isWeighted: true,
    isQuickItem: true,
    retailPrice: 98,
    costPrice: 69,
    stock: 6.4,
    minStock: 3,
    expiryDate: daysFromNowISO(13),
    supplierName: 'Сыроварня Север',
    imageUrl: STORE_IMAGES.dairy,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_cream_artisan',
    name: 'Сметана фермерская густая 250г',
    barcode: '4601001002025',
    pluCode: '000011',
    category: 'Молочные',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: false,
    retailPrice: 16,
    costPrice: 10.5,
    stock: 4,
    minStock: 10,
    expiryDate: daysFromNowISO(5),
    supplierName: 'Ферма Дубрава',
    imageUrl: STORE_IMAGES.dairy,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_apples_gala',
    name: 'Яблоки красные Гала (весовые)',
    barcode: buildWeightedBarcodeSample('000201', 1000),
    pluCode: '000201',
    category: 'Овощи и фрукты',
    quickCategory: 'Весовые',
    unit: 'кг',
    isWeighted: true,
    isQuickItem: true,
    retailPrice: 17,
    costPrice: 11.2,
    stock: 24.5,
    minStock: 10,
    expiryDate: daysFromNowISO(14),
    supplierName: 'АгроСад Юг',
    imageUrl: STORE_IMAGES.produce,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_tomatoes_vine',
    name: 'Томаты спелые на ветке (весовые)',
    barcode: buildWeightedBarcodeSample('000202', 1000),
    pluCode: '000202',
    category: 'Овощи и фрукты',
    quickCategory: 'Весовые',
    unit: 'кг',
    isWeighted: true,
    isQuickItem: true,
    retailPrice: 25,
    costPrice: 17.5,
    stock: 7.2,
    minStock: 8,
    expiryDate: daysFromNowISO(6),
    supplierName: 'Теплица Эко',
    imageUrl: STORE_IMAGES.produce,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_water_sparkling',
    name: 'Вода минеральная газированная 0.5л',
    barcode: '4603003003050',
    pluCode: '000030',
    category: 'Напитки',
    quickCategory: 'Напитки',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: true,
    retailPrice: 5,
    costPrice: 2.8,
    stock: 56,
    minStock: 24,
    expiryDate: daysFromNowISO(240),
    supplierName: 'АкваИсточник',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_coffee_beans',
    name: 'Кофе зерновой Эфиопия 250г',
    barcode: '4604004004250',
    pluCode: '000040',
    category: 'Бакалея',
    unit: 'уп',
    isWeighted: false,
    isQuickItem: false,
    retailPrice: 64,
    costPrice: 43,
    stock: 11,
    minStock: 6,
    expiryDate: daysFromNowISO(190),
    supplierName: 'Origin Roasters',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'prod_chocolate_dark',
    name: 'Шоколад ремесленный 70% какао',
    barcode: '4605005005070',
    pluCode: '000050',
    category: 'Кондитерка',
    unit: 'шт',
    isWeighted: false,
    isQuickItem: false,
    retailPrice: 22,
    costPrice: 14.5,
    stock: 19,
    minStock: 8,
    expiryDate: daysFromNowISO(120),
    supplierName: 'КондитерОпт',
    imageUrl: STORE_IMAGES.pantry,
    activeOnline: true,
    updatedAt: new Date().toISOString(),
  },
];

let seedInProgress = false;

export async function ensureInitialStoreSeed(ownerUid: string, ownerName: string): Promise<void> {
  if (seedInProgress) return;
  seedInProgress = true;
  try {
    const prodSnap = await getDocs(query(collection(db, 'products'), limit(1)));
    const publicSettingsSnap = await getDoc(doc(db, 'store_settings', 'public_store'));
    const posSecuritySnap = await getDoc(doc(db, 'store_settings', 'pos_security'));

    const legacyPublicData = publicSettingsSnap.exists()
      ? (publicSettingsSnap.data() as Partial<StoreSettings> & { adminPinHash?: string })
      : null;

    if (!posSecuritySnap.exists()) {
      const migratedHash =
        typeof legacyPublicData?.adminPinHash === 'string' && legacyPublicData.adminPinHash.length >= 4
          ? legacyPublicData.adminPinHash
          : await sha256Hex('1234');
      const posSecurityDoc: PosSecuritySettings = {
        id: 'pos_security',
        adminPinHash: migratedHash,
        updatedAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'store_settings', 'pos_security'), posSecurityDoc);
    }

    if (!publicSettingsSnap.exists() || (legacyPublicData && 'adminPinHash' in legacyPublicData)) {
      const cleanPublicSettings: StoreSettings = {
        id: 'public_store',
        storeName: legacyPublicData?.storeName || 'FreshMart Pro',
        qrMerchantId: legacyPublicData?.qrMerchantId || 'FRESHMART-SBP-001',
        updatedAt: new Date().toISOString(),
      };
      await setDoc(doc(db, 'store_settings', 'public_store'), cleanPublicSettings);
    }

    const supSnap = await getDocs(query(collection(db, 'suppliers'), limit(1)));
    if (supSnap.empty) {
      const supBatch = writeBatch(db);
      for (const s of INITIAL_SUPPLIERS) {
        supBatch.set(doc(db, 'suppliers', s.id), { ...s, createdBy: ownerUid });
      }
      await supBatch.commit();
    }

    if (!prodSnap.empty) {
      return;
    }

    const batch = writeBatch(db);
    for (const p of INITIAL_PRODUCTS) {
      batch.set(doc(db, 'products', p.id), p);
    }

    const sampleSales: Sale[] = [
      {
        id: 'sale_seed_1',
        receiptNumber: 'ЧК-1001',
        type: 'sale',
        channel: 'pos',
        cashierId: ownerUid,
        cashierName: ownerName,
        items: [
          {
            productId: 'prod_lepeshka_tandyr',
            name: 'Лепешка тандырная горячая 300г',
            category: 'Выпечка',
            unit: 'шт',
            quantity: 4,
            unitPrice: 65,
            costPrice: 38,
            lineTotal: 260,
          },
          {
            productId: 'prod_milk_farm',
            name: 'Молоко фермерское цельное 1л',
            category: 'Молочные',
            unit: 'шт',
            quantity: 3,
            unitPrice: 129,
            costPrice: 88,
            lineTotal: 387,
          },
        ],
        totalAmount: 647,
        costTotal: 416,
        cashAmount: 647,
        cardAmount: 0,
        qrAmount: 0,
        paymentMethod: 'cash',
        syncedFromOffline: false,
        createdAt: daysAgoISO(3),
      },
      {
        id: 'sale_seed_2',
        receiptNumber: 'ЧК-1002',
        type: 'sale',
        channel: 'pos',
        cashierId: ownerUid,
        cashierName: ownerName,
        items: [
          {
            productId: 'prod_cheese_aged',
            name: 'Сыр твердый выдержанный (весовой)',
            category: 'Молочные',
            unit: 'кг',
            quantity: 1.25,
            unitPrice: 980,
            costPrice: 690,
            lineTotal: 1225,
          },
          {
            productId: 'prod_coffee_beans',
            name: 'Кофе зерновой Эфиопия 250г',
            category: 'Бакалея',
            unit: 'уп',
            quantity: 2,
            unitPrice: 640,
            costPrice: 430,
            lineTotal: 1280,
          },
        ],
        totalAmount: 2505,
        costTotal: 1722.5,
        cashAmount: 1000,
        cardAmount: 1505,
        qrAmount: 0,
        paymentMethod: 'split',
        syncedFromOffline: false,
        createdAt: daysAgoISO(2),
      },
      {
        id: 'sale_seed_3',
        receiptNumber: 'ЧК-1003',
        type: 'sale',
        channel: 'online',
        cashierId: ownerUid,
        cashierName: ownerName,
        items: [
          {
            productId: 'prod_apples_gala',
            name: 'Яблоки красные Гала (весовые)',
            category: 'Овощи и фрукты',
            unit: 'кг',
            quantity: 3,
            unitPrice: 169,
            costPrice: 112,
            lineTotal: 507,
          },
          {
            productId: 'prod_water_sparkling',
            name: 'Вода минеральная газированная 0.5л',
            category: 'Напитки',
            unit: 'шт',
            quantity: 6,
            unitPrice: 79,
            costPrice: 45,
            lineTotal: 474,
          },
        ],
        totalAmount: 981,
        costTotal: 606,
        cashAmount: 0,
        cardAmount: 981,
        qrAmount: 0,
        paymentMethod: 'online',
        syncedFromOffline: false,
        createdAt: daysAgoISO(1),
      },
    ];

    for (const s of sampleSales) {
      batch.set(doc(db, 'sales', s.id), s);
    }

    const sampleExpenses: Expense[] = [
      {
        id: 'exp_seed_1',
        category: 'Аренда',
        amount: 45000,
        description: 'Аренда торгового зала (текущий месяц)',
        expenseDate: daysAgoISO(5).slice(0, 10),
        createdBy: ownerUid,
        createdAt: daysAgoISO(5),
      },
      {
        id: 'exp_seed_2',
        category: 'Закупка товара',
        amount: 18400,
        description: 'Поставка молочной продукции и сыров',
        expenseDate: daysAgoISO(3).slice(0, 10),
        createdBy: ownerUid,
        createdAt: daysAgoISO(3),
      },
      {
        id: 'exp_seed_3',
        category: 'Логистика',
        amount: 2400,
        description: 'Доставка свежей выпечки и овощей',
        expenseDate: daysAgoISO(1).slice(0, 10),
        createdBy: ownerUid,
        createdAt: daysAgoISO(1),
      },
    ];

    for (const e of sampleExpenses) {
      batch.set(doc(db, 'expenses', e.id), e);
    }

    const sampleWriteOff: WriteOff = {
      id: 'wo_seed_1',
      productId: 'prod_cream_artisan',
      productName: 'Сметана фермерская густая 250г',
      category: 'Молочные',
      quantity: 2,
      unit: 'шт',
      costValue: 192,
      reason: 'damaged',
      notes: 'Повреждена упаковка при выкладке',
      createdBy: ownerUid,
      createdByName: ownerName,
      createdAt: daysAgoISO(2),
    };
    batch.set(doc(db, 'write_offs', sampleWriteOff.id), sampleWriteOff);

    const sampleReq: PurchaseRequest = {
      id: 'req_seed_1',
      requestNumber: 'ЗК-2041',
      requesterId: ownerUid,
      requesterName: ownerName,
      supplierName: 'КондитерОпт',
      items: [
        {
          productId: 'prod_gum_orbit',
          name: 'Жвачка Orbit Сладкая Мята',
          category: 'Кондитерка',
          unit: 'шт',
          quantity: 40,
          estimatedCost: 1240,
          isNewProduct: false,
        },
      ],
      isAutoGenerated: true,
      status: 'new',
      comment: 'Критически низкий остаток на прикассовой зоне',
      unreadForRequester: true,
      createdAt: daysAgoISO(1),
      updatedAt: daysAgoISO(1),
    };
    batch.set(doc(db, 'purchase_requests', sampleReq.id), sampleReq);

    await batch.commit();
  } catch (err) {
    console.warn('Seed skipped or failed:', err);
  } finally {
    seedInProgress = false;
  }
}
