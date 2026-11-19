# Security Specification — FreshMart Pro Firestore Rules

## 1. Data Invariants
1. **Owner Financial Exclusivity**: `/sales` and `/security_logs` can ONLY be read (`get`, `list`) by the verified Store Owner (`isOwner()`). Cashiers, Admins, Requesters, and Customers are denied read access to sales totals, receipts history, and the hidden security audit log.
2. **Immutable Security Audit Trail**: `/security_logs` documents can be created by authenticated staff (`cashier`, `admin`, `owner`) during POS/inventory events, and can NEVER be updated or deleted by anyone (even Owner or Admin).
3. **Price Protection from Cashiers**: Cashiers can decrement `stock` during checkout (`affectedKeys().hasOnly(['stock', 'updatedAt'])`), but CANNOT modify `retailPrice`, `costPrice`, `name`, or delete products.
4. **Role Escalation Prevention**: Users creating their own `/users/{userId}` document can only set `role == 'customer'` unless their verified email is the bootstrapped Owner email (`diljamiksabrin1986r@gmail.com`) or matches an active `/staff_invites/{emailKey}` created by the Owner. Users can never update their own `role` or `active` fields.
5. **PII & Order Isolation**: `/online_orders` can only be read by the owning customer (`customerId == request.auth.uid`), an Admin, or the Owner. `/users/{userId}` can only be read by self, Admin, or Owner.
6. **Requester Isolation**: `/purchase_requests` can be listed/read by the creating requester (`requesterId == request.auth.uid`), Admins, or Owner.
7. **Supplier Accounting Isolation**: `/supplier_payments` and `/supplier_returns` can ONLY be read or created by Admins and the Store Owner (`isAdmin()`). Cashiers, Requesters, and Customers have zero read/write access. Updates to settlement status preserve immutable quantities, costs, and creator identity.
8. **Admin PIN Isolation**: `store_settings/public_store` contains ONLY public store metadata (`storeName`, `qrMerchantId`) and NEVER contains `adminPinHash`. The Admin PIN hash lives exclusively in `store_settings/pos_security`, readable ONLY by verified staff (`isStaff()`) and writable ONLY by the Owner (`isOwner()`).
9. **QR Online Order Payment Verification**: Customers creating an `/online_orders` document with `paymentMethod == 'qr_online'` MUST set `paymentStatus == 'awaiting_verification'` and CANNOT populate `paymentVerifiedBy` or `paymentVerifiedAt`. Only Admins or Owner can verify (`paid`) or reject (`rejected`) QR payments.

## 2. Dirty Dozen Adversarial Payloads (Must Return PERMISSION_DENIED)
1. **Role Self-Escalation**: Customer sends `POST /users/{uid}` with `{ role: 'owner' }` -> DENIED.
2. **Cashier Reads Sales Revenue**: Cashier calls `list` or `get` on `/sales` -> DENIED.
3. **Admin Reads Hidden Security Log**: Admin calls `list` or `get` on `/security_logs` -> DENIED.
4. **Cashier Changes Product Price**: Cashier calls `update` on `/products/{id}` modifying `retailPrice` -> DENIED.
5. **Owner/Admin Deletes Security Log**: Owner or Admin calls `delete` on `/security_logs/{id}` -> DENIED.
6. **Shadow Field Injection on Product**: Admin sends `{ ...validProduct, isHacked: true }` -> DENIED via `keys().hasOnly(...)`.
7. **Unverified Email Spoofing**: Request with `email == 'diljamiksabrin1986r@gmail.com'` and `email_verified == false` -> DENIED.
8. **Invalid Document ID Poisoning**: Request with 500-char doc ID or `/` characters -> DENIED via `isValidId()`.
9. **Requester Approves Own Request**: Requester calls `update` on `/purchase_requests/{id}` changing `status: 'approved'` -> DENIED.
10. **Customer Reads Another Customer's Order**: Customer A calls `get` on `/online_orders/{orderOfB}` -> DENIED.
11. **Cashier Modifies Another Cashier's Shift**: Cashier A updates `/shifts/{shiftOfB}` -> DENIED.
12. **Customer Logs Fake Security Event**: Customer calls `create` on `/security_logs/{id}` -> DENIED.
13. **Cashier Creates or Reads Supplier Payments/Returns**: Cashier calls `create` or `list` on `/supplier_payments` or `/supplier_returns` -> DENIED.
14. **Admin Mutates Immutable Supplier Return Amount**: Admin calls `update` on `/supplier_returns/{id}` altering `totalRefund` or `quantity` -> DENIED via `affectedKeys().hasOnly(['settlementType', 'notes'])`.
15. **Customer/Public Reads Admin PIN Hash**: Unauthenticated user or Customer calls `get` on `/store_settings/pos_security` -> DENIED.
16. **Customer Spoofs Verified QR Payment**: Customer creates `/online_orders/{id}` with `paymentMethod: 'qr_online', paymentStatus: 'paid'` -> DENIED.

