import { describe, expect, it } from "vitest";
import pg from "pg";
import { PgDialect } from "drizzle-orm/pg-core";
import { runAtomicCanonicalSettlementCorrection, rebuildIssue292WithOwnerFunctions } from "../lib/reconciliation/canonicalSettlementCorrectionCoordinator";
import { approveCanonicalSettlementLink } from "../routes/bank-reconciliation";

const url = process.env.QRIS292_ISOLATED_PG_URL;
const dialect = new PgDialect();

describe.skipIf(!url)("Issue #292 must atomically rollback a failed second bank approval", () => {
  it("does not retain first approval, reversal, replacement journals or audit when the second bank approval fails", async () => {
    const client = new pg.Client({connectionString:url});
    await client.connect();
    // Seed only in a transaction that can never be committed by this test.
    await client.query("BEGIN");
    try {
      await client.query(`
        INSERT INTO sport_center.sport_payments
          (id, company_id, amount, status, settlement_status, payment_method,
           payment_provider, bank_account_id, paid_at, expected_settlement_date,
           settlement_rule_version, mdr_amount)
        VALUES
          (834,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 11:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (843,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 12:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (853,1,30000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 13:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',0),
          (858,1,300000,'confirmed','unsettled','qris','mandiri_direct',
           '1640006707220','2026-11-03 14:00+07','2026-11-04','PROD-MANDIRI-SC-20260831-v1',2100);
        UPDATE sport_center.sport_payments
           SET settlement_status='unsettled'
         WHERE id=862;
        INSERT INTO sport_center.accounting_journals
          (payment_id,company_id,journal_type,status,is_reversal,
           gross_amount,debit_amount,credit_revenue_amount,credit_ppn_amount)
        SELECT p.id,1,'payment_confirmed','posted',false,
               p.amount,p.amount,p.amount,0
        FROM sport_center.sport_payments p
        WHERE p.id IN (834,843,853,856,858,859,860,861,862);
        INSERT INTO public.bank_mutations
          (id,status,company_id,amount,transaction_date,source_classification,
           direction,bank_account_id,reconciliation_status)
        VALUES (434462,'unmatched',1,685800,'2026-11-04',
                'actual_bank_mutation','IN','17','unmatched');
      `);

      let rolledBack = false;
      const tx = {
        execute: async (statement: any) => {
          const q=dialect.sqlToQuery(statement);
          return client.query(q.sql,q.params);
        },
      };
      // Unlike the positive test, this wrapper models the real outer
      // transaction boundary: a failure *must* trigger the catch/ROLLBACK.
      // All fixture seed and finance writes share this one connection.
      const db = {transaction: async (callback: any) => {
        try {
          const result=await callback(tx);
          // A successful path is a test failure, never commit financial fixture.
          throw new Error("UNEXPECTED_FINANCE_SUCCESS_NO_COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          rolledBack=true;
          throw error;
        }
      }} as any;
      let firstApproved=false;
      await expect(runAtomicCanonicalSettlementCorrection(db, {
        settlementId:5738,
        expectedBankMutationId:434464,
        replacementPaymentIds:[859,860,861,862],
        actor:"isolated-ci-only",
        reason:"Prove all-or-nothing correction under failed bank approval",
      }, {
        rebuildBothDatedBatches: (t,reversal) =>
          rebuildIssue292WithOwnerFunctions(t,reversal,"isolated-ci-only"),
        approveBothCanonicalBankMatches: async (_t,batches) => {
          const first = await approveCanonicalSettlementLink(
            client,434462,batches.nov4BatchId,null,
            {email:"isolated-ci-only",companyId:1},"issue292-failure-first",
          );
          expect(first).toMatchObject({ok:true,status:"approved"});
          firstApproved=true;
          // Equivalent to an unhandled failure at the second approval stage.
          // No second bank write and no COMMIT should be permitted.
          throw new Error("INJECTED_SECOND_BANK_APPROVAL_FAILURE");
        },
      })).rejects.toThrow("INJECTED_SECOND_BANK_APPROVAL_FAILURE");
      expect(firstApproved).toBe(true);
      expect(rolledBack).toBe(true);
    } finally {
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
    // Fresh connection independently verifies the original historical fixture
    // and that there are no partial financial or approval side effects.
    const inspect = new pg.Client({connectionString:url});
    await inspect.connect();
    try {
      const state=await inspect.query(`
        SELECT
          (SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738) AS original_status,
          (SELECT count(*)::int FROM sport_center.payment_settlement_batches WHERE id<>5738) AS replacements,
          (SELECT count(*)::int FROM sport_center.accounting_journals WHERE reversal_of_id=7207) AS reversals,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
            WHERE settlement_id=5738 AND item_status='active') AS active_original_members,
          (SELECT count(*)::int FROM public.bank_reconciliation_matches
            WHERE mutation_id IN (434462,434464) AND status='approved') AS approvals,
          (SELECT status FROM public.bank_mutations WHERE id=434464) AS old_bank_status,
          (SELECT count(*)::int FROM public.bank_mutations WHERE id=434462) AS new_bank_rows,
          (SELECT count(*)::int FROM public.bank_reconciliation_audit
            WHERE action='CANONICAL_SETTLEMENT_MEMBERSHIP_CORRECTION_REVERSED') AS reversal_audits,
          (SELECT count(*)::int FROM sport_center.sport_payments
            WHERE id IN (834,843,853,858)) AS inserted_payments
      `);
      expect(state.rows[0]).toEqual({
        original_status:"posted",replacements:0,reversals:0,
        active_original_members:4,approvals:0,old_bank_status:"matched",
        new_bank_rows:0,reversal_audits:0,inserted_payments:0,
      });
    } finally {await inspect.end();}
  });
});
