-- Disposable Postgres 16-only contractual rehearsal. NEVER use a real DB.
-- Entire schema, roles, rows and grants are within BEGIN/ROLLBACK.
BEGIN;
SET LOCAL lock_timeout='1000ms';
SET LOCAL statement_timeout='30000ms';
DO $$
BEGIN
 IF current_database()<>'cst_pr81_writer_ci'
 OR current_user<>'postgres'
 THEN RAISE EXCEPTION 'DISPOSABLE_DB_IDENTITY_REQUIRED'; END IF;
END $$;

CREATE ROLE ci_pr81_writer NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE SCHEMA ci_pr81_finance;
CREATE TABLE ci_pr81_finance.po (
 id bigint PRIMARY KEY, company_id int NOT NULL, supplier_id int NOT NULL,
 status text NOT NULL CHECK (status='confirmed')
);
CREATE TABLE ci_pr81_finance.shipment (
 id bigint PRIMARY KEY, po_id bigint NOT NULL REFERENCES ci_pr81_finance.po(id),
 status text NOT NULL CHECK (status='delivered')
);
CREATE TABLE ci_pr81_finance.gr (
 id bigint PRIMARY KEY, shipment_id bigint NOT NULL REFERENCES ci_pr81_finance.shipment(id),
 inspection_status text NOT NULL CHECK (inspection_status='passed')
);
CREATE TABLE ci_pr81_finance.vi (
 id bigint PRIMARY KEY, company_id int NOT NULL, supplier_id int NOT NULL,
 po_id bigint NOT NULL REFERENCES ci_pr81_finance.po(id),
 gr_id bigint NOT NULL REFERENCES ci_pr81_finance.gr(id),
 status text NOT NULL, three_way_match_status text NOT NULL
);
CREATE TABLE ci_pr81_finance.ap (
 id bigint PRIMARY KEY, company_id int NOT NULL, supplier_id int NOT NULL,
 invoice_id bigint NOT NULL UNIQUE REFERENCES ci_pr81_finance.vi(id),
 po_id bigint NOT NULL REFERENCES ci_pr81_finance.po(id),
 gr_id bigint NOT NULL REFERENCES ci_pr81_finance.gr(id),
 status text NOT NULL CHECK (status IN ('ap_preparation','finance_review','waiting_payment')),
 finance_reviewed_at timestamptz,waiting_payment_at timestamptz
);
CREATE TABLE ci_pr81_finance.payment_requests (
 id bigint PRIMARY KEY, company_id int NOT NULL,
 ap_id bigint NOT NULL UNIQUE REFERENCES ci_pr81_finance.ap(id),
 idempotency_key text NOT NULL UNIQUE,
 status text NOT NULL CHECK (status='draft'),
 paid_amount numeric NOT NULL DEFAULT 0 CHECK (paid_amount=0),
 journal_entry_id bigint CHECK (journal_entry_id IS NULL)
);
CREATE TABLE ci_pr81_finance.accounting_handoffs (
 id bigint PRIMARY KEY,company_id int NOT NULL,
 ap_id bigint NOT NULL UNIQUE REFERENCES ci_pr81_finance.ap(id),
 payment_id bigint NOT NULL UNIQUE REFERENCES ci_pr81_finance.payment_requests(id),
 handoff_key text NOT NULL UNIQUE,correlation_reference text NOT NULL UNIQUE,
 status text NOT NULL CHECK (status='accepted'),
 accounting_status text NOT NULL CHECK (accounting_status='draft_not_posted')
);
CREATE TABLE ci_pr81_finance.accounting_entries (
 id bigint PRIMARY KEY, company_id int NOT NULL, amount numeric NOT NULL
);
INSERT INTO ci_pr81_finance.po VALUES (11,1,10,'confirmed'),(31,3,35,'confirmed');
INSERT INTO ci_pr81_finance.shipment VALUES (12,11,'delivered'),(32,31,'delivered');
INSERT INTO ci_pr81_finance.gr VALUES (13,12,'passed'),(33,32,'passed');
INSERT INTO ci_pr81_finance.vi VALUES
 (14,1,10,11,13,'ready_for_ap','passed'),
 (15,1,10,11,13,'ready_for_ap','passed'),
 (34,3,35,31,33,'ready_for_ap','passed');

GRANT ci_pr81_writer TO postgres WITH SET TRUE;
GRANT USAGE ON SCHEMA ci_pr81_finance TO ci_pr81_writer;
GRANT SELECT ON ci_pr81_finance.po,ci_pr81_finance.shipment,
 ci_pr81_finance.gr,ci_pr81_finance.vi,ci_pr81_finance.ap,
 ci_pr81_finance.payment_requests,ci_pr81_finance.accounting_handoffs
 TO ci_pr81_writer;
GRANT INSERT,UPDATE ON ci_pr81_finance.ap TO ci_pr81_writer;
GRANT INSERT ON ci_pr81_finance.payment_requests,ci_pr81_finance.accounting_handoffs
 TO ci_pr81_writer;

ALTER TABLE ci_pr81_finance.po ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.shipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.gr ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.vi ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.ap ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.payment_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE ci_pr81_finance.accounting_handoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY po_scope ON ci_pr81_finance.po FOR SELECT TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int);
CREATE POLICY sh_scope ON ci_pr81_finance.shipment FOR SELECT TO ci_pr81_writer
 USING (EXISTS (SELECT 1 FROM ci_pr81_finance.po p WHERE p.id=po_id));
CREATE POLICY gr_scope ON ci_pr81_finance.gr FOR SELECT TO ci_pr81_writer
 USING (EXISTS (SELECT 1 FROM ci_pr81_finance.shipment s WHERE s.id=shipment_id));
CREATE POLICY vi_scope ON ci_pr81_finance.vi FOR SELECT TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
    AND EXISTS (SELECT 1 FROM ci_pr81_finance.po p
     WHERE p.id=po_id AND p.company_id=ci_pr81_finance.vi.company_id
       AND p.supplier_id=ci_pr81_finance.vi.supplier_id)
    AND EXISTS (SELECT 1 FROM ci_pr81_finance.gr g WHERE g.id=gr_id));
CREATE POLICY ap_scope ON ci_pr81_finance.ap FOR SELECT TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
    AND EXISTS (SELECT 1 FROM ci_pr81_finance.vi v
     WHERE v.id=invoice_id AND v.company_id=ci_pr81_finance.ap.company_id
       AND v.supplier_id=ci_pr81_finance.ap.supplier_id));
CREATE POLICY ap_insert ON ci_pr81_finance.ap FOR INSERT TO ci_pr81_writer
 WITH CHECK (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
    AND status='ap_preparation'
    AND EXISTS (SELECT 1 FROM ci_pr81_finance.vi v
     WHERE v.id=invoice_id AND v.company_id=ci_pr81_finance.ap.company_id
       AND v.supplier_id=ci_pr81_finance.ap.supplier_id
       AND v.po_id=ci_pr81_finance.ap.po_id AND v.gr_id=ci_pr81_finance.ap.gr_id
       AND v.status='ready_for_ap' AND v.three_way_match_status='passed'));
CREATE POLICY ap_update ON ci_pr81_finance.ap FOR UPDATE TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int)
 WITH CHECK (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
   AND status IN ('ap_preparation','finance_review','waiting_payment'));
CREATE POLICY payment_scope ON ci_pr81_finance.payment_requests FOR SELECT TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
  AND EXISTS (SELECT 1 FROM ci_pr81_finance.ap a
     WHERE a.id=ap_id AND a.company_id=ci_pr81_finance.payment_requests.company_id));
CREATE POLICY payment_insert ON ci_pr81_finance.payment_requests FOR INSERT TO ci_pr81_writer
 WITH CHECK (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
   AND status='draft' AND paid_amount=0 AND journal_entry_id IS NULL
   AND EXISTS (SELECT 1 FROM ci_pr81_finance.ap a
     WHERE a.id=ap_id AND a.company_id=ci_pr81_finance.payment_requests.company_id
       AND a.status='waiting_payment'));
CREATE POLICY handoff_scope ON ci_pr81_finance.accounting_handoffs FOR SELECT TO ci_pr81_writer
 USING (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
   AND EXISTS (SELECT 1 FROM ci_pr81_finance.ap a
     WHERE a.id=ap_id AND a.company_id=ci_pr81_finance.accounting_handoffs.company_id)
   AND EXISTS (SELECT 1 FROM ci_pr81_finance.payment_requests p
     WHERE p.id=payment_id AND p.company_id=ci_pr81_finance.accounting_handoffs.company_id));
CREATE POLICY handoff_insert ON ci_pr81_finance.accounting_handoffs FOR INSERT TO ci_pr81_writer
 WITH CHECK (company_id=nullif(current_setting('app.marketplace_company_id',true),'')::int
   AND status='accepted' AND accounting_status='draft_not_posted'
   AND EXISTS (SELECT 1 FROM ci_pr81_finance.ap a
     WHERE a.id=ap_id AND a.company_id=ci_pr81_finance.accounting_handoffs.company_id
       AND a.status='waiting_payment')
   AND EXISTS (SELECT 1 FROM ci_pr81_finance.payment_requests p
     WHERE p.id=payment_id AND p.ap_id=ci_pr81_finance.accounting_handoffs.ap_id
       AND p.company_id=ci_pr81_finance.accounting_handoffs.company_id
       AND p.status='draft' AND p.journal_entry_id IS NULL));

SET LOCAL ROLE ci_pr81_writer;
DO $$
BEGIN
 IF current_user<>'ci_pr81_writer'
 OR NOT row_security_active('ci_pr81_finance.vi'::regclass)
 OR NOT row_security_active('ci_pr81_finance.ap'::regclass)
 OR NOT row_security_active('ci_pr81_finance.payment_requests'::regclass)
 OR NOT row_security_active('ci_pr81_finance.accounting_handoffs'::regclass)
 OR has_table_privilege(current_user,'ci_pr81_finance.accounting_entries','INSERT')
 OR has_table_privilege(current_user,'ci_pr81_finance.payment_requests','UPDATE')
 THEN RAISE EXCEPTION 'WRITER_ROLE_RLS_OR_GL_PRIVILEGE_INVARIANT_FAILED'; END IF;
END $$;

DO $$
BEGIN
 IF (SELECT count(*) FROM ci_pr81_finance.vi)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.ap)<>0
 THEN RAISE EXCEPTION 'UNBOUND_TENANT_DATA_LEAK'; END IF;
END $$;
SET LOCAL app.marketplace_company_id='1';
DO $$
BEGIN
 IF (SELECT count(*) FROM ci_pr81_finance.vi)<>2
 THEN RAISE EXCEPTION 'CST_INVOICE_SCOPE_INVALID'; END IF;
END $$;

-- Same AP lifecycle and exactly-once draft handoff pattern as canonical service.
INSERT INTO ci_pr81_finance.ap VALUES (110,1,10,14,11,13,'ap_preparation',NULL,NULL);
DO $$
DECLARE changed int;
BEGIN
 INSERT INTO ci_pr81_finance.ap VALUES (111,1,10,14,11,13,'ap_preparation',NULL,NULL)
 ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'AP_DUPLICATE_ON_REPLAY'; END IF;
 UPDATE ci_pr81_finance.ap SET status='finance_review',finance_reviewed_at=now()
 WHERE id=110 AND status='ap_preparation';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'AP_REVIEW_TRANSITION_FAILED'; END IF;
 UPDATE ci_pr81_finance.ap SET status='finance_review' WHERE id=110 AND status='ap_preparation';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'AP_REVIEW_REPLAY_MODIFIED'; END IF;
 UPDATE ci_pr81_finance.ap SET status='waiting_payment',waiting_payment_at=now()
 WHERE id=110 AND status='finance_review';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>1 THEN RAISE EXCEPTION 'AP_WAITING_PAYMENT_TRANSITION_FAILED'; END IF;
 UPDATE ci_pr81_finance.ap SET status='waiting_payment' WHERE id=110 AND status='finance_review';
 GET DIAGNOSTICS changed=ROW_COUNT;
 IF changed<>0 THEN RAISE EXCEPTION 'AP_WAITING_PAYMENT_REPLAY_MODIFIED'; END IF;
END $$;
INSERT INTO ci_pr81_finance.ap VALUES (120,1,10,15,11,13,'ap_preparation',NULL,NULL);
DO $$
DECLARE rejected bool := false;
BEGIN
 BEGIN
  INSERT INTO ci_pr81_finance.payment_requests VALUES
    (220,1,120,'mkt-ap:120','paid',100,NULL);
 EXCEPTION WHEN insufficient_privilege OR check_violation THEN rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'PAID_PAYMENT_INSERT_NOT_DENIED'; END IF;
END $$;

INSERT INTO ci_pr81_finance.payment_requests VALUES (210,1,110,'mkt-ap:110','draft',0,NULL);
INSERT INTO ci_pr81_finance.accounting_handoffs VALUES
 (310,1,110,210,'mkt-ap:110','MKT-AP-110','accepted','draft_not_posted');
DO $$
DECLARE inserted int;
BEGIN
 INSERT INTO ci_pr81_finance.payment_requests VALUES
   (211,1,110,'mkt-ap:110','draft',0,NULL) ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>0 THEN RAISE EXCEPTION 'DUPLICATE_PAYMENT_REQUEST'; END IF;
 INSERT INTO ci_pr81_finance.accounting_handoffs VALUES
   (311,1,110,210,'mkt-ap:110','MKT-AP-REPLAY','accepted','draft_not_posted')
   ON CONFLICT DO NOTHING;
 GET DIAGNOSTICS inserted=ROW_COUNT;
 IF inserted<>0 THEN RAISE EXCEPTION 'DUPLICATE_ACCOUNTING_HANDOFF'; END IF;
 IF (SELECT count(*) FROM ci_pr81_finance.payment_requests WHERE ap_id=110)<>1
 OR (SELECT count(*) FROM ci_pr81_finance.accounting_handoffs WHERE ap_id=110)<>1
 OR (SELECT count(*) FROM ci_pr81_finance.ap WHERE id=110 AND status='waiting_payment')<>1
 THEN RAISE EXCEPTION 'REPLAY_COUNT_OR_STATE_INVALID'; END IF;
END $$;
SELECT 'CST_AP_WAITING_PAYMENT_DRAFT_PAYMENT_DRAFT_NOT_POSTED_HANDOFF_REPLAY_PASS' AS checkpoint;

-- Cross-tenant insert must fail when the writer is bound to CST.
DO $$
DECLARE denied bool := false;
BEGIN
 BEGIN
  INSERT INTO ci_pr81_finance.ap VALUES (330,3,35,34,31,33,'ap_preparation',NULL,NULL);
 EXCEPTION WHEN insufficient_privilege OR check_violation THEN denied:=true;
 END;
 IF NOT denied THEN RAISE EXCEPTION 'CROSS_COMPANY_AP_INSERT_NOT_DENIED'; END IF;
END $$;

SET LOCAL app.marketplace_company_id='3';
DO $$
BEGIN
 IF (SELECT count(*) FROM ci_pr81_finance.vi)<>1
 OR (SELECT count(*) FROM ci_pr81_finance.ap)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.payment_requests)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.accounting_handoffs)<>0
 THEN RAISE EXCEPTION 'DIVA_SAW_CST_PAYMENT_OR_HANDOFF'; END IF;
END $$;
INSERT INTO ci_pr81_finance.ap VALUES (330,3,35,34,31,33,'ap_preparation',NULL,NULL);
UPDATE ci_pr81_finance.ap SET status='finance_review' WHERE id=330 AND status='ap_preparation';
UPDATE ci_pr81_finance.ap SET status='waiting_payment' WHERE id=330 AND status='finance_review';
INSERT INTO ci_pr81_finance.payment_requests VALUES (430,3,330,'mkt-ap:330','draft',0,NULL);
INSERT INTO ci_pr81_finance.accounting_handoffs VALUES
 (530,3,330,430,'mkt-ap:330','MKT-AP-330','accepted','draft_not_posted');
DO $$
BEGIN
 IF (SELECT count(*) FROM ci_pr81_finance.ap WHERE id=330 AND status='waiting_payment')<>1
 OR (SELECT count(*) FROM ci_pr81_finance.payment_requests WHERE ap_id=330 AND status='draft')<>1
 OR (SELECT count(*) FROM ci_pr81_finance.accounting_handoffs WHERE ap_id=330 AND accounting_status='draft_not_posted')<>1
 THEN RAISE EXCEPTION 'DIVA_OWN_AP_OR_HANDOFF_FAILED'; END IF;
END $$;
SET LOCAL app.marketplace_company_id='1';
DO $$
BEGIN
 IF (SELECT count(*) FROM ci_pr81_finance.ap WHERE id=330)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.payment_requests WHERE ap_id=330)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.accounting_handoffs WHERE ap_id=330)<>0
 OR (SELECT count(*) FROM ci_pr81_finance.payment_requests WHERE ap_id=110)<>1
 OR (SELECT count(*) FROM ci_pr81_finance.accounting_handoffs WHERE ap_id=110)<>1
 THEN RAISE EXCEPTION 'RECIPROCAL_FINANCE_TENANT_ISOLATION_FAILED'; END IF;
END $$;
SELECT 'CROSS_TENANT_INSERT_DENIED_AND_RECIPROCAL_READ_SCOPE_PASS' AS checkpoint;
SELECT 'IDEMPOTENT_SINGLE_DRAFT_PAYMENT_HANDOFF_NO_GL_PASS' AS checkpoint;
ROLLBACK;
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ci_pr81_writer')
 OR to_regclass('ci_pr81_finance.payment_requests') IS NOT NULL
 OR to_regclass('ci_pr81_finance.accounting_handoffs') IS NOT NULL
 THEN RAISE EXCEPTION 'POST_ROLLBACK_DISPOSABLE_FIXTURE_RESIDUAL'; END IF;
END $$;
SELECT 'PR81_DISPOSABLE_PG16_WRITER_REHEARSAL_PASS_ROLLBACK_CLEAN' AS result;
