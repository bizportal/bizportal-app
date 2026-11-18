-- New sources; the reviewed canonical owner must post these through DIRECT
-- company logins after the original baseline completed.
INSERT INTO public.sales_documents
 (id,doc_number,kind,status,invoice_status,customer_name,total_amount,tax_amount,
  grand_total,company_id,invoice_number,invoice_date,due_date,tax_treatment,tax_rate_id)
VALUES
 (195,'QA-OWNER-SCOPED-195','order','confirmed','invoiced','Synthetic CST role',100,11,111,1,'QA-CST-195','2026-11-18','2026-12-18','exclusive',1),
 (197,'QA-OWNER-SCOPED-197','order','confirmed','invoiced','Synthetic DIVA role',100,11,111,3,'QA-DIVA-197','2026-11-18','2026-12-18','exclusive',3),
 (199,'QA-OWNER-SCOPED-199','order','confirmed','invoiced','Synthetic role rollback',100,11,111,1,'QA-CST-199','2026-11-18','2026-12-18','exclusive',1);
INSERT INTO public.sales_document_lines(document_id,name,quantity,unit_price,subtotal)
VALUES (195,'QA role CST service',1,100,100),
       (197,'QA role DIVA service',1,100,100),
       (199,'QA role rollback service',1,100,100);
