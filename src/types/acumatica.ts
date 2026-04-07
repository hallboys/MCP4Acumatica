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

/** Stock Item entity */
export interface StockItem extends Entity {
  InventoryID?: StringValue;
  Description?: StringValue;
  ItemClass?: StringValue;
  ItemStatus?: StringValue;
  ItemType?: StringValue;
  BaseUOM?: StringValue;
  SalesUOM?: StringValue;
  PurchaseUOM?: StringValue;
  DefaultPrice?: DecimalValue;
  CurrentStdCost?: DecimalValue;
  LastCost?: DecimalValue;
  AverageCost?: DecimalValue;
  MSRP?: DecimalValue;
  DefaultWarehouseID?: StringValue;
  LotSerialClass?: StringValue;
  ValuationMethod?: StringValue;
  PostingClass?: StringValue;
  PriceClass?: StringValue;
  TaxCategory?: StringValue;
  DimensionWeight?: DecimalValue;
  DimensionVolume?: DecimalValue;
  ABCCode?: StringValue;
  SubjectToCommission?: BooleanValue;
  IsAKit?: BooleanValue;
  WarehouseDetails?: StockItemWarehouseDetail[];
  VendorDetails?: StockItemVendorDetail[];
  LastModifiedDateTime?: DateTimeValue;
}

export interface StockItemWarehouseDetail extends Entity {
  WarehouseID?: StringValue;
  QtyOnHand?: DecimalValue;
  Status?: StringValue;
  IsDefault?: BooleanValue;
  DefaultIssueLocationID?: StringValue;
  DefaultReceiptLocationID?: StringValue;
  PreferredVendor?: StringValue;
}

export interface StockItemVendorDetail extends Entity {
  VendorID?: StringValue;
  VendorName?: StringValue;
  Default?: BooleanValue;
  LeadTimeDays?: IntValue;
  LastVendorPrice?: DecimalValue;
}

/** Non-Stock Item entity */
export interface NonStockItem extends Entity {
  InventoryID?: StringValue;
  Description?: StringValue;
  ItemClass?: StringValue;
  ItemStatus?: StringValue;
  ItemType?: StringValue;
  BaseUnit?: StringValue;
  SalesUnit?: StringValue;
  PurchaseUnit?: StringValue;
  DefaultPrice?: DecimalValue;
  CurrentStdCost?: DecimalValue;
  LastCost?: DecimalValue;
  PendingCost?: DecimalValue;
  PostingClass?: StringValue;
  PriceClass?: StringValue;
  TaxCategory?: StringValue;
  RequireReceipt?: BooleanValue;
  RequireShipment?: BooleanValue;
  IsAKit?: BooleanValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Warehouse entity */
export interface Warehouse extends Entity {
  WarehouseID?: StringValue;
  Description?: StringValue;
  Active?: BooleanValue;
  ReceivingLocationID?: StringValue;
  ShippingLocationID?: StringValue;
  DropShipLocationID?: StringValue;
  Locations?: WarehouseLocation[];
  LastModifiedDateTime?: DateTimeValue;
}

export interface WarehouseLocation extends Entity {
  LocationID?: StringValue;
  Description?: StringValue;
  Active?: BooleanValue;
}

/** Item Class entity */
export interface ItemClassEntity extends Entity {
  ClassID?: StringValue;
  Description?: StringValue;
  ItemType?: StringValue;
  StockItem?: BooleanValue;
  BaseUOM?: StringValue;
  SalesUOM?: StringValue;
  PurchaseUOM?: StringValue;
  DefaultWarehouseID?: StringValue;
  ValuationMethod?: StringValue;
  PostingClass?: StringValue;
  PriceClass?: StringValue;
  LotSerialClass?: StringValue;
  TaxCategoryID?: StringValue;
  AvailabilityCalculationRule?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Purchase Order detail line */
export interface PurchaseOrderDetail extends Entity {
  Account?: StringValue;
  BranchID?: StringValue;
  Completed?: BooleanValue;
  Description?: StringValue;
  ExtendedCost?: DecimalValue;
  InventoryID?: StringValue;
  LineNbr?: IntValue;
  LineType?: StringValue;
  OrderQty?: DecimalValue;
  OrderedQty?: DecimalValue;
  Project?: StringValue;
  ProjectTask?: StringValue;
  QtyOnReceipts?: DecimalValue;
  Subaccount?: StringValue;
  UOM?: StringValue;
  UnitCost?: DecimalValue;
  WarehouseID?: StringValue;
}

/** Purchase Order entity */
export interface PurchaseOrder extends Entity {
  Type?: StringValue;
  OrderNbr?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Date?: DateTimeValue;
  PromisedOn?: DateTimeValue;
  VendorID?: StringValue;
  VendorRef?: StringValue;
  Description?: StringValue;
  CurrencyID?: StringValue;
  ControlTotal?: DecimalValue;
  LineTotal?: DecimalValue;
  OrderTotal?: DecimalValue;
  TaxTotal?: DecimalValue;
  Terms?: StringValue;
  Branch?: StringValue;
  Location?: StringValue;
  Owner?: StringValue;
  Project?: StringValue;
  Details?: PurchaseOrderDetail[];
  LastModifiedDateTime?: DateTimeValue;
}

/** Purchase Receipt detail line */
export interface PurchaseReceiptDetail extends Entity {
  Account?: StringValue;
  Branch?: StringValue;
  Description?: StringValue;
  ExtendedCost?: DecimalValue;
  InventoryID?: StringValue;
  LineNbr?: IntValue;
  LineType?: StringValue;
  POOrderNbr?: StringValue;
  POOrderType?: StringValue;
  ReceiptQty?: DecimalValue;
  Subaccount?: StringValue;
  TransactionDescription?: StringValue;
  UOM?: StringValue;
  UnitCost?: DecimalValue;
  Warehouse?: StringValue;
}

/** Purchase Receipt entity */
export interface PurchaseReceipt extends Entity {
  Type?: StringValue;
  ReceiptNbr?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Date?: DateTimeValue;
  VendorID?: StringValue;
  VendorRef?: StringValue;
  CurrencyID?: StringValue;
  TotalCost?: DecimalValue;
  TotalQty?: DecimalValue;
  Branch?: StringValue;
  Location?: StringValue;
  PostPeriod?: StringValue;
  Warehouse?: StringValue;
  Details?: PurchaseReceiptDetail[];
  LastModifiedDateTime?: DateTimeValue;
}

/** Project entity */
export interface Project extends Entity {
  ProjectID?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Customer?: StringValue;
  ProjectTemplateID?: StringValue;
  ExternalRefNbr?: StringValue;
  Assets?: DecimalValue;
  Liabilities?: DecimalValue;
  Income?: DecimalValue;
  Expenses?: DecimalValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Project Task entity */
export interface ProjectTask extends Entity {
  ProjectID?: StringValue;
  ProjectTaskID?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  Default?: BooleanValue;
  ExternalRefNbr?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Project Budget entity */
export interface ProjectBudget extends Entity {
  ProjectID?: StringValue;
  ProjectTaskID?: StringValue;
  AccountGroup?: StringValue;
  Type?: StringValue;
  Description?: StringValue;
  InventoryID?: StringValue;
  CostCode?: StringValue;
  UOM?: StringValue;
  OriginalBudgetedAmount?: DecimalValue;
  OriginalBudgetedQty?: DecimalValue;
  RevisedBudgetedAmount?: DecimalValue;
  RevisedBudgetedQty?: DecimalValue;
  ActualAmount?: DecimalValue;
  ActualQty?: DecimalValue;
  CommittedOpenAmount?: DecimalValue;
  CommittedOpenQty?: DecimalValue;
  PercentageOfCompletion?: DecimalValue;
  UnitRate?: DecimalValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Project Transaction detail line */
export interface ProjectTransactionDetail extends Entity {
  Account?: StringValue;
  AccountGroup?: StringValue;
  Amount?: DecimalValue;
  BillableQty?: DecimalValue;
  Branch?: StringValue;
  CostCode?: StringValue;
  Description?: StringValue;
  Employee?: StringValue;
  InventoryID?: StringValue;
  LineNbr?: IntValue;
  ProjectID?: StringValue;
  ProjectTaskID?: StringValue;
  Qty?: DecimalValue;
  Subaccount?: StringValue;
  UOM?: StringValue;
  UnitRate?: DecimalValue;
}

/** Project Transaction entity */
export interface ProjectTransaction extends Entity {
  Module?: StringValue;
  ReferenceNbr?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  OriginalDocType?: StringValue;
  OriginalDocNbr?: StringValue;
  TotalAmount?: DecimalValue;
  TotalQty?: DecimalValue;
  TotalBillableQty?: DecimalValue;
  Details?: ProjectTransactionDetail[];
  CreatedDateTime?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Support Case entity */
export interface Case extends Entity {
  CaseID?: StringValue;
  Subject?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  Reason?: StringValue;
  Priority?: StringValue;
  Severity?: StringValue;
  ClassID?: StringValue;
  BusinessAccount?: StringValue;
  BusinessAccountName?: StringValue;
  ContactDisplayName?: StringValue;
  ContactID?: IntValue;
  Owner?: StringValue;
  OwnerEmployeeName?: StringValue;
  Workgroup?: StringValue;
  Contract?: StringValue;
  Location?: StringValue;
  DateReported?: DateTimeValue;
  ClosingDate?: DateTimeValue;
  SLA?: DateTimeValue;
  InitialResponse?: StringValue;
  ResolutionTime?: StringValue;
  TimeSpent?: StringValue;
  Billable?: BooleanValue;
  BillableTime?: StringValue;
  LastActivityDate?: DateTimeValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Service Order entity */
export interface ServiceOrder extends Entity {
  ServiceOrderType?: StringValue;
  ServiceOrderNbr?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Priority?: StringValue;
  Severity?: StringValue;
  Problem?: StringValue;
  Customer?: StringValue;
  Location?: StringValue;
  CustomerOrder?: StringValue;
  Date?: DateTimeValue;
  SLA?: DateTimeValue;
  Project?: StringValue;
  DefaultProjectTask?: StringValue;
  BranchLocation?: StringValue;
  Supervisor?: StringValue;
  Currency?: StringValue;
  BillableTotal?: DecimalValue;
  ServiceOrderTotal?: DecimalValue;
  TaxTotal?: DecimalValue;
  ExternalReference?: StringValue;
  WorkflowStage?: StringValue;
  EstimatedDuration?: StringValue;
  AppointmentDuration?: StringValue;
  LastModifiedDateTime?: DateTimeValue;
}

/** Appointment entity */
export interface Appointment extends Entity {
  AppointmentNbr?: StringValue;
  ServiceOrderType?: StringValue;
  ServiceOrderNbr?: StringValue;
  Description?: StringValue;
  Status?: StringValue;
  Hold?: BooleanValue;
  Customer?: StringValue;
  Location?: StringValue;
  Project?: StringValue;
  DefaultProjectTask?: StringValue;
  BranchLocation?: StringValue;
  ScheduledStartDate?: DateTimeValue;
  ScheduledEndDate?: DateTimeValue;
  ActualStartDate?: DateTimeValue;
  ActualEndDate?: DateTimeValue;
  ScheduledDuration?: StringValue;
  ActualDuration?: StringValue;
  ActualServiceDuration?: StringValue;
  AppointmentTotal?: DecimalValue;
  CostTotal?: DecimalValue;
  Profit?: DecimalValue;
  TaxTotal?: DecimalValue;
  Confirmed?: BooleanValue;
  Finished?: BooleanValue;
  WorkflowStage?: StringValue;
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
