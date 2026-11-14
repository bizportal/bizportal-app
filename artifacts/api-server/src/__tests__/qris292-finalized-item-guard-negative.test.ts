import { describe, expect, it } from "vitest";
import pg from "pg";

const url = process.env.QRIS292_ISOLATED_PG_URL;

describe.skipIf(!url)("Issue #292 finalized settlement membership trigger rejects unauthorized changes", () => {
  it("guards BOTH UPDATE and DELETE on posted #5738, including a spoofed scoped GUC", async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.query("BEGIN");
    try {
      const trigger = await client.query<{
        trigger_name: string;
        update_event: boolean;
        delete_event: boolean;
      }>(`
        SELECT tgname AS trigger_name,
               (tgtype::integer & 16)<>0 AS update_event,
               (tgtype::integer & 8)<>0 AS delete_event
        FROM pg_trigger
        WHERE tgrelid='sport_center.payment_settlement_items'::regclass
          AND tgname='trg_guard_finalized_settlement_items'
          AND NOT tgisinternal
      `);
      expect(trigger.rows).toEqual([{
        trigger_name:"trg_guard_finalized_settlement_items",
        update_event:true,
        delete_event:true,
      }]);

      const attempts = [
        {
          name:"unauthorized_update",
          statement:"UPDATE sport_center.payment_settlement_items SET item_status='reversed' WHERE settlement_id=5738 AND payment_id=856",
        },
        {
          name:"unauthorized_delete",
          statement:"DELETE FROM sport_center.payment_settlement_items WHERE settlement_id=5738 AND payment_id=856",
        },
      ];
      for (const attempt of attempts) {
        await client.query(`SAVEPOINT ${attempt.name}`);
        await expect(client.query(attempt.statement))
          .rejects.toThrow("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
        await client.query(`ROLLBACK TO SAVEPOINT ${attempt.name}`);
      }

      // A caller-controlled custom session setting is NOT finance authorization.
      // Even the correct flag must not bypass the posted batch state,
      // since no posted balanced reversing journal exists.
      await client.query(`
        SELECT set_config('sport_center.allow_finalized_membership_reversal',
          'owner-audited-compensation-v1',true)
      `);
      await client.query("SAVEPOINT spoofed_flag");
      await expect(client.query(`
        UPDATE sport_center.payment_settlement_items
           SET item_status='reversed'
         WHERE settlement_id=5738 AND payment_id=856
      `)).rejects.toThrow("FINALIZED_SETTLEMENT_ITEMS_ARE_IMMUTABLE");
      await client.query("ROLLBACK TO SAVEPOINT spoofed_flag");

      const state=await client.query<{
        batch_status:string;
        active_items:number;
        reversed_items:number;
        reversal_journals:number;
      }>(`
        SELECT (SELECT status FROM sport_center.payment_settlement_batches WHERE id=5738) AS batch_status,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
            WHERE settlement_id=5738 AND item_status='active') AS active_items,
          (SELECT count(*)::int FROM sport_center.payment_settlement_items
            WHERE settlement_id=5738 AND item_status='reversed') AS reversed_items,
          (SELECT count(*)::int FROM sport_center.accounting_journals
            WHERE reversal_of_id=7207) AS reversal_journals
      `);
      expect(state.rows[0]).toEqual({
        batch_status:"posted",active_items:4,reversed_items:0,reversal_journals:0,
      });
    } finally {
      await client.query("ROLLBACK").catch(()=>undefined);
      await client.end();
    }
  });
});
