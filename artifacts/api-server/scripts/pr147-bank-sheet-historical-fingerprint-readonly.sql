-- PR #147: read-only historical integrity fingerprint.
-- Execute ONLY against approved CST-DEV after independent project validation.
-- Never run a migration, UPDATE, INSERT, DELETE, or ledger correction as part of fingerprinting.
-- For a source-only cutover: capture before and after and require equal digests
-- for the protected legacy groups. A mismatch requires forensic review, not
-- automatic reconciliation. MD5 here is an accidental-change indicator, not
-- a cryptographic authorization or proof of original Sheet identity.
WITH historical AS (
 SELECT bm.* FROM public.bank_mutations bm WHERE bm.sheet_config_id=4
), journal_refs AS (
 SELECT m.id AS mutation_id, m.journal_entry_id,
        ae.id AS accounting_entry_id, ae.status, ae.entry_status,
        ae.posted_at, ae.total_debit, ae.total_credit
 FROM public.bank_mutations m
 LEFT JOIN public.accounting_entries ae ON ae.id=m.journal_entry_id
 WHERE m.sheet_config_id=4 AND m.journal_entry_id IS NOT NULL
)
SELECT
 (SELECT count(*) FROM public.bank_mutations) AS all_mutations,
 (SELECT count(*) FROM historical) AS historical_count,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(h)::text),'' ORDER BY h.id),''))
  FROM historical h) AS historical_mutations_md5,
 (SELECT count(*) FROM journal_refs) AS linked_journal_count,
 (SELECT count(*) FROM journal_refs WHERE accounting_entry_id IS NULL)
  AS missing_journals,
 (SELECT count(*) FROM journal_refs
  WHERE accounting_entry_id IS NOT NULL
  AND (status::text<>'posted' OR posted_at IS NULL))
  AS nonfinal_journals,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(j)::text),'' ORDER BY j.mutation_id),''))
  FROM journal_refs j) AS journal_linkage_md5,
 (SELECT md5(coalesce(string_agg(md5(to_jsonb(s)::text),'' ORDER BY s.id),''))
  FROM public.bank_sheet_configs s) AS sheet_configs_md5;
