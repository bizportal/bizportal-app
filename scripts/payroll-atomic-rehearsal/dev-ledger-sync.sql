-- Isolated fixture definitions copied read-only from CST-DEV on 2026-11-17.
-- Never apply this fixture file to a live Supabase database.
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
    $function$;

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
$function$;

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
    $function$;

CREATE TRIGGER trg_sync_entry_line_to_ledger AFTER INSERT ON public.accounting_entry_lines
 FOR EACH ROW EXECUTE FUNCTION public.fn_sync_entry_line_to_ledger();
CREATE TRIGGER trg_fleet_ledger_immutable BEFORE DELETE OR UPDATE ON public.fleet_ledger_entries
 FOR EACH ROW EXECUTE FUNCTION public.fn_fleet_ledger_immutable();
CREATE TRIGGER trg_ledger_period_lock BEFORE INSERT ON public.fleet_ledger_entries
 FOR EACH ROW EXECUTE FUNCTION public.fn_ledger_period_lock();
