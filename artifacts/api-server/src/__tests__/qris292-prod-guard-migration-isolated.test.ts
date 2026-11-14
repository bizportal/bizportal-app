import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { reverseCanonicalSettlementForCorrection } from "../lib/reconciliation/canonicalSettlementCorrection";

const connectionString=process.env.QRIS292_ISOLATED_PG_URL;
const dialect=new PgDialect();
const input={
  settlementId:5738,
  expectedBankMutationId:434464,
  replacementPaymentIds:[859,860,861,862],
  actor:"isolated-migration-audit",
  reason:"Reproduce strict PROD guard rejection then test narrow migration in disposable PostgreSQL",
};

// Equivalent strict pre-migration PROD logic inspected via SELECT pg_get_functiondef.
// The actual production definition is NOT installed or modified by this test.
const oldStrictGuard=`
CREATE OR REPLACE FUNCTION sport_center.guard_finalized_settlement_items()
RETURNS trigger LANGUAGE plpgsql
SET search_path TO 'pg_catalog','sport_center'
AS $$
DECLARE v_status text; v_id bigint;
BEGIN
 v_id:=CASE WHEN TG_OP='DELETE' THEN OLD.settlement_id ELSE NEW.settlement_id END;
 SELECT status INTO v_status FROM sport_center.payment_settlement_batches WHERE id=v_id;
 IF v_status IN ('posted','reconciled','reversed') THEN
   RAISE EXCEPTION 'FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE: settlement=% status=%',v_id,v_status;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
`;

describe.skipIf(!connectionString)("Issue #292 legacy PROD guard migration readiness (disposable database)",()=>{
  it("reproduces legacy rejection, then accepts only audited compensation after migration; rolls everything back",async()=>{
    const c=new pg.Client({connectionString});
    await c.connect();
    await c.query("BEGIN");
    const transaction={
      execute:async(statement:any)=>{
        const q=dialect.sqlToQuery(statement);
        return c.query(q.sql,q.params);
      },
    };
    const adapter={transaction:async(callback:any)=>callback(transaction)} as any;
    try{
      const before=await c.query<{hash:string}>(`
        SELECT md5(pg_get_functiondef('sport_center.guard_finalized_settlement_items()'::regprocedure)) AS hash
      `);
      await c.query(oldStrictGuard);
      await c.query("SAVEPOINT strict_reversal");
      await expect(reverseCanonicalSettlementForCorrection(adapter,input))
        .rejects.toThrow("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
      await c.query("ROLLBACK TO SAVEPOINT strict_reversal");
      const stillOriginal=await c.query<{status:string;reversals:number}>(`
        SELECT status,(SELECT count(*)::int FROM sport_center.accounting_journals
          WHERE reversal_of_id=7207) AS reversals
        FROM sport_center.payment_settlement_batches WHERE id=5738
      `);
      expect(stillOriginal.rows[0]).toEqual({status:"posted",reversals:0});

      const migration=readFileSync(fileURLToPath(new URL(
        "../../../../scripts/sql/20261113_guarded_finalized_settlement_membership_compensation.sql",
        import.meta.url,
      )),"utf8");
      expect(migration).toContain("CREATE OR REPLACE FUNCTION sport_center.guard_finalized_settlement_items()");
      expect(migration).not.toMatch(/DROP TRIGGER|DISABLE TRIGGER|ALTER TABLE|GRANT\s|REVOKE\s/i);
      await c.query(migration);
      const result=await reverseCanonicalSettlementForCorrection(adapter,input);
      expect(result).toMatchObject({ok:true,settlementId:5738,settlementStatus:"reversed"});
      const after=await c.query<{status:string;old_reversed:number;reversal_count:number}>(`
        SELECT b.status,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
            WHERE settlement_id=5738 AND item_status='reversed') AS old_reversed,
          (SELECT count(*)::int FROM sport_center.accounting_journals
            WHERE reversal_of_id=7207 AND status='posted') AS reversal_count
        FROM sport_center.payment_settlement_batches b WHERE id=5738
      `);
      expect(after.rows[0]).toEqual({status:"reversed",old_reversed:4,reversal_count:1});
      // The migration does not allow removal of audit history or arbitrary edits.
      await c.query("SAVEPOINT unauthorized_delete");
      await expect(c.query(`DELETE FROM sport_center.payment_settlement_items
        WHERE settlement_id=5738 AND payment_id=856`))
        .rejects.toThrow("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
      await c.query("ROLLBACK TO SAVEPOINT unauthorized_delete");

      // The migration is for ONE historical correction, not a global bypass.
      // Construct a separate synthetic reversed settlement with its own
      // balanced posted compensation, then prove its membership is immutable
      // even if the caller supplies the same custom correction session flag.
      await c.query(`
        INSERT INTO sport_center.payment_settlement_batches
          (id,company_id,status,settlement_journal_id,settlement_date,
           provider_code,bank_account_id,gross_amount,mdr_amount,net_amount)
        VALUES(5741,1,'calculated',7210,'2026-11-06',
          'mandiri_direct','1640006707220',10000,0,10000);
        INSERT INTO sport_center.payment_settlement_items
          (settlement_id,payment_id,item_status,gross_amount)
        VALUES(5741,99990,'active',10000);
        INSERT INTO sport_center.accounting_journals
          (id,journal_type,status,is_reversal,settlement_batch_id,
           reversal_of_id,debit_amount,credit_revenue_amount)
        VALUES
          (7210,'settlement','posted',false,5741,NULL,10000,10000),
          (7211,'settlement','posted',true,5741,7210,10000,10000);
        INSERT INTO sport_center.accounting_journal_lines
          (journal_id,line_type,account_code,account_name,amount)
        VALUES
          (7211,'debit','1-1024-CST','Clearing',10000),
          (7211,'credit','1-1023-CST','Bank',10000);
        UPDATE sport_center.payment_settlement_batches
           SET status='reversed' WHERE id=5741;
      `);
      await c.query("SAVEPOINT unrelated_batch");
      await expect(c.query(`
        UPDATE sport_center.payment_settlement_items
           SET item_status='reversed'
         WHERE settlement_id=5741 AND payment_id=99990
      `)).rejects.toThrow("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
      await c.query("ROLLBACK TO SAVEPOINT unrelated_batch");
      await c.query("ROLLBACK");
      const verify=await c.query<{hash:string;status:string;reversals:number;active:number}>(`
        SELECT md5(pg_get_functiondef('sport_center.guard_finalized_settlement_items()'::regprocedure)) AS hash,
          (SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738) AS status,
          (SELECT count(*)::int FROM sport_center.accounting_journals
            WHERE reversal_of_id=7207) AS reversals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
            WHERE settlement_id=5738 AND item_status='active') AS active
      `);
      expect(verify.rows[0]).toEqual({
        hash:before.rows[0].hash,status:"posted",reversals:0,active:4,
      });
    }finally{
      await c.query("ROLLBACK").catch(()=>undefined);
      await c.end();
    }
  });
});
