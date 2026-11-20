import React, { useEffect, useMemo, useState } from 'react';
import {
  LogIn,
  LogOut,
  ShieldCheck,
  WifiOff,
} from 'lucide-react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  auth,
  db,
  googleProvider,
  handleFirestoreError,
  OperationType,
  testConnection,
} from './firebase';
import type {
  Expense,
  InventoryAudit,
  OnlineOrder,
  PosSecuritySettings,
  Product,
  PurchaseRequest,
  Sale,
  SecurityLog,
  Shift,
  StaffInvite,
  StoreSettings,
  Supplier,
  SupplierInvoice,
  SupplierPayment,
  SupplierReturn,
  UserProfile,
  UserRole,
  WorkspaceTab,
  WriteOff,
} from './types';
import {
  INITIAL_PRODUCTS,
  INITIAL_SUPPLIERS,
  ensureInitialStoreSeed,
} from './utils/seedData';
import { normalizePluCode } from './utils/barcode';
import { loadCatalogCache, saveCatalogCache } from './utils/offlineSync';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { ErrorBoundary } from './components/ErrorBoundary';
import { PWAInstallButton } from './components/PWAInstallButton';
import { TwoFactorModal } from './components/TwoFactorModal';
import { StorefrontView } from './components/StorefrontView';
import { CashierPOSView } from './components/CashierPOSView';
import { AdminWarehouseView } from './components/AdminWarehouseView';
import { OwnerAnalyticsView } from './components/OwnerAnalyticsView';
import { RequesterPortalView } from './components/RequesterPortalView';
import { AuthPortalScreen } from './components/AuthPortalScreen';

const BOOTSTRAPPED_OWNER_EMAIL = 'diljamiksabrin1986r@gmail.com';
const PORTAL_SESSION_STORAGE_KEY = 'freshmart_portal_session_v1';
const LOCAL_SUPPLIERS_STORAGE_KEY = 'freshmart_local_suppliers_v1';

function normalizeProductPlu(product: Product): Product {
  if (!product.pluCode) return product;
  const normalized = normalizePluCode(product.pluCode);
  return normalized === product.pluCode ? product : { ...product, pluCode: normalized };
}

function loadLocalSuppliers(): Supplier[] {
  try {
    const raw = localStorage.getItem(LOCAL_SUPPLIERS_STORAGE_KEY);
    if (!raw) return INITIAL_SUPPLIERS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as Supplier[]) : INITIAL_SUPPLIERS;
  } catch {
    return INITIAL_SUPPLIERS;
  }
}

function saveLocalSuppliers(list: Supplier[]): void {
  try {
    localStorage.setItem(LOCAL_SUPPLIERS_STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Ignore storage quota errors
  }
}

type PortalSession =
  | { mode: 'admin'; login: string; displayName: string }
  | { mode: 'cashier'; displayName: string };

const ROLE_LABELS: Record<UserRole, string> = {
  owner: 'Руководитель',
  admin: 'Администратор',
  cashier: 'Кассир',
  requester: 'Заявщик',
  customer: 'Покупатель',
};

function loadInitialPortalSession(): PortalSession | null {
  try {
    const raw = sessionStorage.getItem(PORTAL_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PortalSession>;
    if (parsed.mode === 'admin' && typeof parsed.login === 'string') {
      return {
        mode: 'admin',
        login: parsed.login,
        displayName: parsed.displayName || 'Администратор',
      };
    }
    if (parsed.mode === 'cashier') {
      return {
        mode: 'cashier',
        displayName: parsed.displayName || 'Кассир смены',
      };
    }
    return null;
  } catch {
    return null;
  }
}

function MainApp() {
  const isBrowserOnline = useOnlineStatus();

  const [portalSession, setPortalSession] = useState<PortalSession | null>(
    loadInitialPortalSession
  );

  const [authReady, setAuthReady] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // 2FA session verification & setup
  const [twoFactorVerified, setTwoFactorVerified] = useState(false);
  const [twoFactorModalMode, setTwoFactorModalMode] = useState<'setup' | 'verify' | null>(null);

  // Active workspace tab
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('owner');

  // Store data
  const [products, setProducts] = useState<Product[]>(() => {
    const cached = loadCatalogCache();
    const base = cached.length > 0 ? cached : INITIAL_PRODUCTS;
    return base.map(normalizeProductPlu);
  });
  const [storeSettings, setStoreSettings] = useState<StoreSettings | null>(null);
  const [posSecurity, setPosSecurity] = useState<PosSecuritySettings | null>(null);
  const [sales, setSales] = useState<Sale[]>([]);
  const [localSales, setLocalSales] = useState<Sale[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [writeOffs, setWriteOffs] = useState<WriteOff[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [localSuppliers, setLocalSuppliers] = useState<Supplier[]>(loadLocalSuppliers);
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [localInvoices, setLocalInvoices] = useState<SupplierInvoice[]>([]);
  const [inventories, setInventories] = useState<InventoryAudit[]>([]);
  const [purchaseRequests, setPurchaseRequests] = useState<PurchaseRequest[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [localExpenses, setLocalExpenses] = useState<Expense[]>([]);
  const [securityLogs, setSecurityLogs] = useState<SecurityLog[]>([]);
  const [onlineOrders, setOnlineOrders] = useState<OnlineOrder[]>([]);
  const [localOnlineOrders, setLocalOnlineOrders] = useState<OnlineOrder[]>([]);
  const [supplierPayments, setSupplierPayments] = useState<SupplierPayment[]>([]);
  const [localSupplierPayments, setLocalSupplierPayments] = useState<SupplierPayment[]>([]);
  const [supplierReturns, setSupplierReturns] = useState<SupplierReturn[]>([]);
  const [staffInvites, setStaffInvites] = useState<StaffInvite[]>([]);
  const [staffUsers, setStaffUsers] = useState<UserProfile[]>([]);

  useEffect(() => {
    testConnection();
  }, []);

  useEffect(() => {
    try {
      if (portalSession) {
        sessionStorage.setItem(PORTAL_SESSION_STORAGE_KEY, JSON.stringify(portalSession));
      } else {
        sessionStorage.removeItem(PORTAL_SESSION_STORAGE_KEY);
      }
    } catch {
      // Ignore storage quota errors
    }
  }, [portalSession]);

  // Auth & Profile Bootstrapping (optional Google Cloud sync)
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setFirebaseUser(fbUser);
      setTwoFactorVerified(false);
      setAuthError(null);

      if (!fbUser) {
        setUserProfile(null);
        setAuthReady(true);
        return;
      }

      try {
        const userRef = doc(db, 'users', fbUser.uid);
        const snap = await getDoc(userRef);
        const email = (fbUser.email || '').toLowerCase();

        if (snap.exists()) {
          const profile = snap.data() as UserProfile;
          setUserProfile(profile);
          if (profile.role === 'owner') {
            ensureInitialStoreSeed(profile.uid, profile.displayName);
          }
          if (profile.twoFactorEnabled && profile.role !== 'customer') {
            setTwoFactorModalMode('verify');
          } else {
            setTwoFactorVerified(true);
          }
        } else {
          // Determine role from bootstrapped owner or staff_invites
          let assignedRole: UserRole = 'customer';
          let twoFactorRequired = false;

          if (email === BOOTSTRAPPED_OWNER_EMAIL && fbUser.emailVerified) {
            assignedRole = 'owner';
          } else if (email) {
            try {
              const invSnap = await getDoc(doc(db, 'staff_invites', email));
              if (invSnap.exists()) {
                const inv = invSnap.data() as StaffInvite;
                if (inv.active) {
                  assignedRole = inv.role;
                  twoFactorRequired = inv.twoFactorRequired;
                }
              }
            } catch {
              // No invite found -> default customer
            }
          }

          const now = new Date().toISOString();
          const newProfile: UserProfile = {
            uid: fbUser.uid,
            email: fbUser.email || `${fbUser.uid}@freshmart.local`,
            displayName: fbUser.displayName || fbUser.email?.split('@')[0] || 'Пользователь',
            role: assignedRole,
            twoFactorEnabled: twoFactorRequired,
            active: true,
            createdAt: now,
            updatedAt: now,
          };

          await setDoc(userRef, newProfile);
          setUserProfile(newProfile);

          if (assignedRole === 'owner') {
            await ensureInitialStoreSeed(newProfile.uid, newProfile.displayName);
          }
          setTwoFactorVerified(true);
        }
      } catch (err) {
        setAuthError(
          err instanceof Error ? err.message : 'Не удалось загрузить профиль пользователя'
        );
      } finally {
        setAuthReady(true);
      }
    });

    return () => unsub();
  }, []);

  // Public Catalog & Public Store Settings listeners
  useEffect(() => {
    const unsubProducts = onSnapshot(
      collection(db, 'products'),
      (snap) => {
        if (snap.empty) return;
        const list = snap.docs.map((d) => normalizeProductPlu(d.data() as Product));
        list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
        setProducts(list);
        saveCatalogCache(list);
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'products')
    );
    const unsubSettings = onSnapshot(
      doc(db, 'store_settings', 'public_store'),
      (snap) => {
        if (snap.exists()) setStoreSettings(snap.data() as StoreSettings);
      },
      (err) => handleFirestoreError(err, OperationType.GET, 'store_settings/public_store')
    );
    return () => {
      unsubProducts();
      unsubSettings();
    };
  }, []);

  // Role-scoped Firestore listeners (active only when Google account is connected)
  useEffect(() => {
    if (!authReady || !userProfile) {
      setSales([]);
      setShifts([]);
      setWriteOffs([]);
      setSuppliers([]);
      setInvoices([]);
      setInventories([]);
      setPurchaseRequests([]);
      setExpenses([]);
      setSecurityLogs([]);
      setOnlineOrders([]);
      setSupplierPayments([]);
      setSupplierReturns([]);
      setStaffInvites([]);
      setStaffUsers([]);
      setPosSecurity(null);
      return;
    }

    const unsubs: (() => void)[] = [];
    const role = userProfile.role;
    const isStaff = role !== 'customer';
    const isAdminOrOwner = role === 'owner' || role === 'admin';
    const isOwner = role === 'owner';

    // Staff-only POS Security Settings (Admin PIN hash isolated from public_store)
    if (isStaff) {
      unsubs.push(
        onSnapshot(
          doc(db, 'store_settings', 'pos_security'),
          (snap) => {
            if (snap.exists()) setPosSecurity(snap.data() as PosSecuritySettings);
          },
          (err) => handleFirestoreError(err, OperationType.GET, 'store_settings/pos_security')
        )
      );
    } else {
      setPosSecurity(null);
    }

    // Online orders
    if (isAdminOrOwner) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'online_orders'), orderBy('createdAt', 'desc')),
          (snap) => setOnlineOrders(snap.docs.map((d) => d.data() as OnlineOrder)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'online_orders')
        )
      );
    } else {
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'online_orders'),
            where('customerId', '==', userProfile.uid)
          ),
          (snap) => {
            const list = snap.docs.map((d) => d.data() as OnlineOrder);
            list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            setOnlineOrders(list);
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'online_orders')
        )
      );
    }

    // Shifts
    if (isOwner) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'shifts'), orderBy('openedAt', 'desc')),
          (snap) => setShifts(snap.docs.map((d) => d.data() as Shift)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'shifts')
        )
      );
    } else if (role === 'cashier' || role === 'admin') {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'shifts'), where('cashierId', '==', userProfile.uid)),
          (snap) => {
            const list = snap.docs.map((d) => d.data() as Shift);
            list.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
            setShifts(list);
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'shifts')
        )
      );
    }

    // Purchase Requests
    if (isAdminOrOwner) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'purchase_requests'), orderBy('createdAt', 'desc')),
          (snap) => setPurchaseRequests(snap.docs.map((d) => d.data() as PurchaseRequest)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'purchase_requests')
        )
      );
    } else if (role === 'requester') {
      unsubs.push(
        onSnapshot(
          query(
            collection(db, 'purchase_requests'),
            where('requesterId', '==', userProfile.uid)
          ),
          (snap) => {
            const list = snap.docs.map((d) => d.data() as PurchaseRequest);
            list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            setPurchaseRequests(list);
          },
          (err) => handleFirestoreError(err, OperationType.LIST, 'purchase_requests')
        )
      );
    }

    // Admin & Owner warehouse/expenses collections
    if (isAdminOrOwner) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'write_offs'), orderBy('createdAt', 'desc')),
          (snap) => setWriteOffs(snap.docs.map((d) => d.data() as WriteOff)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'write_offs')
        ),
        onSnapshot(
          query(collection(db, 'suppliers'), orderBy('name', 'asc')),
          (snap) => setSuppliers(snap.docs.map((d) => d.data() as Supplier)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'suppliers')
        ),
        onSnapshot(
          query(collection(db, 'invoices'), orderBy('createdAt', 'desc')),
          (snap) => setInvoices(snap.docs.map((d) => d.data() as SupplierInvoice)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'invoices')
        ),
        onSnapshot(
          query(collection(db, 'inventories'), orderBy('createdAt', 'desc')),
          (snap) => setInventories(snap.docs.map((d) => d.data() as InventoryAudit)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'inventories')
        ),
        onSnapshot(
          query(collection(db, 'expenses'), orderBy('createdAt', 'desc')),
          (snap) => setExpenses(snap.docs.map((d) => d.data() as Expense)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'expenses')
        ),
        onSnapshot(
          query(collection(db, 'supplier_payments'), orderBy('createdAt', 'desc')),
          (snap) => setSupplierPayments(snap.docs.map((d) => d.data() as SupplierPayment)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'supplier_payments')
        ),
        onSnapshot(
          query(collection(db, 'supplier_returns'), orderBy('createdAt', 'desc')),
          (snap) => setSupplierReturns(snap.docs.map((d) => d.data() as SupplierReturn)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'supplier_returns')
        ),
        onSnapshot(
          collection(db, 'users'),
          (snap) => setStaffUsers(snap.docs.map((d) => d.data() as UserProfile)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'users')
        )
      );
    }

    // STRICTLY OWNER-ONLY financial & security listeners
    if (isOwner) {
      unsubs.push(
        onSnapshot(
          query(collection(db, 'sales'), orderBy('createdAt', 'desc')),
          (snap) => setSales(snap.docs.map((d) => d.data() as Sale)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'sales')
        ),
        onSnapshot(
          query(collection(db, 'security_logs'), orderBy('createdAt', 'desc')),
          (snap) => setSecurityLogs(snap.docs.map((d) => d.data() as SecurityLog)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'security_logs')
        ),
        onSnapshot(
          collection(db, 'staff_invites'),
          (snap) => setStaffInvites(snap.docs.map((d) => d.data() as StaffInvite)),
          (err) => handleFirestoreError(err, OperationType.LIST, 'staff_invites')
        )
      );
    }

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [authReady, userProfile]);

  const handleSignIn = async () => {
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка авторизации Google');
    }
  };

  const handleGoogleSignOut = async () => {
    try {
      await signOut(auth);
    } catch {
      // Ignore
    }
  };

  const handlePortalLogout = () => {
    setPortalSession(null);
  };

  const handleAdminPortalLogin = (login: string, displayName: string) => {
    setPortalSession({ mode: 'admin', login, displayName });
    setActiveTab('owner');
  };

  const handleCashierPinLogin = () => {
    setPortalSession({ mode: 'cashier', displayName: 'Кассир смены' });
    setActiveTab('pos');
  };

  const handleEnable2FA = async (secret: string) => {
    if (!userProfile) return;
    try {
      await updateDoc(doc(db, 'users', userProfile.uid), {
        twoFactorEnabled: true,
        twoFactorSecret: secret,
        updatedAt: new Date().toISOString(),
      });
      setUserProfile((prev) =>
        prev ? { ...prev, twoFactorEnabled: true, twoFactorSecret: secret } : prev
      );
      setTwoFactorVerified(true);
      setTwoFactorModalMode(null);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, `users/${userProfile.uid}`);
    }
  };

  const canWriteCloud = Boolean(
    firebaseUser && userProfile && userProfile.role !== 'customer'
  );

  // Effective profile driven by portalSession + optional Firebase cloud identity
  const effectiveProfile = useMemo<UserProfile | null>(() => {
    if (!portalSession) return null;
    const now = new Date().toISOString();
    if (portalSession.mode === 'cashier') {
      return {
        uid: firebaseUser?.uid || 'local_cashier_shift',
        email: firebaseUser?.email || 'cashier@freshmart.local',
        displayName: userProfile?.displayName || portalSession.displayName,
        role: 'cashier',
        twoFactorEnabled: false,
        active: true,
        createdAt: userProfile?.createdAt || now,
        updatedAt: now,
      };
    }
    return {
      uid: firebaseUser?.uid || 'local_admin_owner',
      email: firebaseUser?.email || `${portalSession.login}@freshmart.local`,
      displayName: userProfile?.displayName || portalSession.displayName,
      role: 'owner',
      twoFactorEnabled: userProfile?.twoFactorEnabled || false,
      twoFactorSecret: userProfile?.twoFactorSecret,
      active: true,
      createdAt: userProfile?.createdAt || now,
      updatedAt: now,
    };
  }, [portalSession, firebaseUser, userProfile]);

  const activeShift = useMemo(
    () =>
      shifts.find(
        (s) => s.status === 'open' && (!effectiveProfile || s.cashierId === effectiveProfile.uid)
      ) || null,
    [shifts, effectiveProfile]
  );

  const mergedSales = useMemo(() => {
    const map = new Map<string, Sale>();
    for (const s of sales) map.set(s.id, s);
    for (const s of localSales) {
      if (!map.has(s.id)) map.set(s.id, s);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [sales, localSales]);

  const mergedOnlineOrders = useMemo(() => {
    const map = new Map<string, OnlineOrder>();
    for (const o of onlineOrders) map.set(o.id, o);
    for (const o of localOnlineOrders) {
      map.set(o.id, o);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [onlineOrders, localOnlineOrders]);

  const mergedSuppliers = useMemo(() => {
    const map = new Map<string, Supplier>();
    for (const s of localSuppliers) map.set(s.id, s);
    for (const s of suppliers) map.set(s.id, s);
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }, [suppliers, localSuppliers]);

  const mergedInvoices = useMemo(() => {
    const map = new Map<string, SupplierInvoice>();
    for (const inv of invoices) map.set(inv.id, inv);
    for (const inv of localInvoices) {
      if (!map.has(inv.id)) map.set(inv.id, inv);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [invoices, localInvoices]);

  const mergedSupplierPayments = useMemo(() => {
    const map = new Map<string, SupplierPayment>();
    for (const p of supplierPayments) map.set(p.id, p);
    for (const p of localSupplierPayments) {
      if (!map.has(p.id)) map.set(p.id, p);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [supplierPayments, localSupplierPayments]);

  const mergedExpenses = useMemo(() => {
    const map = new Map<string, Expense>();
    for (const exp of expenses) map.set(exp.id, exp);
    for (const exp of localExpenses) {
      if (!map.has(exp.id)) map.set(exp.id, exp);
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [expenses, localExpenses]);

  const handleProductSaved = (product: Product) => {
    const clean = normalizeProductPlu(product);
    setProducts((prev) => {
      const exists = prev.some((p) => p.id === clean.id);
      const next = exists
        ? prev.map((p) => (p.id === clean.id ? clean : p))
        : [...prev, clean];
      next.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      saveCatalogCache(next);
      return next;
    });
  };

  const handlePosProductSaved = async (product: Product) => {
    const clean = normalizeProductPlu(product);
    handleProductSaved(clean);
    if (
      canWriteCloud &&
      userProfile &&
      (userProfile.role === 'owner' || userProfile.role === 'admin')
    ) {
      try {
        await setDoc(doc(db, 'products', clean.id), clean);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `products/${clean.id}`);
      }
    }
  };

  const handleLocalSupplierSaved = (supplier: Supplier) => {
    setLocalSuppliers((prev) => {
      const exists = prev.some((s) => s.id === supplier.id);
      const next = exists
        ? prev.map((s) => (s.id === supplier.id ? supplier : s))
        : [...prev, supplier];
      next.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      saveLocalSuppliers(next);
      return next;
    });
  };

  const handleLocalProcurementCommitted = (payload: {
    invoice: SupplierInvoice;
    updatedProducts: Product[];
    payment?: SupplierPayment;
    expense?: Expense;
  }) => {
    setProducts((prev) => {
      const map = new Map<string, Product>();
      for (const p of prev) map.set(p.id, p);
      for (const up of payload.updatedProducts) map.set(up.id, normalizeProductPlu(up));
      const next = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
      saveCatalogCache(next);
      return next;
    });
    setLocalInvoices((prev) => [payload.invoice, ...prev]);
    if (payload.payment) {
      setLocalSupplierPayments((prev) => [payload.payment!, ...prev]);
    }
    if (payload.expense) {
      setLocalExpenses((prev) => [payload.expense!, ...prev]);
    }
  };

  const handleLocalStockAdjust = (deltas: { productId: string; delta: number }[]) => {
    setProducts((prev) => {
      const updated = prev.map((p) => {
        const d = deltas.find((x) => x.productId === p.id);
        if (!d) return p;
        return { ...p, stock: Math.max(0, Math.round((p.stock + d.delta) * 1000) / 1000) };
      });
      saveCatalogCache(updated);
      return updated;
    });
  };

  const handleLocalSaleRecorded = (sale: Sale) => {
    setLocalSales((prev) => [sale, ...prev]);
  };

  const handleLocalOrderCreated = (
    order: OnlineOrder,
    sale: Sale | null,
    stockDeltas: { productId: string; delta: number }[]
  ) => {
    setLocalOnlineOrders((prev) => [order, ...prev]);
    if (sale) {
      setLocalSales((prev) => [sale, ...prev]);
    }
    if (stockDeltas.length > 0) {
      handleLocalStockAdjust(stockDeltas);
    }
  };

  const handleLocalOrderUpdated = (
    orderId: string,
    patch: Partial<OnlineOrder>,
    sale?: Sale,
    stockDeltas?: { productId: string; delta: number }[]
  ) => {
    setLocalOnlineOrders((prev) => {
      const exists = prev.some((o) => o.id === orderId);
      if (exists) {
        return prev.map((o) => (o.id === orderId ? { ...o, ...patch } : o));
      }
      const fromCloud = onlineOrders.find((o) => o.id === orderId);
      return fromCloud ? [{ ...fromCloud, ...patch }, ...prev] : prev;
    });
    if (sale) {
      setLocalSales((prev) => [sale, ...prev]);
    }
    if (stockDeltas && stockDeltas.length > 0) {
      handleLocalStockAdjust(stockDeltas);
    }
  };

  const allowedTabs = useMemo<{ id: WorkspaceTab; label: string }[]>(() => {
    if (!portalSession || portalSession.mode === 'cashier') {
      return [{ id: 'pos', label: 'Касса (POS)' }];
    }
    return [
      { id: 'owner', label: 'Финансы и Аудит' },
      { id: 'admin', label: 'Склад и Закупки' },
      { id: 'pos', label: 'Касса (POS)' },
      { id: 'requester', label: 'Заявки' },
      { id: 'storefront', label: 'Онлайн-магазин' },
    ];
  }, [portalSession]);

  const effectiveTab: WorkspaceTab = allowedTabs.some((t) => t.id === activeTab)
    ? activeTab
    : allowedTabs[0].id;

  const requires2FAChallenge =
    Boolean(userProfile) &&
    portalSession?.mode === 'admin' &&
    userProfile!.role !== 'customer' &&
    userProfile!.twoFactorEnabled &&
    !twoFactorVerified;

  // 1. Start Authorization Screen (Role Selector: Admin vs Cashier)
  if (!portalSession || !effectiveProfile) {
    return (
      <AuthPortalScreen
        posSecurity={posSecurity}
        googleUserEmail={firebaseUser?.email}
        googleAuthError={authError}
        onAdminLoginSuccess={handleAdminPortalLogin}
        onCashierPinSuccess={handleCashierPinLogin}
        onGoogleSignIn={handleSignIn}
      />
    );
  }

  // 2. STRICT FULL-SCREEN CASHIER LOCK (ONLY POS + "Выйти / Сменить смену")
  if (portalSession.mode === 'cashier') {
    return (
      <CashierPOSView
        user={effectiveProfile}
        products={products}
        activeShift={activeShift}
        storeSettings={storeSettings}
        posSecurity={posSecurity}
        isBrowserOnline={isBrowserOnline}
        canWriteCloud={canWriteCloud}
        isCashierFullscreen={true}
        onExitShift={handlePortalLogout}
        onLocalStockAdjust={handleLocalStockAdjust}
        onLocalSaleRecorded={handleLocalSaleRecorded}
        onProductSaved={handlePosProductSaved}
      />
    );
  }

  // 3. Full Admin / Owner Portal
  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* Top Bar Contract (Clean 3-Zone Header) */}
      <header className="bg-white border-b border-slate-200 sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-6">
          <button
            type="button"
            onClick={() => setActiveTab('owner')}
            className="text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            FreshMart Pro Imon
          </button>

          <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 overflow-x-auto">
            {allowedTabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`whitespace-nowrap shrink-0 py-1 border-b-2 transition-colors ${
                  effectiveTab === t.id
                    ? 'border-emerald-600 text-slate-900 font-semibold'
                    : 'border-transparent hover:text-slate-900'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center gap-2.5 shrink-0">
            <PWAInstallButton />
            {userProfile && userProfile.role !== 'customer' ? (
              <button
                type="button"
                onClick={() => setTwoFactorModalMode('setup')}
                className="hidden lg:inline-flex items-center gap-1 text-xs font-medium text-slate-600 hover:text-emerald-700 whitespace-nowrap"
                title="Настроить двухфакторную защиту (2FA)"
              >
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                {userProfile.twoFactorEnabled ? '2FA вкл.' : '2FA'}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSignIn}
                className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 whitespace-nowrap shrink-0"
                title="Подключить Google-аккаунт для облачной синхронизации Firestore"
              >
                <LogIn className="w-3.5 h-3.5" />
                Облако Google
              </button>
            )}
            <span className="hidden xl:inline text-xs text-slate-600 whitespace-nowrap">
              {effectiveProfile.displayName} · {ROLE_LABELS[effectiveProfile.role]}
            </span>
            <button
              type="button"
              onClick={handlePortalLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-100 whitespace-nowrap shrink-0"
            >
              <LogOut className="w-3.5 h-3.5" />
              Выйти
            </button>
          </div>
        </div>

        {/* Mobile Tab Strip */}
        <div className="md:hidden border-t border-slate-200 px-4 py-2 flex items-center gap-2 overflow-x-auto bg-white">
          {allowedTabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setActiveTab(t.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg whitespace-nowrap shrink-0 ${
                effectiveTab === t.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      {!isBrowserOnline && (
        <div className="bg-amber-600 text-white text-xs font-medium px-4 py-2 text-center flex items-center justify-center gap-2">
          <WifiOff className="w-4 h-4" />
          Отсутствует подключение к интернету. Касса работает в офлайн-режиме с локальной очередью синхронизации.
        </div>
      )}

      {authError && (
        <div className="max-w-7xl mx-auto w-full px-4 sm:px-6 pt-4">
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-800 flex items-center justify-between gap-3">
            <span>{authError}</span>
            {firebaseUser && (
              <button
                type="button"
                onClick={handleGoogleSignOut}
                className="underline font-medium shrink-0"
              >
                Отключить Google
              </button>
            )}
          </div>
        </div>
      )}

      {/* Main Content Viewport */}
      <main
        className={
          effectiveTab === 'pos'
            ? 'flex-1 w-full flex flex-col'
            : 'flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 py-6'
        }
      >
        {!authReady ? (
          <div className="py-20 text-center text-sm text-slate-500">
            Загрузка рабочего пространства...
          </div>
        ) : requires2FAChallenge ? (
          <div className="max-w-md mx-auto bg-white border border-slate-200 rounded-xl p-6 text-center space-y-4">
            <ShieldCheck className="w-10 h-10 text-emerald-600 mx-auto" />
            <h2 className="text-lg font-semibold text-slate-900">
              Требуется подтверждение 2FA
            </h2>
            <p className="text-sm text-slate-600">
              Для защиты учетной записи сотрудника введите 6-значный код аутентификатора.
            </p>
            <button
              type="button"
              onClick={() => setTwoFactorModalMode('verify')}
              className="px-5 py-2.5 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
            >
              Ввести код 2FA
            </button>
          </div>
        ) : (
          <>
            {effectiveTab === 'storefront' && (
              <StorefrontView
                user={effectiveProfile}
                products={products}
                myOrders={mergedOnlineOrders}
                storeSettings={storeSettings}
                canWriteCloud={canWriteCloud}
                onRequireAuth={handleSignIn}
                onLocalOrderCreated={handleLocalOrderCreated}
              />
            )}

            {effectiveTab === 'pos' && (
              <CashierPOSView
                user={effectiveProfile}
                products={products}
                activeShift={activeShift}
                storeSettings={storeSettings}
                posSecurity={posSecurity}
                isBrowserOnline={isBrowserOnline}
                canWriteCloud={canWriteCloud}
                isCashierFullscreen={false}
                onLocalStockAdjust={handleLocalStockAdjust}
                onLocalSaleRecorded={handleLocalSaleRecorded}
                onProductSaved={handlePosProductSaved}
              />
            )}

            {effectiveTab === 'admin' && (
              <AdminWarehouseView
                user={effectiveProfile}
                products={products}
                suppliers={mergedSuppliers}
                writeOffs={writeOffs}
                invoices={mergedInvoices}
                inventories={inventories}
                purchaseRequests={purchaseRequests}
                expenses={mergedExpenses}
                onlineOrders={mergedOnlineOrders}
                supplierPayments={mergedSupplierPayments}
                supplierReturns={supplierReturns}
                canWriteCloud={canWriteCloud}
                onLocalProductSaved={handleProductSaved}
                onLocalSupplierSaved={handleLocalSupplierSaved}
                onLocalProcurementCommitted={handleLocalProcurementCommitted}
                onLocalOrderUpdated={handleLocalOrderUpdated}
              />
            )}

            {effectiveTab === 'requester' && (
              <RequesterPortalView
                user={effectiveProfile}
                products={products}
                requests={purchaseRequests}
              />
            )}

            {effectiveTab === 'owner' && (
              <OwnerAnalyticsView
                user={effectiveProfile}
                products={products}
                sales={mergedSales}
                expenses={mergedExpenses}
                writeOffs={writeOffs}
                shifts={shifts}
                invoices={mergedInvoices}
                supplierPayments={mergedSupplierPayments}
                supplierReturns={supplierReturns}
                securityLogs={securityLogs}
                staffInvites={staffInvites}
                staffUsers={staffUsers}
                storeSettings={storeSettings}
                posSecurity={posSecurity}
              />
            )}
          </>
        )}
      </main>

      {/* Quiet Footer */}
      {effectiveTab === 'storefront' && (
        <footer className="border-t border-slate-200 bg-white py-6 mt-8">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-500">
            <span>FreshMart Pro Imon · Продуктовый магазин и служба доставки</span>
            <span>Поддержка онлайн-оплаты и самовывоза</span>
          </div>
        </footer>
      )}

      {/* 2FA Modal */}
      {twoFactorModalMode && userProfile && (
        <TwoFactorModal
          email={userProfile.email}
          existingSecret={userProfile.twoFactorSecret}
          mode={twoFactorModalMode}
          onVerified={(secret) => {
            if (twoFactorModalMode === 'setup') {
              handleEnable2FA(secret);
            } else {
              setTwoFactorVerified(true);
              setTwoFactorModalMode(null);
            }
          }}
          onCancel={() => setTwoFactorModalMode(null)}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
