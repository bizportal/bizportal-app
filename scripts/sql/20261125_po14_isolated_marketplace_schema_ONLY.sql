-- ISOLATED TEST PG ONLY (localhost port 55497). NEVER apply to CST-DEV or PROD.
-- Snapshot of offline-generated Marketplace table DDL, omitting foreign keys to unrelated ERP tables.
CREATE TYPE mkt_ap_preparation_status AS ENUM ('ap_preparation','finance_review','waiting_payment');
CREATE TYPE mkt_po_status AS ENUM ('pending','confirmed','in_progress','delivered','completed','cancelled','issued','vendor_accepted','revision_requested','vendor_rejected','production','ready_to_ship','in_transit','partially_delivered','closed','rejected_goods');
CREATE TYPE pay_req_status AS ENUM ('draft','submitted','approved','rejected','paid','cancelled');
CREATE TYPE vi_status AS ENUM ('draft','submitted','posted','matched','ready_for_ap','paid','cancelled');
CREATE TABLE "mkt_accounting_handoffs" (
	"id" serial PRIMARY KEY NOT NULL,
	"handoff_key" text NOT NULL,
	"correlation_reference" text NOT NULL,
	"payload_fingerprint" text NOT NULL,
	"ap_preparation_id" integer NOT NULL,
	"vendor_invoice_id" integer NOT NULL,
	"mkt_purchase_order_id" integer NOT NULL,
	"mkt_goods_receipt_id" integer NOT NULL,
	"payment_request_id" integer NOT NULL,
	"company_id" integer,
	"supplier_id" integer NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"approval_state" text NOT NULL,
	"payment_lifecycle_state" text NOT NULL,
	"status" text DEFAULT 'accepted' NOT NULL,
	"accounting_reference" text,
	"accounting_status" text,
	"failure_code" text,
	"failure_reason" text,
	"payload" jsonb NOT NULL,
	"requested_by" text,
	"accepted_at" timestamp,
	"last_response_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "mkt_ap_preparations" (
	"id" serial PRIMARY KEY NOT NULL,
	"preparation_number" text NOT NULL,
	"vendor_invoice_id" integer NOT NULL,
	"mkt_purchase_order_id" integer NOT NULL,
	"mkt_goods_receipt_id" integer NOT NULL,
	"company_id" integer,
	"supplier_id" integer NOT NULL,
	"supplier_name" text NOT NULL,
	"invoice_number_snapshot" text NOT NULL,
	"vendor_invoice_ref_snapshot" text,
	"currency_snapshot" text NOT NULL,
	"total_amount_snapshot" numeric(14, 2) NOT NULL,
	"tax_amount_snapshot" numeric(14, 2) NOT NULL,
	"grand_total_snapshot" numeric(14, 2) NOT NULL,
	"status" "mkt_ap_preparation_status" DEFAULT 'ap_preparation' NOT NULL,
	"notes" text,
	"finance_reviewed_by" text,
	"finance_reviewed_at" timestamp,
	"waiting_payment_at" timestamp,
	"payment_request_id" integer,
	"payment_handoff_at" timestamp,
	"payment_handoff_by" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mkt_ap_preparations_preparation_number_unique" UNIQUE("preparation_number")
);
CREATE TABLE "mkt_po_goods_receipt_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"goods_receipt_id" integer NOT NULL,
	"shipment_item_id" integer NOT NULL,
	"received_qty" numeric(14, 2) NOT NULL,
	"accepted_qty" numeric(14, 2) DEFAULT '0' NOT NULL,
	"rejected_qty" numeric(14, 2) DEFAULT '0' NOT NULL,
	"condition" text DEFAULT 'GOOD' NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "mkt_po_goods_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"receipt_number" text NOT NULL,
	"receipt_type" text NOT NULL,
	"inspection_status" text DEFAULT 'pending' NOT NULL,
	"received_by" text,
	"received_at" timestamp,
	"notes" text,
	"idempotency_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mkt_po_goods_receipts_receipt_number_unique" UNIQUE("receipt_number")
);
CREATE TABLE "mkt_po_shipment_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"event_sequence" integer NOT NULL,
	"event_type" text NOT NULL,
	"note" text,
	"location" text,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7),
	"attachment_object_path" text,
	"idempotency_key" text,
	"actor_type" text DEFAULT 'vendor' NOT NULL,
	"actor_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "mkt_po_shipment_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"shipment_id" integer NOT NULL,
	"po_line_id" integer NOT NULL,
	"line_number" integer NOT NULL,
	"qty" numeric(14, 2) NOT NULL,
	"uom" text,
	"weight" numeric(12, 3),
	"volume" numeric(12, 3),
	"package_count" integer,
	"remarks" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "mkt_po_shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"shipment_number" text NOT NULL,
	"shipment_status" text DEFAULT 'planned' NOT NULL,
	"shipment_type" text,
	"carrier_name" text,
	"tracking_number" text,
	"vehicle_type" text,
	"vehicle_number" text,
	"driver_name" text,
	"driver_phone" text,
	"container_number" text,
	"seal_number" text,
	"origin" text,
	"destination" text,
	"incoterm_snapshot" text,
	"planned_departure" timestamp,
	"actual_departure" timestamp,
	"estimated_arrival" timestamp,
	"actual_arrival" timestamp,
	"notes" text,
	"idempotency_key" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mkt_po_shipments_shipment_number_unique" UNIQUE("shipment_number")
);
CREATE TABLE "mkt_purchase_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_id" integer NOT NULL,
	"item_name" text NOT NULL,
	"qty" numeric(14, 2) NOT NULL,
	"unit" text,
	"unit_price" numeric(14, 2) NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
CREATE TABLE "mkt_purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"po_number" text NOT NULL,
	"rfq_id" integer NOT NULL,
	"quote_id" integer NOT NULL,
	"company_id" integer,
	"vendor_id" integer NOT NULL,
	"status" "mkt_po_status" DEFAULT 'pending' NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"grand_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"sales_document_id" integer,
	"vendor_name_snapshot" text,
	"vendor_address_snapshot" text,
	"payment_terms_snapshot" text,
	"incoterm_snapshot" text,
	"quotation_number_snapshot" text,
	"quotation_date_snapshot" date,
	"currency_snapshot" text,
	"lead_time_days_snapshot" integer,
	"confirmed_at" timestamp,
	"cancelled_at" timestamp,
	"cancel_reason" text,
	"journal_posted_at" timestamp,
	"vendor_token" text,
	"vendor_token_version" integer DEFAULT 1 NOT NULL,
	"vendor_token_expires_at" timestamp,
	"vendor_token_used_at" timestamp,
	"last_token_generated_at" timestamp,
	"revision_notes" text,
	"closed_at" timestamp,
	"expected_completion_date" date,
	"actual_completion_date" date,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mkt_purchase_orders_po_number_unique" UNIQUE("po_number"),
	CONSTRAINT "mkt_purchase_orders_vendor_token_unique" UNIQUE("vendor_token")
);
CREATE TABLE "payment_request_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"payment_request_id" integer NOT NULL,
	"vendor_invoice_id" integer,
	"description" text NOT NULL,
	"amount" numeric(14, 2) DEFAULT '0' NOT NULL
);
CREATE TABLE "payment_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"pay_req_number" text NOT NULL,
	"company_id" integer,
	"supplier_id" integer,
	"supplier_name" text NOT NULL,
	"status" "pay_req_status" DEFAULT 'draft' NOT NULL,
	"requested_by" text,
	"approved_by" text,
	"approved_at" timestamp,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"paid_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"payment_method" text,
	"bank_account" text,
	"payment_date" timestamp,
	"journal_entry_id" integer,
	"notes" text,
	"source_type" text,
	"source_id" integer,
	"mkt_ap_preparation_id" integer,
	"idempotency_key" text,
	"payload_fingerprint" text,
	"mkt_lifecycle_status" text,
	"mkt_finance_reviewed_by" text,
	"mkt_finance_reviewed_at" timestamp,
	"mkt_approved_by" text,
	"mkt_approved_at" timestamp,
	"mkt_treasury_ready_by" text,
	"mkt_treasury_ready_at" timestamp,
	"mkt_execution_started_at" timestamp,
	"mkt_completed_at" timestamp,
	"mkt_failure_code" text,
	"mkt_failure_reason" text,
	"mkt_failure_at" timestamp,
	"mkt_failed_by" text,
	"mkt_cancellation_idempotency_key" text,
	"mkt_cancelled_by" text,
	"mkt_cancellation_reason" text,
	"cancelled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_requests_pay_req_number_unique" UNIQUE("pay_req_number"),
	CONSTRAINT "pay_req_idempotency_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "pay_req_mkt_ap_unique" UNIQUE("mkt_ap_preparation_id")
);
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_id" integer,
	"name" text NOT NULL,
	"country" text,
	"contact_email" text,
	"contact_person" text,
	"phone" text,
	"address" text,
	"tax_id" text,
	"npwp" text,
	"nib" text,
	"default_purchase_tax_id" integer,
	"service_type" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"logo" text DEFAULT '📦' NOT NULL,
	"eta" text,
	"fee" numeric(12, 2) DEFAULT '0',
	"markup" numeric(5, 2) DEFAULT '0',
	"note" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"year_vehicle" integer,
	"supported_modes" text[],
	"eta_days_min" integer,
	"eta_days_max" integer,
	"has_internal_truck" boolean DEFAULT false NOT NULL,
	"internal_truck_price" numeric(14, 2),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"vendor_code" text,
	"is_verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"verified_by" text,
	"status_reason" text,
	"status_changed_at" timestamp,
	"status_changed_by" text,
	"logo_url" text,
	"cover_url" text,
	"description_public" text,
	"service_areas" jsonb,
	"is_premium" boolean DEFAULT false NOT NULL,
	"is_featured" boolean DEFAULT false NOT NULL,
	"marketplace_status" text DEFAULT 'draft' NOT NULL,
	"marketplace_published_at" timestamp,
	"marketplace_published_by" text,
	"public_slug" text,
	"is_internal_vendor" boolean DEFAULT false NOT NULL,
	"company_banner" text,
	"vision" text,
	"mission" text,
	"established_year" integer,
	"main_market" text,
	"factory_address" text,
	"office_address" text,
	"warehouse_address" text,
	"website" text,
	"social_media" jsonb,
	"latitude" numeric(10, 7),
	"longitude" numeric(10, 7)
);
CREATE TABLE "vendor_invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"mkt_purchase_order_line_id" integer,
	"product_id" integer,
	"name" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"unit_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"coa_hint" text,
	"coa_account_id" integer,
	"coa_resolution_status" text DEFAULT 'unresolved' NOT NULL,
	"coa_confirmed_by" text,
	"coa_confirmed_at" timestamp,
	"coa_mapping_key" text,
	"notes" text
);
CREATE TABLE "vendor_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"vendor_invoice_ref" text,
	"company_id" integer,
	"supplier_id" integer,
	"supplier_name" text NOT NULL,
	"po_id" integer,
	"gr_id" integer,
	"mkt_purchase_order_id" integer,
	"mkt_goods_receipt_id" integer,
	"status" "vi_status" DEFAULT 'draft' NOT NULL,
	"invoice_date" timestamp DEFAULT now() NOT NULL,
	"due_date" timestamp,
	"payment_term_days" integer DEFAULT 30,
	"currency" text DEFAULT 'IDR' NOT NULL,
	"total_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"withholding_tax_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_review_status" text DEFAULT 'not_required' NOT NULL,
	"tax_review_reason" text,
	"withholding_review_status" text DEFAULT 'not_required' NOT NULL,
	"withholding_review_completed_by" text,
	"withholding_review_completed_at" timestamp,
	"withholding_tax_type" text,
	"tax_object" text,
	"grand_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"three_way_match_status" text DEFAULT 'unmatched' NOT NULL,
	"match_notes" text,
	"journal_entry_id" integer,
	"notes" text,
	"invoice_breakdown" jsonb,
	"attachment_object_path" text,
	"attachment_file_name" text,
	"attachment_content_type" text,
	"attachment_size" integer,
	"category_key" text,
	"template_id" text,
	"template_version" text,
	"template_snapshot" jsonb,
	"cancelled_at" timestamp,
	"is_locked" boolean DEFAULT false NOT NULL,
	"sap_lock_snapshot" jsonb,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_invoices_invoice_number_unique" UNIQUE("invoice_number")
);
CREATE TABLE "vendor_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"vendor_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp
);
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_ap_preparation_id_mkt_ap_preparations_id_fk" FOREIGN KEY ("ap_preparation_id") REFERENCES "public"."mkt_ap_preparations"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_mkt_purchase_order_id_mkt_purchase_orders_id_fk" FOREIGN KEY ("mkt_purchase_order_id") REFERENCES "public"."mkt_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_mkt_goods_receipt_id_mkt_po_goods_receipts_id_fk" FOREIGN KEY ("mkt_goods_receipt_id") REFERENCES "public"."mkt_po_goods_receipts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_payment_request_id_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_accounting_handoffs" ADD CONSTRAINT "mkt_accounting_handoffs_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_ap_preparations" ADD CONSTRAINT "mkt_ap_preparations_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_ap_preparations" ADD CONSTRAINT "mkt_ap_preparations_mkt_purchase_order_id_mkt_purchase_orders_id_fk" FOREIGN KEY ("mkt_purchase_order_id") REFERENCES "public"."mkt_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_ap_preparations" ADD CONSTRAINT "mkt_ap_preparations_mkt_goods_receipt_id_mkt_po_goods_receipts_id_fk" FOREIGN KEY ("mkt_goods_receipt_id") REFERENCES "public"."mkt_po_goods_receipts"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_ap_preparations" ADD CONSTRAINT "mkt_ap_preparations_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_ap_preparations" ADD CONSTRAINT "mkt_ap_preparations_payment_request_id_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "mkt_po_goods_receipt_items" ADD CONSTRAINT "mkt_po_goods_receipt_items_goods_receipt_id_mkt_po_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."mkt_po_goods_receipts"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mkt_po_goods_receipt_items" ADD CONSTRAINT "mkt_po_goods_receipt_items_shipment_item_id_mkt_po_shipment_items_id_fk" FOREIGN KEY ("shipment_item_id") REFERENCES "public"."mkt_po_shipment_items"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_po_goods_receipts" ADD CONSTRAINT "mkt_po_goods_receipts_shipment_id_mkt_po_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."mkt_po_shipments"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_po_shipment_events" ADD CONSTRAINT "mkt_po_shipment_events_shipment_id_mkt_po_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."mkt_po_shipments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mkt_po_shipment_items" ADD CONSTRAINT "mkt_po_shipment_items_shipment_id_mkt_po_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."mkt_po_shipments"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "mkt_po_shipment_items" ADD CONSTRAINT "mkt_po_shipment_items_po_line_id_mkt_purchase_order_lines_id_fk" FOREIGN KEY ("po_line_id") REFERENCES "public"."mkt_purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_po_shipments" ADD CONSTRAINT "mkt_po_shipments_po_id_mkt_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."mkt_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_purchase_order_lines" ADD CONSTRAINT "mkt_purchase_order_lines_po_id_mkt_purchase_orders_id_fk" FOREIGN KEY ("po_id") REFERENCES "public"."mkt_purchase_orders"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "mkt_purchase_orders" ADD CONSTRAINT "mkt_purchase_orders_vendor_id_suppliers_id_fk" FOREIGN KEY ("vendor_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;
ALTER TABLE "payment_request_items" ADD CONSTRAINT "payment_request_items_payment_request_id_payment_requests_id_fk" FOREIGN KEY ("payment_request_id") REFERENCES "public"."payment_requests"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "payment_request_items" ADD CONSTRAINT "payment_request_items_vendor_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("vendor_invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "payment_requests" ADD CONSTRAINT "payment_requests_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_invoice_id_vendor_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."vendor_invoices"("id") ON DELETE cascade ON UPDATE no action;
ALTER TABLE "vendor_invoice_lines" ADD CONSTRAINT "vendor_invoice_lines_mkt_purchase_order_line_id_mkt_purchase_order_lines_id_fk" FOREIGN KEY ("mkt_purchase_order_line_id") REFERENCES "public"."mkt_purchase_order_lines"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_mkt_purchase_order_id_mkt_purchase_orders_id_fk" FOREIGN KEY ("mkt_purchase_order_id") REFERENCES "public"."mkt_purchase_orders"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "vendor_invoices" ADD CONSTRAINT "vendor_invoices_mkt_goods_receipt_id_mkt_po_goods_receipts_id_fk" FOREIGN KEY ("mkt_goods_receipt_id") REFERENCES "public"."mkt_po_goods_receipts"("id") ON DELETE set null ON UPDATE no action;
CREATE UNIQUE INDEX "mkt_accounting_handoffs_key_unique" ON "mkt_accounting_handoffs" USING btree ("handoff_key");
CREATE UNIQUE INDEX "mkt_accounting_handoffs_correlation_unique" ON "mkt_accounting_handoffs" USING btree ("correlation_reference");
CREATE UNIQUE INDEX "mkt_accounting_handoffs_ap_unique" ON "mkt_accounting_handoffs" USING btree ("ap_preparation_id");
CREATE INDEX "mkt_accounting_handoffs_company_idx" ON "mkt_accounting_handoffs" USING btree ("company_id");
CREATE INDEX "mkt_accounting_handoffs_status_idx" ON "mkt_accounting_handoffs" USING btree ("status");
CREATE INDEX "mkt_accounting_handoffs_payment_idx" ON "mkt_accounting_handoffs" USING btree ("payment_request_id");
CREATE UNIQUE INDEX "mkt_ap_preparations_invoice_unique" ON "mkt_ap_preparations" USING btree ("vendor_invoice_id");
CREATE INDEX "mkt_ap_preparations_status_idx" ON "mkt_ap_preparations" USING btree ("status");
CREATE INDEX "mkt_ap_preparations_company_idx" ON "mkt_ap_preparations" USING btree ("company_id");
CREATE INDEX "mkt_ap_preparations_vendor_idx" ON "mkt_ap_preparations" USING btree ("supplier_id");
CREATE UNIQUE INDEX "mkt_ap_preparations_payment_request_unique" ON "mkt_ap_preparations" USING btree ("payment_request_id");
CREATE INDEX "mkt_po_goods_receipt_items_receipt_idx" ON "mkt_po_goods_receipt_items" USING btree ("goods_receipt_id");
CREATE INDEX "mkt_po_goods_receipt_items_shipment_item_idx" ON "mkt_po_goods_receipt_items" USING btree ("shipment_item_id");
CREATE INDEX "mkt_po_goods_receipts_shipment_idx" ON "mkt_po_goods_receipts" USING btree ("shipment_id");
CREATE UNIQUE INDEX "mkt_po_goods_receipts_shipment_idempotency_unique" ON "mkt_po_goods_receipts" USING btree ("shipment_id","idempotency_key");
CREATE INDEX "mkt_po_shipment_events_shipment_idx" ON "mkt_po_shipment_events" USING btree ("shipment_id");
CREATE INDEX "mkt_po_shipment_events_shipment_created_idx" ON "mkt_po_shipment_events" USING btree ("shipment_id","created_at");
CREATE UNIQUE INDEX "mkt_po_shipment_events_shipment_seq_unique" ON "mkt_po_shipment_events" USING btree ("shipment_id","event_sequence");
CREATE UNIQUE INDEX "mkt_po_shipment_events_shipment_idempotency_unique" ON "mkt_po_shipment_events" USING btree ("shipment_id","idempotency_key");
CREATE INDEX "mkt_po_shipment_items_shipment_idx" ON "mkt_po_shipment_items" USING btree ("shipment_id");
CREATE INDEX "mkt_po_shipment_items_po_line_idx" ON "mkt_po_shipment_items" USING btree ("po_line_id");
CREATE INDEX "mkt_po_shipments_po_idx" ON "mkt_po_shipments" USING btree ("po_id");
CREATE INDEX "mkt_po_shipments_po_status_idx" ON "mkt_po_shipments" USING btree ("po_id","shipment_status");
CREATE UNIQUE INDEX "mkt_po_shipments_po_idempotency_unique" ON "mkt_po_shipments" USING btree ("po_id","idempotency_key");
CREATE INDEX "mkt_po_lines_po_idx" ON "mkt_purchase_order_lines" USING btree ("po_id");
CREATE UNIQUE INDEX "mkt_po_rfq_unique" ON "mkt_purchase_orders" USING btree ("rfq_id");
CREATE UNIQUE INDEX "mkt_po_quote_unique" ON "mkt_purchase_orders" USING btree ("quote_id");
CREATE INDEX "mkt_purchase_orders_company_idx" ON "mkt_purchase_orders" USING btree ("company_id");
CREATE INDEX "mkt_purchase_orders_vendor_idx" ON "mkt_purchase_orders" USING btree ("vendor_id");
CREATE INDEX "mkt_purchase_orders_status_idx" ON "mkt_purchase_orders" USING btree ("status");
CREATE INDEX "pay_req_items_pr_idx" ON "payment_request_items" USING btree ("payment_request_id");
CREATE INDEX "pay_req_supplier_idx" ON "payment_requests" USING btree ("supplier_id");
CREATE INDEX "pay_req_status_idx" ON "payment_requests" USING btree ("status");
CREATE INDEX "pay_req_source_idx" ON "payment_requests" USING btree ("source_type","source_id");
CREATE INDEX "pay_req_mkt_ap_idx" ON "payment_requests" USING btree ("mkt_ap_preparation_id");
CREATE INDEX "suppliers_company_idx" ON "suppliers" USING btree ("company_id");
CREATE INDEX "suppliers_status_idx" ON "suppliers" USING btree ("status");
CREATE INDEX "suppliers_is_verified_idx" ON "suppliers" USING btree ("is_verified");
CREATE INDEX "suppliers_marketplace_status_idx" ON "suppliers" USING btree ("marketplace_status");
CREATE UNIQUE INDEX "suppliers_public_slug_unique" ON "suppliers" USING btree ("public_slug");
CREATE UNIQUE INDEX "suppliers_vendor_code_unique" ON "suppliers" USING btree ("vendor_code");
CREATE INDEX "vi_lines_invoice_idx" ON "vendor_invoice_lines" USING btree ("invoice_id");
CREATE INDEX "vi_po_idx" ON "vendor_invoices" USING btree ("po_id");
CREATE INDEX "vi_supplier_idx" ON "vendor_invoices" USING btree ("supplier_id");
CREATE INDEX "vi_status_idx" ON "vendor_invoices" USING btree ("status");
CREATE INDEX "vn_vendor_idx" ON "vendor_notifications" USING btree ("vendor_id");
CREATE INDEX "vn_is_read_idx" ON "vendor_notifications" USING btree ("is_read");
CREATE INDEX "vn_created_idx" ON "vendor_notifications" USING btree ("created_at");
