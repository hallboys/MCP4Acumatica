// Copyright 2026 Hall Boys, Inc.
// SPDX-License-Identifier: Apache-2.0

/** Acumatica wraps every field value in an object */
export interface StringValue {
  value: string | null;
}

export interface BooleanValue {
  value: boolean | null;
}

export interface DecimalValue {
  value: number | null;
}

export interface IntValue {
  value: number | null;
}

export interface ShortValue {
  value: number | null;
}

export interface DateTimeValue {
  value: string | null;
}

export interface CustomField {
  type: string;
  value: unknown;
}

/** Base entity returned by all Acumatica endpoints */
export interface Entity {
  id?: string;
  rowNumber?: number;
  note?: StringValue;
  custom?: Record<string, Record<string, CustomField>>;
  _links?: Record<string, string>;
}

/** Contact sub-entity */
export interface Contact {
  Attention?: StringValue;
  CompanyName?: StringValue;
  Email?: StringValue;
  Fax?: StringValue;
  FaxType?: StringValue;
  FirstName?: StringValue;
  LastName?: StringValue;
  MiddleName?: StringValue;
  Phone1?: StringValue;
  Phone1Type?: StringValue;
  Phone2?: StringValue;
  Phone2Type?: StringValue;
  Phone3?: StringValue;
  Phone3Type?: StringValue;
  Title?: StringValue;
  WebSite?: StringValue;
}

/** Address sub-entity */
export interface Address {
  AddressLine1?: StringValue;
  AddressLine2?: StringValue;
  City?: StringValue;
  Country?: StringValue;
  PostalCode?: StringValue;
  State?: StringValue;
}

/** Customer entity */
export interface Customer extends Entity {
  CustomerID?: StringValue;
  CustomerName?: StringValue;
  CustomerClass?: StringValue;
  Status?: StringValue;
  MainContact?: Contact;
  PrimaryContact?: Contact;
  BillingContact?: Contact;
  CurrencyID?: StringValue;
  Terms?: StringValue;
  CreditVerificationRules?: CreditVerificationRules;
  Email?: StringValue;
  LocationName?: StringValue;
  ParentRecord?: StringValue;
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

export interface CreditVerificationRules extends Entity {
  CreditDaysPastDue?: IntValue;
  CreditLimit?: DecimalValue;
  CreditVerification?: StringValue;
  OpenOrdersBalance?: DecimalValue;
  RemainingCreditLimit?: DecimalValue;
  UnreleasedBalance?: DecimalValue;
}

/** Vendor entity */
export interface Vendor extends Entity {
  VendorID?: StringValue;
  VendorName?: StringValue;
  VendorClass?: StringValue;
  Status?: StringValue;
  MainContact?: Contact;
  PrimaryContact?: Contact;
  CurrencyID?: StringValue;
  Terms?: StringValue;
  TaxZone?: StringValue;
  TaxRegistrationID?: StringValue;
  PaymentMethod?: StringValue;
  CashAccount?: StringValue;
  APAccount?: StringValue;
  APSubaccount?: StringValue;
  LegalName?: StringValue;
  F1099Vendor?: BooleanValue;
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Sales order detail line */
export interface SalesOrderDetail extends Entity {
  BranchID?: StringValue;
  InventoryID?: StringValue;
  LineDescription?: StringValue;
  LineNbr?: IntValue;
  LineType?: StringValue;
  OrderQty?: DecimalValue;
  OpenQty?: DecimalValue;
  UnitPrice?: DecimalValue;
  DiscountAmount?: DecimalValue;
  ExtendedPrice?: DecimalValue;
  Amount?: DecimalValue;
  UOM?: StringValue;
  WarehouseID?: StringValue;
}

/** Sales order entity */
export interface SalesOrder extends Entity {
  OrderType?: StringValue;
  OrderNbr?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Date?: DateTimeValue;
  RequestedOn?: DateTimeValue;
  CustomerID?: StringValue;
  CustomerOrder?: StringValue;
  Description?: StringValue;
  CurrencyID?: StringValue;
  ControlTotal?: DecimalValue;
  OrderTotal?: DecimalValue;
  TaxTotal?: DecimalValue;
  OrderedQty?: DecimalValue;
  ShipVia?: StringValue;
  LocationID?: StringValue;
  BillToAddress?: Address;
  BillToContact?: Contact & Entity;
  ShipToAddress?: Address;
  ShipToContact?: Contact & Entity;
  Details?: SalesOrderDetail[];
  LastModified?: DateTimeValue;
}

/** GL Account entity */
export interface Account extends Entity {
  AccountCD?: StringValue;
  AccountClass?: StringValue;
  AccountGroup?: StringValue;
  AccountID?: IntValue;
  Active?: BooleanValue;
  CashAccount?: BooleanValue;
  Description?: StringValue;
  Type?: StringValue;
  CurrencyID?: StringValue;
  PostOption?: StringValue;
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** AR Invoice detail line */
export interface InvoiceDetail extends Entity {
  Account?: StringValue;
  Amount?: DecimalValue;
  Branch?: StringValue;
  ExtendedPrice?: DecimalValue;
  InventoryID?: StringValue;
  LineNbr?: IntValue;
  Qty?: DecimalValue;
  Subaccount?: StringValue;
  TransactionDescription?: StringValue;
  UnitPrice?: DecimalValue;
  UOM?: StringValue;
}

/** AR Invoice entity */
export interface Invoice extends Entity {
  Amount?: DecimalValue;
  Balance?: DecimalValue;
  Customer?: StringValue;
  CustomerOrder?: StringValue;
  Date?: DateTimeValue;
  Description?: StringValue;
  Details?: InvoiceDetail[];
  DueDate?: DateTimeValue;
  Hold?: BooleanValue;
  LinkARAccount?: StringValue;
  LinkBranch?: StringValue;
  LocationID?: StringValue;
  PostPeriod?: StringValue;
  Project?: StringValue;
  ReferenceNbr?: StringValue;
  Status?: StringValue;
  TaxTotal?: DecimalValue;
  Terms?: StringValue;
  Type?: StringValue;
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** AP Bill detail line */
export interface BillDetail extends Entity {
  Account?: StringValue;
  Amount?: DecimalValue;
  Branch?: StringValue;
  Description?: StringValue;
  ExtendedCost?: DecimalValue;
  InventoryID?: StringValue;
  POOrderNbr?: StringValue;
  POOrderType?: StringValue;
  Project?: StringValue;
  ProjectTask?: StringValue;
  Qty?: DecimalValue;
  Subaccount?: StringValue;
  TransactionDescription?: StringValue;
  UnitCost?: DecimalValue;
  UOM?: StringValue;
}

/** AP Bill entity */
export interface Bill extends Entity {
  Amount?: DecimalValue;
  Balance?: DecimalValue;
  BranchID?: StringValue;
  CashAccount?: StringValue;
  CurrencyID?: StringValue;
  Date?: DateTimeValue;
  Description?: StringValue;
  Details?: BillDetail[];
  DueDate?: DateTimeValue;
  Hold?: BooleanValue;
  LocationID?: StringValue;
  PostPeriod?: StringValue;
  Project?: StringValue;
  ReferenceNbr?: StringValue;
  Status?: StringValue;
  TaxTotal?: DecimalValue;
  Terms?: StringValue;
  Type?: StringValue;
  Vendor?: StringValue;
  VendorRef?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** GL Journal Transaction detail line */
export interface JournalTransactionDetail extends Entity {
  Account?: StringValue;
  BranchID?: StringValue;
  CreditAmount?: DecimalValue;
  DebitAmount?: DecimalValue;
  Description?: StringValue;
  LineNbr?: IntValue;
  Project?: StringValue;
  ProjectTask?: StringValue;
  ReferenceNbr?: StringValue;
  Subaccount?: StringValue;
  TransactionDescription?: StringValue;
  VendorOrCustomer?: StringValue;
}

/** GL Journal Transaction (batch) entity */
export interface JournalTransaction extends Entity {
  BatchNbr?: StringValue;
  BranchID?: StringValue;
  CurrencyID?: StringValue;
  Description?: StringValue;
  Details?: JournalTransactionDetail[];
  Hold?: BooleanValue;
  LedgerID?: StringValue;
  Module?: StringValue;
  PostPeriod?: StringValue;
  Status?: StringValue;
  TransactionDate?: DateTimeValue;
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** AR Payment entity */
export interface Payment extends Entity {
  ApplicationDate?: DateTimeValue;
  AppliedToDocuments?: DecimalValue;
  AppliedToOrders?: DecimalValue;
  AvailableBalance?: DecimalValue;
  Branch?: StringValue;
  BranchID?: StringValue;
  CashAccount?: StringValue;
  CurrencyID?: StringValue;
  CustomerID?: StringValue;
  Description?: StringValue;
  ExternalRef?: StringValue;
  Hold?: BooleanValue;
  PaymentAmount?: DecimalValue;
  PaymentMethod?: StringValue;
  PaymentRef?: StringValue;
  ReferenceNbr?: StringValue;
  Status?: StringValue;
  Type?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** AP Check entity */
export interface Check extends Entity {
  ApplicationDate?: DateTimeValue;
  CashAccount?: StringValue;
  CurrencyID?: StringValue;
  Description?: StringValue;
  Hold?: BooleanValue;
  PaymentAmount?: DecimalValue;
  PaymentMethod?: StringValue;
  PaymentRef?: StringValue;
  ReferenceNbr?: StringValue;
  Status?: StringValue;
  Type?: StringValue;
  UnappliedBalance?: DecimalValue;
  Vendor?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Env bindings for the Cloudflare Worker */
export interface Env {
  // Acumatica
  ACUMATICA_URL: string;
  ACUMATICA_COMPANY: string;
  ACUMATICA_ENDPOINT_VERSION: string;
  ACUMATICA_CLIENT_ID: string;
  ACUMATICA_CLIENT_SECRET: string;
  TOKEN_STORE: KVNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  // OAuth provider
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthProviderHelpers;
  // Durable Object
  MCP_OBJECT: DurableObjectNamespace;
}

/** Helpers injected by @cloudflare/workers-oauth-provider */
export interface OAuthProviderHelpers {
  parseAuthRequest(request: Request): Promise<unknown>;
  completeAuthorization(opts: {
    request: unknown;
    userId: string;
    metadata: { label: string };
    scope: string[];
    props: Record<string, unknown>;
  }): Promise<{ redirectTo: string }>;
}

/** Props attached to authenticated MCP sessions */
export type AuthProps = {
  acumaticaUsername: string;
  acumaticaDisplayName: string;
  [key: string]: unknown;
};

/** Stored token shape in KV */
export interface StoredToken {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
