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
 (103,1,'QA-PPN-CST','Synthetic PPN payable CST','liability',null,'ACTIVE','LIABILITY','CREDIT'),
 (301,3,'QA-AR-DIVA','Synthetic receivable DIVA','asset','receivable','ACTIVE','ASSET','DEBIT'),
 (302,3,'QA-REV-DIVA','Synthetic sales DIVA','revenue',null,'ACTIVE','REVENUE','CREDIT'),
 (303,3,'QA-PPN-DIVA','Synthetic PPN payable DIVA','liability',null,'ACTIVE','LIABILITY','CREDIT');
INSERT INTO public.accounting_journals(id,company_id,code,name,type) VALUES
 (11,1,'SCST','Synthetic CST Sales','sales'),
 (31,3,'SDIV','Synthetic DIVA Sales','sales');
INSERT INTO public.accounting_taxes
(id,company_id,name,rate,kind,account_id)
VALUES (1,1,'Synthetic PPN 11% CST',11,'sale',103),
       (3,3,'Synthetic PPN 11% DIVA',11,'sale',303),
       (4,3,'Synthetic PPN 12% DIVA',12,'sale',303);
INSERT INTO public.accounting_settings
 (company_id,ar_account_id,sales_income_account_id,sales_journal_id,ppn_output_account_id,default_sales_tax_id)
VALUES (1,101,102,11,103,1),(3,301,302,31,303,3);

INSERT INTO public.sales_documents
 (id,doc_number,kind,status,invoice_status,customer_name,total_amount,tax_amount,
  grand_total,company_id,invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id)
VALUES
 (171,'QA-ORDER-171','order','confirmed','invoiced','Synthetic CST A',100,0,100,1,'QA-CST-171','2026-11-18','2026-12-18','none',null),
 (173,'QA-ORDER-173','order','confirmed','invoiced','Synthetic DIVA B',100,0,100,3,'QA-DIVA-173','2026-11-18','2026-12-18','none',null),
 (175,'QA-ORDER-175','order','confirmed','invoiced','Synthetic rollback',100,0,100,1,'QA-CST-175','2026-11-18','2026-12-18','none',null),
 (177,'QA-ORDER-177','order','confirmed','invoiced','Synthetic taxable wrong treatment',100,11,111,1,'QA-CST-177','2026-11-18','2026-12-18','taxable',1),
 (179,'QA-ORDER-179','order','confirmed','invoiced','Synthetic PPN CST',100,11,111,1,'QA-CST-179','2026-11-18','2026-12-18','exclusive',1),
 (183,'QA-ORDER-183','order','confirmed','invoiced','Synthetic PPN DIVA',100,11,111,3,'QA-DIVA-183','2026-11-18','2026-12-18','exclusive',3),
 (185,'QA-ORDER-185','order','confirmed','invoiced','Synthetic PPN wrong amount',100,101.75,201.75,1,'QA-CST-185','2026-11-18','2026-12-18','exclusive',1),
 (187,'QA-ORDER-187','order','confirmed','invoiced','Synthetic foreign company tax',100,11,111,3,'QA-DIVA-187','2026-11-18','2026-12-18','exclusive',1),
 (189,'QA-ORDER-189','order','confirmed','invoiced','Synthetic taxable rollback',100,11,111,1,'QA-CST-189','2026-11-18','2026-12-18','exclusive',1),
 (193,'QA-ORDER-193','order','confirmed','invoiced','Synthetic PPN 12% DIVA',100,12,112,3,'QA-DIVA-193','2026-11-18','2026-12-18','exclusive',4),
 (195,'QA-ORDER-195','order','confirmed','invoiced','Synthetic PPN 12% rollback DIVA',100,12,112,3,'QA-DIVA-195','2026-11-18','2026-12-18','exclusive',4);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES (171,'Synthetic service',1,100,100),
 (173,'Synthetic service',1,100,100),
 (175,'Synthetic service',1,100,100),
 (177,'Synthetic taxable service',1,100,100),
 (179,'Synthetic PPN CST service',1,100,100),
 (183,'Synthetic PPN DIVA service',1,100,100),
 (185,'Synthetic invalid PPN service',1,100,100),
 (187,'Synthetic cross-company PPN',1,100,100),
 (189,'Synthetic taxable rollback PPN',1,100,100),
 (193,'Synthetic PPN 12% DIVA service',1,100,100),
 (195,'Synthetic PPN 12% DIVA rollback service',1,100,100);
