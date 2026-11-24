#!/usr/bin/env python3
"""Run the actual TypeScript bankSheetConfigAccountJoin against disposable PG.

Requires the workflow ephemeral PostgreSQL service and standard PG* env vars.
No connection to CST-DEV or PROD is permitted by this test.
"""
from pathlib import Path
import subprocess

source = Path("artifacts/api-server/src/lib/bankSheetConfigAccountJoin.ts").read_text()
marker = "export const bankSheetConfigAccountJoin = "
raw = source.split(marker, 1)[1].split(";", 1)[0].strip()
tick = chr(96)
if not (raw.startswith(tick) and raw.endswith(tick)):
    raise SystemExit("FAIL: could not extract SQL join from source")
join = raw[1:-1]

def psql(sql: str) -> str:
    result = subprocess.run(
        ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-Atqc", sql],
        check=True, text=True, capture_output=True,
    )
    return result.stdout.strip()

def join_result(config_id: int) -> str:
    sql = "SELECT coalesce(cba.id::text,'NULL') FROM public.bank_sheet_configs config " + join + " WHERE config.id=" + str(config_id)
    return psql(sql)

# Legacy schema: no bank_account_id column. Unique number matching works;
# duplicate numbers fail closed; company scope remains enforced.
psql("""
DROP TABLE IF EXISTS public.bank_sheet_configs CASCADE;
DROP TABLE IF EXISTS public.company_bank_accounts CASCADE;
CREATE TABLE public.company_bank_accounts (
  id integer PRIMARY KEY, company_id integer NOT NULL, name text NOT NULL,
  coa_id integer, account_type text, account_number text
);
CREATE TABLE public.bank_sheet_configs (
  id integer PRIMARY KEY, company_id integer NOT NULL, bank_account_number text
);
INSERT INTO public.company_bank_accounts VALUES
  (10,1,'Legacy CST',NULL,'bank','11-22'),
  (11,1,'Duplicate A',NULL,'bank','999'),
  (12,1,'Duplicate B',NULL,'bank','9-99'),
  (20,2,'Other company',NULL,'bank','1122');
INSERT INTO public.bank_sheet_configs VALUES
  (1,1,'1122'), (2,1,'999'), (3,2,'11-22');
""")
assert join_result(1) == "10", f"legacy unique number should resolve to account 10, got {join_result(1)}"
assert join_result(2) == "NULL", f"duplicate legacy numbers must fail closed, got {join_result(2)}"
assert join_result(3) == "20", f"legacy number must resolve within company 2, got {join_result(3)}"

# Migrated schema: explicit IDs are authoritative even when number is NULL
# or duplicated. A broken non-NULL ID must not fall back to bank_account_number.
psql("""
DROP TABLE public.bank_sheet_configs CASCADE;
DROP TABLE public.company_bank_accounts CASCADE;
CREATE TABLE public.company_bank_accounts (
  id integer PRIMARY KEY, company_id integer NOT NULL, name text NOT NULL,
  coa_id integer, account_type text, account_number text
);
CREATE TABLE public.bank_sheet_configs (
  id integer PRIMARY KEY, company_id integer NOT NULL,
  bank_account_id integer, bank_account_number text
);
INSERT INTO public.company_bank_accounts VALUES
  (300,1,'Null number bound',NULL,'bank',NULL),
  (301,1,'Duplicate A',NULL,'bank','777'),
  (302,1,'Duplicate B',NULL,'bank','777'),
  (303,1,'Unique fallback',NULL,'bank','333');
INSERT INTO public.bank_sheet_configs VALUES
  (1,1,300,NULL),
  (2,1,999,'333'),
  (3,1,NULL,'333'),
  (4,1,301,'777');
""")
assert join_result(1) == "300", f"explicit ID with NULL number must be preserved, got {join_result(1)}"
assert join_result(2) == "NULL", f"broken explicit ID must not silently fall back, got {join_result(2)}"
assert join_result(3) == "303", f"NULL explicit ID should use unique number, got {join_result(3)}"
assert join_result(4) == "301", f"explicit ID should win despite duplicate numbers, got {join_result(4)}"

print("PASS: legacy schema unique/duplicate/company-scoped matching")
print("PASS: migrated schema preserves explicit IDs including NULL/duplicate numbers")
print("PASS: broken explicit IDs fail closed and never fall back")
