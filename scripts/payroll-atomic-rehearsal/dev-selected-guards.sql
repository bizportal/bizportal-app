-- READ-ONLY metadata snapshot, CST-DEV, 2026-11-17. Apply only to a disposable
-- fixture. No live trigger is replaced/disabled by the test launcher.
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
    $function$;

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
    $function$;

CREATE OR REPLACE FUNCTION public.payroll_dev_block_non_draft_item_changes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE parent_status text;
BEGIN
 SELECT status INTO parent_status FROM public.payroll_runs WHERE id=(CASE WHEN TG_OP='INSERT' THEN NEW.run_id ELSE OLD.run_id END) FOR SHARE;
 IF parent_status IS DISTINCT FROM 'draft' THEN
   RAISE EXCEPTION 'PAYROLL_RUN_LOCKED_FOR_REVIEW' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.run_id IS DISTINCT FROM OLD.run_id THEN
   SELECT status INTO parent_status FROM public.payroll_runs WHERE id=NEW.run_id FOR SHARE;
   IF parent_status IS DISTINCT FROM 'draft' THEN
     RAISE EXCEPTION 'PAYROLL_TARGET_RUN_LOCKED_FOR_REVIEW' USING ERRCODE='23514';
   END IF;
 END IF;
 RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END $function$;

CREATE OR REPLACE FUNCTION public.payroll_dev_hr_review_status_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF OLD.status='reviewed' AND NEW.status IS DISTINCT FROM OLD.status AND
    NOT (NEW.status='approved' AND NEW.accounting_entry_id IS NOT NULL) THEN
  RAISE EXCEPTION 'PAYROLL_HR_REVIEW_CANNOT_BE_REOPENED' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $function$;

-- Replace only the simplified test guard created by the fixture, not a live
-- guard. Actual DEV trigger names and events are retained for the snapshot.
DROP TRIGGER ci_review_guard ON payroll_runs;
CREATE TRIGGER trg_block_posted_update BEFORE UPDATE ON public.accounting_entries
FOR EACH ROW EXECUTE FUNCTION public.fn_block_posted_entry_update();
CREATE TRIGGER trg_block_lines_mutation BEFORE INSERT OR DELETE OR UPDATE ON public.accounting_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_block_posted_lines_mutation();
CREATE TRIGGER trg_block_lines_delete BEFORE DELETE ON public.accounting_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_block_posted_lines_mutation();
CREATE TRIGGER trg_block_lines_update BEFORE UPDATE ON public.accounting_entry_lines
FOR EACH ROW EXECUTE FUNCTION public.fn_block_posted_lines_mutation();
CREATE TRIGGER payroll_dev_review_item_guard BEFORE INSERT OR DELETE OR UPDATE ON public.payroll_items
FOR EACH ROW EXECUTE FUNCTION public.payroll_dev_block_non_draft_item_changes();
CREATE TRIGGER payroll_dev_hr_review_status_guard BEFORE UPDATE OF status ON public.payroll_runs
FOR EACH ROW EXECUTE FUNCTION public.payroll_dev_hr_review_status_guard();
