-- Only synthetic records in the disposable invoice_synthetic PostgreSQL database.
DO $guard$
BEGIN
  IF current_database() <> 'invoice_synthetic' THEN
    RAISE EXCEPTION 'DISPOSABLE_ONLY';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_documents LIMIT 1) THEN
    RAISE EXCEPTION 'DISPOSABLE_ONLY: source must start empty';
  END IF;
END
$guard$;

INSERT INTO public.companies(id,company_name,company_code) VALUES
  (1,'Synthetic CST','SCST'),(3,'Synthetic DIVA','SDIVA');
INSERT INTO public.chart_of_accounts
  (id,company_id,code,name,type,subtype,status,account_category,normal_balance)
VALUES
 (101,1,'QA-AR-CST','Synthetic receivable CST','asset','receivable','ACTIVE','ASSET','DEBIT'),
 (102,1,'QA-REV-CST','Synthetic sales CST','revenue',null,'ACTIVE','REVENUE','CREDIT'),
 (301,3,'QA-AR-DIVA','Synthetic receivable DIVA','asset','receivable','ACTIVE','ASSET','DEBIT'),
 (302,3,'QA-REV-DIVA','Synthetic sales DIVA','revenue',null,'ACTIVE','REVENUE','CREDIT');
INSERT INTO public.accounting_journals(id,company_id,code,name,type) VALUES
 (11,1,'SCST','Synthetic CST Sales','sales'),
 (31,3,'SDIV','Synthetic DIVA Sales','sales');
INSERT INTO public.accounting_settings
 (company_id,ar_account_id,sales_income_account_id,sales_journal_id)
VALUES (1,101,102,11),(3,301,302,31);

INSERT INTO public.sales_documents
 (id,doc_number,kind,status,invoice_status,customer_name,total_amount,tax_amount,
  grand_total,company_id,invoice_number,invoice_date,due_date,tax_treatment)
VALUES
 (171,'QA-ORDER-171','order','confirmed','invoiced','Synthetic CST A',100,0,100,1,'QA-CST-171','2026-11-18','2026-12-18','none'),
 (173,'QA-ORDER-173','order','confirmed','invoiced','Synthetic DIVA B',100,0,100,3,'QA-DIVA-173','2026-11-18','2026-12-18','none'),
 (175,'QA-ORDER-175','order','confirmed','invoiced','Synthetic rollback',100,0,100,1,'QA-CST-175','2026-11-18','2026-12-18','none'),
 (177,'QA-ORDER-177','order','confirmed','invoiced','Synthetic taxable',100,11,111,1,'QA-CST-177','2026-11-18','2026-12-18','taxable');
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES (171,'Synthetic service',1,100,100),
 (173,'Synthetic service',1,100,100),
 (175,'Synthetic service',1,100,100),
 (177,'Synthetic taxable service',1,100,100);
