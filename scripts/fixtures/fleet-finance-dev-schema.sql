-- Fleet Finance isolated PostgreSQL QA schema, captured from CST-DEV on 2026-11-17.
-- SCHEMA ONLY: no customer, driver, phone, payment, or ledger rows copied.
-- DO NOT run against a shared database. The harness creates a disposable database
-- named fleet_finance_qa in a Docker container with --network none and no ports.
-- Ten relevant tables, all their PK/unique/check/FK constraints and unique indexes,
-- and all sixteen installed triggers are reproduced below. Foreign-key targets
-- cost_centers/accounting_taxes are empty ID stubs, unused by Fleet cash payments.
-- Customer-AR actor registry is empty, so unrelated projections remain dormant.
\set ON_ERROR_STOP on
CREATE TABLE public.cost_centers (id integer PRIMARY KEY);
CREATE TABLE public.accounting_taxes (id integer PRIMARY KEY);
CREATE TABLE public.bizportal_customer_ar_source_actors_dev (role_name name, company_id integer, enabled boolean, source_not_before timestamptz);
CREATE TYPE public."journal_type" AS ENUM ('sales', 'purchase', 'bank', 'cash', 'general');
CREATE TYPE public."accounting_entry_status" AS ENUM ('draft', 'posted', 'pending_approval', 'approved', 'rejected', 'voided');
CREATE TYPE public."accounting_entry_source" AS ENUM ('manual', 'sales_invoice', 'purchase_bill', 'sales_payment', 'purchase_payment', 'pos_sale', 'ecommerce_order', 'stock_received', 'manual_payment', 'reversal', 'cogs_delivery', 'sport_center_refund', 'sport_center_membership', 'sport_center_booking_refund', 'sport_center_operational_expense', 'purchase_return', 'sales_return', 'opname_adjust', 'damage_adjust', 'grn_receipt', 'sport_center_booking', 'sport_center_booking_reversal', 'logistic_vendor_cost', 'bank_mutation_import', 'closing_entry', 'payroll', 'tenant_rent_payment', 'tenant_sc_payment', 'fleet_cash_payment', 'logistics_payment', 'trading_payment', 'travel_payment', 'hrd_salary_payment', 'tenant_rent_reversal', 'other_income', 'kasbon', 'sport_center_ppn_correction', 'sport_center_amount_correction', 'bank_reconciliation', 'bank_reconciliation_void', 'fund_transfer', 'sport_center_qris_mdr', 'sport_center_payment', 'historical_duplicate_reversal', 'operational_expense', 'sport_center_invoice');
CREATE TYPE public."account_type" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE SEQUENCE public."accounting_entries_id_seq";
CREATE SEQUENCE public."accounting_entry_lines_id_seq";
CREATE SEQUENCE public."accounting_journals_id_seq";
CREATE SEQUENCE public."accounting_settings_id_seq";
CREATE SEQUENCE public."chart_of_accounts_id_seq";
CREATE SEQUENCE public."companies_id_seq";
CREATE SEQUENCE public."financial_periods_id_seq";
CREATE SEQUENCE public."fleet_cash_payments_id_seq";
CREATE SEQUENCE public."fleet_ledger_entries_id_seq";
CREATE SEQUENCE public."fleet_outstanding_id_seq";

CREATE TABLE public."accounting_entries" (
  "id" integer DEFAULT nextval('accounting_entries_id_seq'::regclass) NOT NULL,
  "company_id" integer NOT NULL,
  "entry_number" text NOT NULL,
  "journal_id" integer NOT NULL,
  "date" date NOT NULL,
  "ref" text,
  "description" text,
  "status" accounting_entry_status DEFAULT 'posted'::accounting_entry_status NOT NULL,
  "source" accounting_entry_source DEFAULT 'manual'::accounting_entry_source NOT NULL,
  "source_id" integer,
  "total_debit" numeric(14,2) DEFAULT '0'::numeric NOT NULL,
  "total_credit" numeric(14,2) DEFAULT '0'::numeric NOT NULL,
  "created_by_id" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "cost_center_id" integer,
  "facility_id" integer,
  "expense_category" text,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "cancelled_by" text,
  "cancelled_at" timestamp with time zone,
  "cancel_reason" text,
  "voided_by" text,
  "voided_at" timestamp without time zone,
  "void_reason" text,
  "entry_status" text DEFAULT 'POSTED'::text NOT NULL,
  "is_locked" boolean DEFAULT false NOT NULL,
  "locked_at" timestamp with time zone,
  "locked_by" text,
  "system_override" boolean DEFAULT false NOT NULL,
  "override_reason" text,
  "override_by" text,
  "override_at" timestamp with time zone,
  "governance_flags" jsonb DEFAULT '{}'::jsonb,
  "correlation_id" text,
  "branch_id" integer,
  "division_id" integer,
  "source_schema" text,
  "source_module" text,
  "source_table" text,
  "posted_at" timestamp without time zone,
  "void_entry_id" integer,
  "ledger_source_type" text,
  "ledger_source_id" text,
  "checksum_hash" text,
  "previous_entry_id" integer,
  "is_voided" boolean DEFAULT false NOT NULL,
  "is_reversed" boolean DEFAULT false NOT NULL,
  "payment_method" text,
  "payment_provider" text,
  "payment_type" text,
  "source_payment_id" bigint,
  "bank_account_id" text,
  "provider_reference" text,
  "provider_order_id" text,
  "merchant_trade_no" text,
  "provider_trade_no" text,
  "source_event_id" text
);

CREATE TABLE public."accounting_entry_lines" (
  "id" integer DEFAULT nextval('accounting_entry_lines_id_seq'::regclass) NOT NULL,
  "entry_id" integer NOT NULL,
  "account_id" integer NOT NULL,
  "description" text,
  "debit" numeric(14,2) DEFAULT '0'::numeric NOT NULL,
  "credit" numeric(14,2) DEFAULT '0'::numeric NOT NULL,
  "company_id" integer,
  "branch_id" integer,
  "division_id" integer,
  "source_module" text,
  "source_table" text,
  "source_id" integer
);

CREATE TABLE public."accounting_journals" (
  "id" integer DEFAULT nextval('accounting_journals_id_seq'::regclass) NOT NULL,
  "company_id" integer,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" journal_type NOT NULL,
  "default_debit_account_id" integer,
  "default_credit_account_id" integer,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."accounting_settings" (
  "id" integer DEFAULT nextval('accounting_settings_id_seq'::regclass) NOT NULL,
  "company_id" integer,
  "ar_account_id" integer,
  "ap_account_id" integer,
  "sales_income_account_id" integer,
  "purchase_expense_account_id" integer,
  "default_bank_account_id" integer,
  "ppn_output_account_id" integer,
  "ppn_input_account_id" integer,
  "sales_journal_id" integer,
  "purchase_journal_id" integer,
  "bank_journal_id" integer,
  "cash_journal_id" integer,
  "default_sales_tax_id" integer,
  "default_purchase_tax_id" integer,
  "default_cash_account_id" integer,
  "inventory_account_id" integer,
  "cogs_account_id" integer,
  "company_name" text,
  "company_address" text,
  "company_npwp" text,
  "company_logo_url" text,
  "meta" jsonb,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "grir_account_id" integer,
  "gsheet_spreadsheet_id" text,
  "fleet_cash_account_id" integer,
  "fleet_driver_receivable_account_id" integer,
  "fleet_auto_blast_enabled" boolean DEFAULT false NOT NULL,
  "fleet_auto_blast_hour" integer DEFAULT 8 NOT NULL,
  "fleet_auto_blast_last_run" date,
  "tenant_rent_income_account_id" integer,
  "salary_expense_account_id" integer,
  "allowance_expense_account_id" integer,
  "salary_payable_account_id" integer,
  "tax_payable_account_id" integer,
  "bpjs_payable_account_id" integer,
  "qris_account_id" integer,
  "qris_journal_id" integer
);

CREATE TABLE public."chart_of_accounts" (
  "id" integer DEFAULT nextval('chart_of_accounts_id_seq'::regclass) NOT NULL,
  "company_id" integer,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "type" account_type,
  "parent_id" integer,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "account_type" text DEFAULT 'other'::text NOT NULL,
  "subtype" text,
  "normal_balance" text DEFAULT 'DEBIT'::text NOT NULL,
  "account_category" text DEFAULT 'ASSET'::text NOT NULL,
  "is_postable" boolean DEFAULT true NOT NULL,
  "is_header" boolean DEFAULT false NOT NULL,
  "effective_from" timestamp with time zone,
  "effective_to" timestamp with time zone,
  "status" text DEFAULT 'ACTIVE'::text NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" text,
  "updated_by" text,
  "approved_by" text,
  "approved_at" timestamp with time zone,
  "rejected_by" text,
  "rejected_at" timestamp with time zone,
  "rejection_reason" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."companies" (
  "id" integer DEFAULT nextval('companies_id_seq'::regclass) NOT NULL,
  "name" text,
  "legal_name" text,
  "npwp" text,
  "address" text,
  "city" text,
  "province" text,
  "postal_code" text,
  "phone" text,
  "email" text,
  "website" text,
  "industry" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp without time zone DEFAULT now() NOT NULL,
  "code" text DEFAULT ''::text NOT NULL,
  "is_holding" boolean DEFAULT false NOT NULL,
  "parent_company_id" integer,
  "logo_url" text,
  "is_active" boolean DEFAULT true NOT NULL,
  "company_name" text,
  "company_code" text,
  "kode_wilayah" text,
  "fax" text,
  "npwp_status" text,
  "kegiatan_utama" text,
  "jenis_wajib_pajak" text,
  "bentuk_badan_hukum" text,
  "tanggal_terdaftar" text,
  "tanggal_aktivasi" text,
  "status_pkp" boolean,
  "tanggal_pkp" text,
  "kanwil_djp" text,
  "kpp_terdaftar" text,
  "seksi_pengawasan" text,
  "tanggal_pembaruan_profil" text,
  "kode_klu" text,
  "deskripsi_klu" text,
  "nib" text
);

CREATE TABLE public."financial_periods" (
  "id" integer DEFAULT nextval('financial_periods_id_seq'::regclass) NOT NULL,
  "company_id" integer NOT NULL,
  "month" integer NOT NULL,
  "year" integer NOT NULL,
  "is_closed" boolean DEFAULT false NOT NULL,
  "override_allowed" boolean DEFAULT false NOT NULL,
  "closed_at" timestamp without time zone,
  "closed_by" text,
  "created_at" timestamp without time zone DEFAULT now() NOT NULL,
  "period_close_signature" text,
  "close_reason" text
);

CREATE TABLE public."fleet_cash_payments" (
  "id" integer DEFAULT nextval('fleet_cash_payments_id_seq'::regclass) NOT NULL,
  "company_id" integer NOT NULL,
  "outstanding_id" integer,
  "driver_id" integer,
  "driver_name" text NOT NULL,
  "driver_external_id" text,
  "driver_phone" text,
  "vehicle_plate" text,
  "payment_date" date DEFAULT CURRENT_DATE NOT NULL,
  "amount" numeric(18,4) NOT NULL,
  "payment_method" text DEFAULT 'cash'::text NOT NULL,
  "reference_no" text,
  "notes" text,
  "recorded_by" text,
  "status" text DEFAULT 'confirmed'::text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "accounting_entry_id" integer
);

CREATE TABLE public."fleet_ledger_entries" (
  "id" bigint DEFAULT nextval('fleet_ledger_entries_id_seq'::regclass) NOT NULL,
  "company_id" integer NOT NULL,
  "ledger_date" date NOT NULL,
  "period" text NOT NULL,
  "source_type" text NOT NULL,
  "source_id" integer,
  "source_ref" text,
  "account_id" integer NOT NULL,
  "account_code" text NOT NULL,
  "account_name" text NOT NULL,
  "account_type" text NOT NULL,
  "debit" numeric(15,2) DEFAULT 0 NOT NULL,
  "credit" numeric(15,2) DEFAULT 0 NOT NULL,
  "description" text,
  "cost_center_id" integer,
  "currency" text DEFAULT 'IDR'::text NOT NULL,
  "is_voided" boolean DEFAULT false NOT NULL,
  "void_ref_id" bigint,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public."fleet_outstanding" (
  "id" integer DEFAULT nextval('fleet_outstanding_id_seq'::regclass) NOT NULL,
  "company_id" integer,
  "driver_id" integer,
  "driver_external_id" text,
  "driver_name" text NOT NULL,
  "outstanding_amount" numeric(18,2) DEFAULT 0,
  "last_updated_date" date,
  "due_days" integer DEFAULT 0,
  "status" text DEFAULT 'open'::text NOT NULL,
  "notes" text,
  "resolved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "is_notified" boolean DEFAULT false NOT NULL,
  "last_wa_sent_at" timestamp with time zone,
  "rental_fee_daily" numeric(14,2) DEFAULT 0,
  "snapshot_source" text,
  "driver_phone" text,
  "vehicle_plate" text
);
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_entry_number_unique" UNIQUE (entry_number);
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_entry_lines" ADD CONSTRAINT "accounting_entry_lines_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_journals" ADD CONSTRAINT "accounting_journals_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_pkey" PRIMARY KEY (id);
ALTER TABLE public."chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY (id);
ALTER TABLE public."companies" ADD CONSTRAINT "companies_pkey" PRIMARY KEY (id);
ALTER TABLE public."financial_periods" ADD CONSTRAINT "financial_periods_company_month_year_uniq" UNIQUE (company_id, month, year);
ALTER TABLE public."financial_periods" ADD CONSTRAINT "financial_periods_month_check" CHECK (((month >= 1) AND (month <= 12)));
ALTER TABLE public."financial_periods" ADD CONSTRAINT "financial_periods_pkey" PRIMARY KEY (id);
ALTER TABLE public."fleet_cash_payments" ADD CONSTRAINT "fleet_cash_payments_pkey" PRIMARY KEY (id);
ALTER TABLE public."fleet_ledger_entries" ADD CONSTRAINT "fleet_ledger_entries_pkey" PRIMARY KEY (id);
ALTER TABLE public."fleet_outstanding" ADD CONSTRAINT "fleet_outstanding_pkey" PRIMARY KEY (id);
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_cost_center_id_fkey" FOREIGN KEY (cost_center_id) REFERENCES cost_centers(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_entries" ADD CONSTRAINT "accounting_entries_journal_id_accounting_journals_id_fk" FOREIGN KEY (journal_id) REFERENCES accounting_journals(id) ON DELETE RESTRICT;
ALTER TABLE public."accounting_entry_lines" ADD CONSTRAINT "accounting_entry_lines_account_id_chart_of_accounts_id_fk" FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id) ON DELETE RESTRICT;
ALTER TABLE public."accounting_entry_lines" ADD CONSTRAINT "accounting_entry_lines_entry_id_accounting_entries_id_fk" FOREIGN KEY (entry_id) REFERENCES accounting_entries(id) ON DELETE CASCADE;
ALTER TABLE public."accounting_journals" ADD CONSTRAINT "accounting_journals_default_credit_account_id_chart_of_accounts" FOREIGN KEY (default_credit_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_journals" ADD CONSTRAINT "accounting_journals_default_debit_account_id_chart_of_accounts_" FOREIGN KEY (default_debit_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_allowance_expense_account_id_fkey" FOREIGN KEY (allowance_expense_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_ap_account_id_chart_of_accounts_id_fk" FOREIGN KEY (ap_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_ar_account_id_chart_of_accounts_id_fk" FOREIGN KEY (ar_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_bank_journal_id_accounting_journals_id_fk" FOREIGN KEY (bank_journal_id) REFERENCES accounting_journals(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_bpjs_payable_account_id_fkey" FOREIGN KEY (bpjs_payable_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_cash_journal_id_accounting_journals_id_fk" FOREIGN KEY (cash_journal_id) REFERENCES accounting_journals(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_cogs_account_id_chart_of_accounts_id_fk" FOREIGN KEY (cogs_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_default_bank_account_id_chart_of_accounts_i" FOREIGN KEY (default_bank_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_default_cash_account_id_chart_of_accounts_i" FOREIGN KEY (default_cash_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_default_purchase_tax_id_accounting_taxes_id" FOREIGN KEY (default_purchase_tax_id) REFERENCES accounting_taxes(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_default_sales_tax_id_accounting_taxes_id_fk" FOREIGN KEY (default_sales_tax_id) REFERENCES accounting_taxes(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_fleet_cash_account_id_fkey" FOREIGN KEY (fleet_cash_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_fleet_driver_receivable_account_id_fkey" FOREIGN KEY (fleet_driver_receivable_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_inventory_account_id_chart_of_accounts_id_f" FOREIGN KEY (inventory_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_ppn_input_account_id_chart_of_accounts_id_f" FOREIGN KEY (ppn_input_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_ppn_output_account_id_chart_of_accounts_id_" FOREIGN KEY (ppn_output_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_purchase_expense_account_id_chart_of_accoun" FOREIGN KEY (purchase_expense_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_purchase_journal_id_accounting_journals_id_" FOREIGN KEY (purchase_journal_id) REFERENCES accounting_journals(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_qris_account_id_fkey" FOREIGN KEY (qris_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_qris_journal_id_fkey" FOREIGN KEY (qris_journal_id) REFERENCES accounting_journals(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_salary_expense_account_id_fkey" FOREIGN KEY (salary_expense_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_salary_payable_account_id_fkey" FOREIGN KEY (salary_payable_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_sales_income_account_id_chart_of_accounts_i" FOREIGN KEY (sales_income_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_sales_journal_id_accounting_journals_id_fk" FOREIGN KEY (sales_journal_id) REFERENCES accounting_journals(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_tax_payable_account_id_fkey" FOREIGN KEY (tax_payable_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."accounting_settings" ADD CONSTRAINT "accounting_settings_tenant_rent_income_account_id_fkey" FOREIGN KEY (tenant_rent_income_account_id) REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
ALTER TABLE public."fleet_cash_payments" ADD CONSTRAINT "fleet_cash_payments_accounting_entry_id_fkey" FOREIGN KEY (accounting_entry_id) REFERENCES accounting_entries(id) ON DELETE SET NULL;
ALTER TABLE public."fleet_ledger_entries" ADD CONSTRAINT "fleet_ledger_entries_account_id_fkey" FOREIGN KEY (account_id) REFERENCES chart_of_accounts(id);
CREATE UNIQUE INDEX fleet_outstanding_company_legacy_name_uq ON public.fleet_outstanding USING btree (company_id, lower(TRIM(BOTH FROM driver_name))) WHERE ((status = 'open'::text) AND (driver_id IS NULL));
CREATE UNIQUE INDEX accounting_entries_canonical_event_uniq ON public.accounting_entries USING btree (company_id, source, source_event_id) WHERE ((source = 'sport_center_payment'::accounting_entry_source) AND (source_event_id IS NOT NULL));
CREATE UNIQUE INDEX coa_global_code_uniq ON public.chart_of_accounts USING btree (code) WHERE (company_id IS NULL);
CREATE UNIQUE INDEX uq_public_accounting_entries_sc_payment_correlation ON public.accounting_entries USING btree (correlation_id) WHERE ((source = 'sport_center_payment'::accounting_entry_source) AND (correlation_id IS NOT NULL));
CREATE UNIQUE INDEX companies_code_uniq ON public.companies USING btree (code);
CREATE UNIQUE INDEX coa_company_code_uniq ON public.chart_of_accounts USING btree (company_id, code);
CREATE UNIQUE INDEX uq_public_accounting_entries_source_payment_id ON public.accounting_entries USING btree (source_payment_id) WHERE (source_payment_id IS NOT NULL);
CREATE UNIQUE INDEX fleet_outstanding_company_driver_id_uq ON public.fleet_outstanding USING btree (company_id, driver_id) WHERE ((status = 'open'::text) AND (driver_id IS NOT NULL));
CREATE UNIQUE INDEX accounting_entries_company_source_ref_uniq ON public.accounting_entries USING btree (company_id, source, ref) WHERE (status = ANY (ARRAY['posted'::accounting_entry_status, 'pending_approval'::accounting_entry_status, 'approved'::accounting_entry_status]));
CREATE UNIQUE INDEX accounting_entries_company_source_source_id_uniq ON public.accounting_entries USING btree (company_id, source, source_id) WHERE ((source IS NOT NULL) AND (source_id IS NOT NULL) AND (source <> 'manual'::accounting_entry_source));
CREATE UNIQUE INDEX journals_company_code_uniq ON public.accounting_journals USING btree (company_id, code);

CREATE OR REPLACE FUNCTION public.fn_block_posted_entry_delete()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    BEGIN
      IF OLD.status = 'posted' THEN
        RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Cannot delete a posted journal entry (id=%). Use reversal.', OLD.id;
      END IF;
      RETURN OLD;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_block_posted_lines_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      entry_status TEXT;
    BEGIN
      SELECT status INTO entry_status
      FROM accounting_entries
      WHERE id = COALESCE(NEW.entry_id, OLD.entry_id);

      IF entry_status = 'posted' THEN
        RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Cannot mutate lines of a posted journal entry. Use reversal.';
      END IF;
      RETURN COALESCE(NEW, OLD);
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.payroll_financial_period_insert_audit()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public'
AS $function$
BEGIN
 IF current_user='bizportal_payroll_dev' THEN
  INSERT INTO public.payroll_financial_setup_events(company_id,run_id,action,period_id,request_id,actor_id,actor_email,note)
  VALUES(NEW.company_id,NULLIF(current_setting('app.payroll_setup_run_id',true),'')::integer,'period_registered',NEW.id,
    NULLIF(current_setting('app.payroll_setup_request_id',true),'')::uuid,current_setting('app.payroll_setup_actor_id',true),current_setting('app.payroll_setup_actor_email',true),current_setting('app.payroll_setup_note',true));
 END IF;
 RETURN NEW;
END $function$
;

CREATE OR REPLACE FUNCTION public.ae_immutability_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      v_is_closed BOOLEAN;
      v_override  BOOLEAN;
    BEGIN
      -- Jika status berubah dari 'posted' ke bukan 'voided' → BLOK
      IF OLD.status = 'posted' AND NEW.status IS DISTINCT FROM OLD.status AND NEW.status <> 'voided' THEN
        RAISE EXCEPTION
          'LEDGER IMMUTABILITY VIOLATION [UPDATE]: Entry #% status=posted TIDAK BISA diubah ke "%" — '
          'hanya perubahan ke "voided" (via reversal) yang diizinkan. '
          'Untuk membatalkan, gunakan voidApprovedJournal() atau POST /api/accounting/payments/:id/void.',
          OLD.id, NEW.status;
      END IF;

      -- Jika data finansial diubah pada entry posted → BLOK
      IF OLD.status = 'posted' AND (
        NEW.total_debit IS DISTINCT FROM OLD.total_debit OR
        NEW.total_credit IS DISTINCT FROM OLD.total_credit OR
        NEW.journal_id IS DISTINCT FROM OLD.journal_id OR
        NEW.date IS DISTINCT FROM OLD.date OR
        NEW.source IS DISTINCT FROM OLD.source OR
        NEW.source_id IS DISTINCT FROM OLD.source_id
      ) THEN
        RAISE EXCEPTION
          'LEDGER IMMUTABILITY VIOLATION [UPDATE]: Financial fields pada posted entry #% TIDAK BISA diubah. '
          'total_debit, total_credit, journal_id, date, source, source_id bersifat IMMUTABLE setelah di-post. '
          'Buat reversal entry untuk koreksi.',
          OLD.id;
      END IF;

      -- ── P0 hardening: draft→posted transition juga wajib lolos period lock ──
      -- postEntry() insert entry sebagai 'draft' dulu baru UPDATE ke 'posted'
      -- (untuk satisfy trg_block_lines_mutation). ae_period_lock_insert_guard
      -- hanya menangkap INSERT langsung dengan status='posted'; transisi
      -- draft→posted lewat UPDATE harus dicek di sini juga.
      IF OLD.status = 'draft' AND NEW.status = 'posted'
         AND NEW.company_id IS NOT NULL AND NEW.date IS NOT NULL
         AND NEW.source NOT IN ('closing_entry', 'reversal', 'bank_reconciliation_void')
      THEN
        SELECT is_closed, override_allowed INTO v_is_closed, v_override
        FROM financial_periods
        WHERE company_id = NEW.company_id
          AND year  = EXTRACT(YEAR  FROM NEW.date)::INT
          AND month = EXTRACT(MONTH FROM NEW.date)::INT
        LIMIT 1;

        IF v_is_closed AND NOT COALESCE(v_override, FALSE) THEN
          RAISE EXCEPTION
            'LEDGER PERIOD LOCK VIOLATION [UPDATE draft→posted]: Entry #% tidak bisa diposting ke '
            'periode %-% yang sudah DITUTUP (company_id=%, source=%).',
            OLD.id, EXTRACT(YEAR FROM NEW.date), EXTRACT(MONTH FROM NEW.date), NEW.company_id, NEW.source;
        END IF;
      END IF;

      -- ── P2 hardening: tag/audit metadata columns immutable setelah di-set ────
      -- Sebelumnya kolom ini (ledger_source_type, ledger_source_id, checksum_hash,
      -- previous_entry_id) BOLEH diubah kapan saja karena dianggap "metadata".
      -- Ini adalah celah: seseorang bisa re-tag source sebuah entry posted tanpa
      -- jejak audit. Pola pakai yang sah (tagJournalEntry/checksum computation)
      -- selalu men-set dari NULL → nilai, sesaat setelah INSERT selesai. Maka:
      -- set pertama (OLD IS NULL) tetap diizinkan, tapi begitu terisi, TIDAK
      -- BISA diubah lagi oleh siapapun/apapun.
      IF OLD.ledger_source_type IS NOT NULL AND NEW.ledger_source_type IS DISTINCT FROM OLD.ledger_source_type THEN
        RAISE EXCEPTION 'LEDGER IMMUTABILITY VIOLATION [UPDATE]: ledger_source_type entry #% sudah di-set ("%") dan TIDAK BISA diubah lagi ke "%".',
          OLD.id, OLD.ledger_source_type, NEW.ledger_source_type;
      END IF;
      IF OLD.ledger_source_id IS NOT NULL AND NEW.ledger_source_id IS DISTINCT FROM OLD.ledger_source_id THEN
        RAISE EXCEPTION 'LEDGER IMMUTABILITY VIOLATION [UPDATE]: ledger_source_id entry #% sudah di-set dan TIDAK BISA diubah lagi.', OLD.id;
      END IF;
      IF OLD.checksum_hash IS NOT NULL AND NEW.checksum_hash IS DISTINCT FROM OLD.checksum_hash THEN
        RAISE EXCEPTION 'LEDGER IMMUTABILITY VIOLATION [UPDATE]: checksum_hash entry #% sudah di-set dan TIDAK BISA diubah lagi.', OLD.id;
      END IF;
      IF OLD.previous_entry_id IS NOT NULL AND NEW.previous_entry_id IS DISTINCT FROM OLD.previous_entry_id THEN
        RAISE EXCEPTION 'LEDGER IMMUTABILITY VIOLATION [UPDATE]: previous_entry_id entry #% sudah di-set dan TIDAK BISA diubah lagi.', OLD.id;
      END IF;

      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_block_posted_entry_update()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    BEGIN
      IF OLD.status = 'posted' THEN
        -- Izinkan cancellation: status posted → draft dengan cancel_reason terisi
        IF NEW.status = 'draft' AND NEW.cancel_reason IS NOT NULL AND NEW.cancelled_at IS NOT NULL THEN
          RETURN NEW;
        END IF;
        IF current_setting('sport_center.allow_posted_payment_metadata_correction', true) = 'on'
          AND current_setting('sport_center.allow_posted_accounting_metadata_correction', true) = 'on'
          AND (to_jsonb(NEW) - ARRAY['payment_method','payment_provider']::text[])
              IS NOT DISTINCT FROM
              (to_jsonb(OLD) - ARRAY['payment_method','payment_provider']::text[])
        THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'IMMUTABILITY_VIOLATION: Cannot modify a posted journal entry (id=%). Posted entries are immutable. Use a reversal entry.', OLD.id;
      END IF;
      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_validate_entry_company_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
DECLARE
  v_journal_company_id integer;
BEGIN
  IF NEW.journal_id IS NULL OR NEW.company_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT company_id INTO v_journal_company_id
  FROM accounting_journals WHERE id = NEW.journal_id;

  IF v_journal_company_id IS NOT NULL AND v_journal_company_id != NEW.company_id THEN
    RAISE EXCEPTION 'accounting_entries.company_id (%) tidak cocok dengan accounting_journals.company_id (%) untuk journal_id %',
      NEW.company_id, v_journal_company_id, NEW.journal_id;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.check_period_locked()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      v_month          INTEGER;
      v_year           INTEGER;
      v_company_id     INTEGER;
      v_is_closed      BOOLEAN;
      v_override       BOOLEAN;
    BEGIN
      -- Ambil company_id dan tanggal dari baris baru
      v_company_id := NEW.company_id;

      -- Kolom date bisa bertipe DATE atau TIMESTAMP; cast aman ke DATE dulu
      v_month := EXTRACT(MONTH FROM NEW.date::DATE)::INTEGER;
      v_year  := EXTRACT(YEAR  FROM NEW.date::DATE)::INTEGER;

      -- Skip jika company_id NULL (data lama tanpa company)
      IF v_company_id IS NULL THEN
        RETURN NEW;
      END IF;

      -- Cek apakah periode terkunci
      SELECT is_closed, override_allowed
        INTO v_is_closed, v_override
        FROM financial_periods
       WHERE company_id = v_company_id
         AND month      = v_month
         AND year       = v_year
       LIMIT 1;

      -- Tidak ada row di financial_periods → periode belum didefinisikan → boleh
      IF NOT FOUND THEN
        RETURN NEW;
      END IF;

      -- Periode ditutup dan tidak ada override → BLOK
      IF v_is_closed AND NOT COALESCE(v_override, FALSE) THEN
        RAISE EXCEPTION 'PERIOD_LOCKED: Periode %/% untuk company_id % sudah ditutup dan tidak dapat diubah.',
          v_month, v_year, v_company_id
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.bizportal_customer_ar_after_source_dev()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  candidates jsonb := '[]'::jsonb;
  candidate record;
  evidence record;
  activation timestamptz;
  relation_name text;
  new_row jsonb;
  old_row jsonb;
BEGIN
  -- Unknown/disabled actors leave existing posting behavior unchanged. The
  -- privileged legacy issuer is explicit in admin-owned config, not inferred
  -- from admin membership or supplied via GUC.
  IF current_user <> session_user OR NOT has_table_privilege(current_user,
    'public.bizportal_customer_ar_source_actors_dev', 'SELECT') THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bizportal_customer_ar_source_actors_dev
    WHERE role_name = session_user AND enabled) THEN RETURN NULL; END IF;
  FOREACH relation_name IN ARRAY ARRAY['sales_documents', 'accounting_entries',
    'accounting_entry_lines', 'accounting_settings', 'chart_of_accounts',
    'accounting_journals', 'ar_subledger', 'bizportal_customer_ar_source_evidence_dev'] LOOP
    IF NOT has_table_privilege(current_user, 'public.' || relation_name, 'SELECT') THEN
      RAISE WARNING 'CUSTOMER_AR_ACTOR_READ_PRIVILEGE_INCOMPLETE %', relation_name;
      RETURN NULL;
    END IF;
  END LOOP;
  IF TG_OP <> 'DELETE' THEN new_row := to_jsonb(NEW); END IF;
  IF TG_OP <> 'INSERT' THEN old_row := to_jsonb(OLD); END IF;
  IF TG_TABLE_NAME = 'sales_documents' THEN
    candidates := jsonb_build_array(
      jsonb_build_object('company_id', new_row->'company_id', 'invoice_id', new_row->'id'),
      jsonb_build_object('company_id', old_row->'company_id', 'invoice_id', old_row->'id'));
  ELSIF TG_TABLE_NAME = 'accounting_entries' THEN
    IF new_row->>'source' IN ('sales_invoice', 'reversal') THEN
      candidates := candidates || jsonb_build_array(jsonb_build_object('company_id', new_row->'company_id', 'invoice_id', new_row->'source_id', 'source', new_row->'source', 'journal_id', new_row->'journal_id'));
    END IF;
    IF old_row->>'source' IN ('sales_invoice', 'reversal') THEN
      candidates := candidates || jsonb_build_array(jsonb_build_object('company_id', old_row->'company_id', 'invoice_id', old_row->'source_id', 'source', old_row->'source', 'journal_id', old_row->'journal_id'));
    END IF;
  ELSIF TG_TABLE_NAME = 'accounting_entry_lines' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('company_id', company_id, 'invoice_id', source_id, 'source', source::text, 'journal_id', journal_id)), '[]'::jsonb)
      INTO candidates FROM public.accounting_entries
      WHERE id IN ((new_row->>'entry_id')::integer, (old_row->>'entry_id')::integer)
        AND source::text IN ('sales_invoice', 'reversal');
  ELSE RAISE EXCEPTION 'CUSTOMER_AR_UNEXPECTED_TRIGGER_RELATION'; END IF;
  -- Sales reversal uses invoice id; the generic canonical reverseJournal
  -- uses original entry id. Resolve both within the same company and journal.
  SELECT candidates || coalesce(jsonb_agg(jsonb_build_object(
    'company_id', original.company_id, 'invoice_id', original.source_id)), '[]'::jsonb)
    INTO candidates
  FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer, source text, journal_id integer)
  JOIN public.accounting_entries original ON original.id = x.invoice_id
    AND original.company_id = x.company_id AND original.source::text = 'sales_invoice'
    AND original.journal_id = x.journal_id
  WHERE x.source = 'reversal';
  -- Filter BEFORE isolation/locking: unapproved companies cannot change the
  -- posting behavior of an otherwise approved administrative issuer.
  SELECT coalesce(jsonb_agg(jsonb_build_object('company_id', x.company_id,
    'invoice_id', x.invoice_id)), '[]'::jsonb) INTO candidates
  FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer)
  JOIN public.bizportal_customer_ar_source_actors_dev actor
    ON actor.role_name = session_user AND actor.company_id = x.company_id AND actor.enabled
  WHERE x.company_id IS NOT NULL AND x.invoice_id IS NOT NULL;
  IF candidates = '[]'::jsonb THEN RETURN NULL; END IF;
  -- One DEV projection lock avoids opposite invoice lock ordering within
  -- batch transactions. Each following statement sees a fresh RC snapshot;
  -- journal-first and invoice-first concurrent commits therefore converge.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'CUSTOMER_AR_SOURCE_REQUIRES_READ_COMMITTED_RETRY' USING ERRCODE = '40001';
  END IF;
  PERFORM pg_advisory_xact_lock(69069, 1);
  FOR candidate IN SELECT DISTINCT x.company_id, x.invoice_id
    FROM jsonb_to_recordset(candidates) AS x(company_id integer, invoice_id integer)
    WHERE x.company_id IS NOT NULL AND x.invoice_id IS NOT NULL
    ORDER BY x.company_id, x.invoice_id
  LOOP
    SELECT source_not_before INTO activation FROM public.bizportal_customer_ar_source_actors_dev
      WHERE role_name = session_user AND company_id = candidate.company_id AND enabled;
    IF NOT FOUND THEN CONTINUE; END IF;
    SELECT * INTO evidence FROM public.bizportal_customer_ar_source_evidence_dev e
      WHERE e.company_id = candidate.company_id AND e.invoice_id = candidate.invoice_id
        AND e.source_created_at >= activation;
    IF NOT FOUND THEN
      -- Never erase history or alter another owner's AR row. Preview rechecks
      -- proof independently, including reversals written by an unlisted actor.
      UPDATE public.ar_subledger SET status = 'STALE', updated_at = clock_timestamp()
        WHERE company_id = candidate.company_id AND invoice_id = candidate.invoice_id
          AND notes = 'bizportal:customer-ar-source:v1' AND status <> 'STALE';
      CONTINUE;
    END IF;
    INSERT INTO public.ar_subledger AS ledger
      (company_id, invoice_id, customer_id, invoice_number, invoice_date, due_date,
       currency, gross_amount, outstanding_amount, paid_amount, status, gl_entry_id, period, notes)
    VALUES (evidence.company_id, evidence.invoice_id, evidence.customer_id,
      evidence.invoice_number, evidence.invoice_date, evidence.due_date, 'IDR',
      evidence.gross_amount, evidence.outstanding_amount, evidence.paid_amount,
      evidence.ar_status, evidence.gl_entry_id, to_char(evidence.invoice_date, 'YYYY-MM'),
      'bizportal:customer-ar-source:v1')
    ON CONFLICT (company_id, invoice_id) WHERE invoice_id IS NOT NULL DO UPDATE
      SET customer_id = EXCLUDED.customer_id, invoice_number = EXCLUDED.invoice_number,
          invoice_date = EXCLUDED.invoice_date, due_date = EXCLUDED.due_date,
          gross_amount = EXCLUDED.gross_amount, outstanding_amount = EXCLUDED.outstanding_amount,
          paid_amount = EXCLUDED.paid_amount, status = EXCLUDED.status,
          period = EXCLUDED.period, updated_at = clock_timestamp()
      WHERE ledger.notes = 'bizportal:customer-ar-source:v1'
        AND ledger.gl_entry_id = EXCLUDED.gl_entry_id
        AND ROW(ledger.customer_id, ledger.invoice_number, ledger.invoice_date, ledger.due_date,
          ledger.gross_amount, ledger.outstanding_amount, ledger.paid_amount, ledger.status, ledger.period)
          IS DISTINCT FROM ROW(EXCLUDED.customer_id, EXCLUDED.invoice_number, EXCLUDED.invoice_date,
          EXCLUDED.due_date, EXCLUDED.gross_amount, EXCLUDED.outstanding_amount,
          EXCLUDED.paid_amount, EXCLUDED.status, EXCLUDED.period);
  END LOOP;
  RETURN NULL;
EXCEPTION WHEN insufficient_privilege THEN
  -- A revoked role grant must not break an existing canonical source posting.
  -- This subtransaction's projection changes roll back; preview stays unproven.
  RAISE WARNING 'CUSTOMER_AR_ACTOR_WRITE_PRIVILEGE_INCOMPLETE';
  RETURN NULL;
END
$function$
;

CREATE OR REPLACE FUNCTION public.ae_insert_guard_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    BEGIN
      -- Block completely anonymous inserts (no source at all)
      IF NEW.source IS NULL THEN
        RAISE EXCEPTION
          'LEDGER GUARD VIOLATION [INSERT]: accounting_entries.source WAJIB diisi. '
          'Gunakan ledgerGuard.createJournal() atau postEntry() melalui application layer. '
          'Direct SQL insert ke accounting_entries TIDAK DIIZINKAN.';
      END IF;
      -- Warn jika tidak ada actor (created_by_id)
      -- NOTE: NEW.source::text dipakai (bukan enum compare langsung) karena
      -- 'system_boot' BUKAN label valid di enum accounting_entry_source —
      -- compare langsung ke enum akan RAISE ERROR "invalid input value for enum"
      -- untuk SEMUA insert (bukan cuma warning) begitu trigger ini aktif.
      IF NEW.created_by_id IS NULL AND NEW.source::text NOT IN ('manual', 'system_boot', 'closing_entry') THEN
        RAISE WARNING
          'LEDGER GUARD WARNING [INSERT]: accounting_entries #% tidak memiliki created_by_id (source=%). '
          'Semua journal non-manual HARUS memiliki actor yang jelas.',
          NEW.id, NEW.source;
      END IF;
      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_fleet_ledger_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'LEDGER_IMMUTABLE: Ledger entries cannot be deleted (id=%).',  OLD.id;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id           <> OLD.id          OR
       NEW.debit        <> OLD.debit        OR
       NEW.credit       <> OLD.credit       OR
       NEW.account_id   <> OLD.account_id   OR
       (NEW.source_id IS DISTINCT FROM OLD.source_id) OR
       NEW.ledger_date  <> OLD.ledger_date  OR
       NEW.period       <> OLD.period       OR
       NEW.source_type  <> OLD.source_type  THEN
      RAISE EXCEPTION 'LEDGER_IMMUTABLE: Core ledger fields are immutable (id=%).',  OLD.id;
    END IF;
    IF NEW.is_voided = false AND OLD.is_voided = true THEN
      RAISE EXCEPTION 'LEDGER_IMMUTABLE: Cannot un-void a ledger entry (id=%).', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.ae_period_lock_insert_guard_fn()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      v_is_closed BOOLEAN;
      v_override  BOOLEAN;
    BEGIN
      IF NEW.status = 'posted'
         AND NEW.company_id IS NOT NULL
         AND NEW.date IS NOT NULL
         AND NEW.source NOT IN ('closing_entry', 'reversal', 'bank_reconciliation_void')
      THEN
        SELECT is_closed, override_allowed INTO v_is_closed, v_override
        FROM financial_periods
        WHERE company_id = NEW.company_id
          AND year  = EXTRACT(YEAR  FROM NEW.date)::INT
          AND month = EXTRACT(MONTH FROM NEW.date)::INT
        LIMIT 1;

        IF v_is_closed AND NOT COALESCE(v_override, FALSE) THEN
          RAISE EXCEPTION
            'LEDGER PERIOD LOCK VIOLATION [INSERT]: accounting_entries tidak bisa di-insert '
            'dengan status=posted ke periode %-% yang sudah DITUTUP (company_id=%, source=%). '
            'Buat reversal/adjustment di periode terbuka, atau set override_allowed=true pada '
            'financial_periods jika koreksi ini benar-benar disengaja.',
            EXTRACT(YEAR FROM NEW.date), EXTRACT(MONTH FROM NEW.date), NEW.company_id, NEW.source;
        END IF;
      END IF;
      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_sync_entry_line_to_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      v_company_id  INTEGER;
      v_date        DATE;
      v_period      TEXT;
      v_source_type TEXT;
      v_source_id   INTEGER;
      v_entry_num   TEXT;
      v_created_by  TEXT;
      v_code        TEXT;
      v_name        TEXT;
      v_type        TEXT;
    BEGIN
      -- ambil data dari accounting_entries
      SELECT
        ae.company_id, ae.date, to_char(ae.date, 'YYYY-MM'),
        ae.source::text, ae.source_id, ae.entry_number, ae.created_by_id
      INTO
        v_company_id, v_date, v_period,
        v_source_type, v_source_id, v_entry_num, v_created_by
      FROM accounting_entries ae
      WHERE ae.id = NEW.entry_id;

      IF NOT FOUND THEN RETURN NEW; END IF;

      -- ambil data COA
      SELECT code, name, type::text
      INTO v_code, v_name, v_type
      FROM chart_of_accounts
      WHERE id = NEW.account_id;

      IF NOT FOUND THEN RETURN NEW; END IF;

      BEGIN
        INSERT INTO fleet_ledger_entries (
          company_id, ledger_date, period,
          source_type, source_id, source_ref,
          account_id, account_code, account_name, account_type,
          debit, credit, description, created_by
        ) VALUES (
          v_company_id, v_date, v_period,
          v_source_type, v_source_id, v_entry_num,
          NEW.account_id, v_code, v_name, v_type,
          COALESCE(NEW.debit,  0),
          COALESCE(NEW.credit, 0),
          NEW.description,
          v_created_by
        );
      EXCEPTION WHEN OTHERS THEN
        -- Period lock atau error lain: catat di log, jangan abort transaksi utama
        RAISE WARNING '[fn_sync_entry_line_to_ledger] INSERT gagal (entry_id=%, account_id=%): %',
          NEW.entry_id, NEW.account_id, SQLERRM;
      END;

      RETURN NEW;
    END;
    $function$
;

CREATE OR REPLACE FUNCTION public.fn_ledger_period_lock()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'sport_center', 'ai_platform', 'pg_temp'
AS $function$
    DECLARE
      v_month      INTEGER;
      v_year       INTEGER;
      v_is_closed  BOOLEAN;
      v_override   BOOLEAN;
    BEGIN
      IF NEW.source_type = 'closing_entry' THEN
        RETURN NEW;
      END IF;

      v_month := EXTRACT(MONTH FROM NEW.ledger_date)::INTEGER;
      v_year  := EXTRACT(YEAR  FROM NEW.ledger_date)::INTEGER;

      SELECT is_closed, override_allowed
        INTO v_is_closed, v_override
        FROM financial_periods
       WHERE company_id = NEW.company_id
         AND month      = v_month
         AND year       = v_year
       LIMIT 1;

      IF NOT FOUND THEN
        RETURN NEW;
      END IF;

      IF v_is_closed AND NOT COALESCE(v_override, FALSE) THEN
        RAISE EXCEPTION 'PERIOD_LOCKED: Ledger periode %/% untuk company_id % sudah ditutup.',
          v_month, v_year, NEW.company_id
          USING ERRCODE = 'P0001';
      END IF;

      RETURN NEW;
    END;
    $function$
;
CREATE CONSTRAINT TRIGGER customer_ar_journal_lines_dev AFTER INSERT OR DELETE OR UPDATE ON public.accounting_entry_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bizportal_customer_ar_after_source_dev();
CREATE TRIGGER trg_block_lines_delete BEFORE DELETE ON public.accounting_entry_lines FOR EACH ROW EXECUTE FUNCTION fn_block_posted_lines_mutation();
CREATE TRIGGER trg_block_lines_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.accounting_entry_lines FOR EACH ROW EXECUTE FUNCTION fn_block_posted_lines_mutation();
CREATE TRIGGER trg_block_lines_update BEFORE UPDATE ON public.accounting_entry_lines FOR EACH ROW EXECUTE FUNCTION fn_block_posted_lines_mutation();
CREATE TRIGGER trg_sync_entry_line_to_ledger AFTER INSERT ON public.accounting_entry_lines FOR EACH ROW EXECUTE FUNCTION fn_sync_entry_line_to_ledger();
CREATE TRIGGER payroll_financial_period_audit AFTER INSERT ON public.financial_periods FOR EACH ROW EXECUTE FUNCTION payroll_financial_period_insert_audit();
CREATE TRIGGER trg_fleet_ledger_immutable BEFORE DELETE OR UPDATE ON public.fleet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_fleet_ledger_immutable();
CREATE TRIGGER trg_ledger_period_lock BEFORE INSERT ON public.fleet_ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_ledger_period_lock();
CREATE TRIGGER ae_immutability BEFORE UPDATE ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION ae_immutability_fn();
CREATE TRIGGER ae_insert_guard BEFORE INSERT ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION ae_insert_guard_fn();
CREATE TRIGGER ae_period_lock_insert_guard BEFORE INSERT ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION ae_period_lock_insert_guard_fn();
CREATE CONSTRAINT TRIGGER customer_ar_journal_source_dev AFTER INSERT OR DELETE OR UPDATE ON public.accounting_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION bizportal_customer_ar_after_source_dev();
CREATE TRIGGER trg_block_posted_delete BEFORE DELETE ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION fn_block_posted_entry_delete();
CREATE TRIGGER trg_block_posted_update BEFORE UPDATE ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION fn_block_posted_entry_update();
CREATE TRIGGER trg_check_period_locked_entries BEFORE INSERT OR UPDATE OF date, company_id ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION check_period_locked();
CREATE TRIGGER trg_validate_entry_company_id BEFORE INSERT OR UPDATE OF company_id, journal_id ON public.accounting_entries FOR EACH ROW EXECUTE FUNCTION fn_validate_entry_company_id();

-- Fixture policy boundary for the disposable QA login, not a shared-DEV migration.
CREATE ROLE fleet_finance_qa_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
GRANT CONNECT ON DATABASE fleet_finance_qa TO fleet_finance_qa_api;
GRANT USAGE ON SCHEMA public TO fleet_finance_qa_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO fleet_finance_qa_api;
GRANT SELECT ON public.companies, public.chart_of_accounts, public.accounting_journals, public.financial_periods, public.bizportal_customer_ar_source_actors_dev TO fleet_finance_qa_api;
GRANT SELECT, UPDATE ON public.accounting_settings TO fleet_finance_qa_api;
GRANT SELECT ON public.fleet_cash_payments, public.fleet_outstanding TO fleet_finance_qa_api;
GRANT SELECT, INSERT, UPDATE ON public.accounting_entries, public.accounting_entry_lines TO fleet_finance_qa_api;
GRANT SELECT, INSERT ON public.fleet_ledger_entries TO fleet_finance_qa_api;
ALTER TABLE public.fleet_cash_payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_source ON public.fleet_cash_payments TO fleet_finance_qa_api USING (company_id=1) WITH CHECK(company_id=1);
ALTER TABLE public.fleet_outstanding ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_source ON public.fleet_outstanding TO fleet_finance_qa_api USING (company_id=1) WITH CHECK(company_id=1);
ALTER TABLE public.accounting_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_target ON public.accounting_entries TO fleet_finance_qa_api USING (company_id=3) WITH CHECK(company_id=3);
ALTER TABLE public.accounting_entry_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_target ON public.accounting_entry_lines TO fleet_finance_qa_api USING (EXISTS(SELECT 1 FROM public.accounting_entries e WHERE e.id=entry_id AND e.company_id=3)) WITH CHECK(company_id=3 AND EXISTS(SELECT 1 FROM public.accounting_entries e WHERE e.id=entry_id AND e.company_id=3));
ALTER TABLE public.fleet_ledger_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_target ON public.fleet_ledger_entries TO fleet_finance_qa_api USING (company_id=3) WITH CHECK(company_id=3);
ALTER TABLE public.accounting_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY qa_target ON public.accounting_settings TO fleet_finance_qa_api USING (company_id=3) WITH CHECK(company_id=3);
