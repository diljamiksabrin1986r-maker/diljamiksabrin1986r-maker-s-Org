export type UserRole = 'owner' | 'admin' | 'cashier' | 'requester' | 'customer';

export type WorkspaceTab =
  | 'storefront'
  | 'pos'
  | 'admin'
  | 'requester'
  | 'owner';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: UserRole;
  twoFactorEnabled: boolean;
  twoFactorSecret?: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StaffInvite {
  email: string;
  name: string;
  role: Exclude<UserRole, 'customer'>;
  twoFactorRequired: boolean;
  active: boolean;
  createdBy: string;
  createdAt: string;
}

export type ProductUnit = 'шт' | 'кг' | 'л' | 'уп';

export interface Product {
  id: string;
  name: string;
  barcode?: string;
  pluCode?: string;
  category: string;
  unit: ProductUnit;
  isWeighted: boolean;
  isQuickItem: boolean;
  quickCategory?: string;
  retailPrice: number;
  costPrice: number;
  stock: number;
  minStock: number;
  expiryDate?: string;
  supplierName?: string;
  imageUrl?: string;
  activeOnline: boolean;
  updatedAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CartItem {
  productId: string;
  name: string;
  unit: ProductUnit;
  isWeighted: boolean;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  lineTotal: number;
}

export interface HeldReceipt {
  id: string;
  label: string;
  items: CartItem[];
  createdAt: string;
}

export interface SaleItem {
  productId: string;
  name: string;
  category: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  costPrice: number;
  lineTotal: number;
}

export interface Sale {
  id: string;
  receiptNumber: string;
  type: 'sale' | 'return';
  channel: 'pos' | 'online';
  shiftId?: string;
  cashierId: string;
  cashierName: string;
  items: SaleItem[];
  totalAmount: number;
  costTotal: number;
  cashAmount: number;
  cardAmount: number;
  qrAmount: number;
  paymentMethod: 'cash' | 'card' | 'qr' | 'split' | 'online';
  syncedFromOffline: boolean;
  authorizedBy?: string;
  createdAt: string;
}

export interface OfflineSaleQueueItem {
  sale: Sale;
  stockDeltas: { productId: string; delta: number }[];
  queuedAt: string;
}

export interface CashMovement {
  id: string;
  type: 'in' | 'out';
  amount: number;
  reason: string;
  createdAt: string;
}

export interface Shift {
  id: string;
  cashierId: string;
  cashierName: string;
  status: 'open' | 'closed';
  openingCash: number;
  cashSalesTotal: number;
  cardSalesTotal: number;
  qrSalesTotal: number;
  returnsTotal: number;
  cashInTotal: number;
  cashOutTotal: number;
  expectedCash: number;
  actualCash?: number;
  discrepancy?: number;
  movements: CashMovement[];
  openedAt: string;
  closedAt?: string;
}

export type WriteOffReason = 'expired' | 'damaged' | 'defect' | 'shortage';

export interface WriteOff {
  id: string;
  productId: string;
  productName: string;
  category: string;
  quantity: number;
  unit: string;
  costValue: number;
  reason: WriteOffReason;
  notes?: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export interface InvoiceItemInput {
  name: string;
  barcode?: string;
  category: string;
  unit: ProductUnit;
  quantity: number;
  costPrice: number;
  retailPrice: number;
  expiryDate?: string;
}

export interface SupplierInvoice {
  id: string;
  invoiceNumber: string;
  supplierId?: string;
  supplierName: string;
  supplierPhone?: string;
  items: InvoiceItemInput[];
  totalCost: number;
  parsedByAi: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export type SupplierPaymentMethod = 'cash' | 'bank_transfer' | 'card';

export interface SupplierPayment {
  id: string;
  supplierName: string;
  invoiceId?: string;
  invoiceNumber?: string;
  amount: number;
  paymentMethod: SupplierPaymentMethod;
  paymentDate: string;
  notes?: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export type SupplierReturnReason = 'defect' | 'expiring' | 'wrong_delivery' | 'overstock';
export type SupplierReturnSettlement = 'offset_debt' | 'cash_refund' | 'pending_credit';

export interface SupplierReturn {
  id: string;
  returnNumber: string;
  supplierName: string;
  productId: string;
  productName: string;
  unit: ProductUnit;
  quantity: number;
  unitCost: number;
  totalRefund: number;
  reason: SupplierReturnReason;
  settlementType: SupplierReturnSettlement;
  invoiceNumber?: string;
  notes?: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export interface InventoryAuditItem {
  productId: string;
  name: string;
  unit: string;
  expectedStock: number;
  actualStock: number;
  diff: number;
  costValueDiff: number;
}

export interface InventoryAudit {
  id: string;
  category: string;
  items: InventoryAuditItem[];
  discrepancyCount: number;
  discrepancyValue: number;
  performedBy: string;
  performedByName: string;
  createdAt: string;
}

export type PurchaseRequestStatus = 'new' | 'reviewing' | 'approved' | 'rejected' | 'delivered';

export interface PurchaseRequestItem {
  productId?: string;
  name: string;
  category: string;
  unit: ProductUnit;
  quantity: number;
  estimatedCost: number;
  isNewProduct: boolean;
}

export interface PurchaseRequest {
  id: string;
  requestNumber: string;
  requesterId: string;
  requesterName: string;
  supplierName?: string;
  items: PurchaseRequestItem[];
  isAutoGenerated: boolean;
  status: PurchaseRequestStatus;
  comment?: string;
  adminNote?: string;
  unreadForRequester: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ExpenseCategory =
  | 'Закупка товара'
  | 'Аренда'
  | 'Зарплата'
  | 'Коммунальные'
  | 'Логистика'
  | 'Списания и брак'
  | 'Прочее';

export interface Expense {
  id: string;
  category: ExpenseCategory;
  amount: number;
  description: string;
  expenseDate: string;
  createdBy: string;
  createdAt: string;
}

export type SecurityLogAction =
  | 'remove_cart_item'
  | 'cancel_receipt'
  | 'return_sale'
  | 'stock_adjustment'
  | 'price_change'
  | 'cash_out'
  | 'supplier_return';

export interface SecurityLog {
  id: string;
  action: SecurityLogAction;
  actorId: string;
  actorName: string;
  actorRole: string;
  details: string;
  amountImpact: number;
  authorizedBy?: string;
  createdAt: string;
}

export interface OnlineOrderItem {
  productId: string;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface OnlineOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  deliveryAddress?: string;
  deliveryType: 'delivery' | 'pickup';
  items: OnlineOrderItem[];
  totalAmount: number;
  paymentMethod: 'card_online' | 'qr_online' | 'cash_on_delivery';
  paymentStatus: 'paid' | 'pending' | 'awaiting_verification' | 'rejected';
  paymentProofNote?: string;
  paymentProofImage?: string;
  paymentVerifiedBy?: string;
  paymentVerifiedAt?: string;
  orderStatus: 'new' | 'packing' | 'delivering' | 'completed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
}

export interface StoreSettings {
  id: string;
  storeName: string;
  qrMerchantId: string;
  updatedAt: string;
}

export interface PosSecuritySettings {
  id: string;
  adminPinHash: string;
  updatedAt: string;
}
