-- PR95: verify the exact source-journal reuse HOLD predicate on disposable PG16.
-- No production data or credentials. Never execute in CST-DEV/PROD.
begin;
create schema pr95_source_guard;
create table pr95_source_guard.bank_disbursements(
  id integer primary key, company_id integer, entry_id integer, status text,
  void_entry_id integer
);
create table pr95_source_guard.bank_disbursement_items(
  id integer primary key, disbursement_id integer not null,
  vendor_invoice_id integer
);
create table pr95_source_guard.accounting_entries(
  id integer primary key, company_id integer, status text,
  cancelled_at timestamptz, voided_at timestamptz
);
insert into pr95_source_guard.bank_disbursements values
  (2,1,314,'posted',null),
  (3,2,315,'posted',null),
  (4,1,316,'void',null),
  (5,1,317,'posted',318),
  (6,1,319,'posted',null),
  (7,1,320,'posted',null),
  (8,1,321,'posted',null);
insert into pr95_source_guard.bank_disbursement_items values
  (1,2,7),(2,3,8),(3,4,9),(4,5,10),(5,6,11),(6,7,12),(7,8,13);
insert into pr95_source_guard.accounting_entries values
  (314,1,'posted',null,null),
  (315,2,'posted',null,null),
  (316,1,'posted',null,null),
  (317,1,'posted',null,null),
  (319,1,'posted',null,now()),
  (320,1,'posted',now(),null),
  (321,1,'draft',null,null);
commit;

create or replace function pr95_source_guard.has_posted_source(
  p_invoice_ids bigint[], p_company_id integer
) returns boolean language plpgsql as $fn$
declare found_row boolean;
begin
  select exists(
    select 1
      from pr95_source_guard.bank_disbursement_items bdi
      join pr95_source_guard.bank_disbursements bd on bd.id=bdi.disbursement_id
      join pr95_source_guard.accounting_entries ae on ae.id=bd.entry_id
       and ae.company_id=bd.company_id
     where bdi.vendor_invoice_id=any(p_invoice_ids)
       and bd.company_id=p_company_id
       and bd.status='posted'
       and bd.void_entry_id is null
       and ae.status='posted'
       and ae.cancelled_at is null
       and ae.voided_at is null
  ) into found_row;
  return found_row;
end;$fn$;

do $test$
begin
  if not pr95_source_guard.has_posted_source(array[7]::bigint[],1) then
    raise exception 'ACTIVE_POSTED_SOURCE_NOT_BLOCKED';
  end if;
  if pr95_source_guard.has_posted_source(array[7]::bigint[],2) then
    raise exception 'CROSS_COMPANY_LEAK';
  end if;
  if pr95_source_guard.has_posted_source(array[8]::bigint[],1) then
    raise exception 'OTHER_COMPANY_SOURCE_NOT_SCOPED';
  end if;
  if pr95_source_guard.has_posted_source(array[9]::bigint[],1) then
    raise exception 'VOID_DISBURSEMENT_FALSE_BLOCK';
  end if;
  if pr95_source_guard.has_posted_source(array[10]::bigint[],1) then
    raise exception 'REVERSED_DISBURSEMENT_FALSE_BLOCK';
  end if;
  if pr95_source_guard.has_posted_source(array[11]::bigint[],1) then
    raise exception 'VOIDED_JOURNAL_FALSE_BLOCK';
  end if;
  if pr95_source_guard.has_posted_source(array[12]::bigint[],1) then
    raise exception 'CANCELLED_JOURNAL_FALSE_BLOCK';
  end if;
  if pr95_source_guard.has_posted_source(array[13]::bigint[],1) then
    raise exception 'NONPOSTED_JOURNAL_FALSE_BLOCK';
  end if;
  if not pr95_source_guard.has_posted_source(array[7,8,9]::bigint[],1) then
    raise exception 'MULTI_INVOICE_ACTIVE_SOURCE_MISSED';
  end if;
  raise notice 'PASS: source guard active, tenant, void, reversal, cancellation, draft and multi-invoice cases';
end;$test$;
drop schema pr95_source_guard cascade;
