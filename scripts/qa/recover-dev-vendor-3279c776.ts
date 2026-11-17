/** One observed failed QA run only. Build with the hash-pinned diagnostics
 * harness. Never seeds data, issues invoices, calls a vendor URL, or reads tokens. */
import { createHash as recoveryHash } from "node:crypto";

const recoveryFixtures = [
  { companyId: 1, supplierId: 43, rfqId: 29, quoteId: 24, poId: 18,
    lineIds: [21, 22], shipmentId: 12, grId: 9, invoiceId: 15,
    invoiceLineIds: [57, 58], shipmentItemIds: [13, 14], receiptItemIds: [11, 12],
    auditIds: [838, 839, 840],
    objectPath: "/objects/uploads/31875481-346c-40b4-a0f4-c7c9a75830c1.pdf" },
  { companyId: 3, supplierId: 44, rfqId: 30, quoteId: 25, poId: 19,
    lineIds: [23, 24], shipmentId: 13, grId: 10, invoiceId: undefined,
    invoiceLineIds: [], shipmentItemIds: [15, 16], receiptItemIds: [13, 14],
    auditIds: [], objectPath: undefined },
] as const;
type RecoveryFixture = typeof recoveryFixtures[number];
const recoveryAuditProof = [
  { id: 838, action: "invoice_uploaded", fingerprint: "c2a91d6f5102cf6147ed8a9fcd4aa836" },
  { id: 839, action: "invoice_ready_for_ap", fingerprint: "a6ae72b4f6487ee91a232828c57a0f85" },
  { id: 840, action: "three_way_match_passed", fingerprint: "347ae00dccc46bdfa1ccbd141b57c0f5" },
] as const;
const recoveryAuditIds = recoveryAuditProof.map(row => row.id);
const recoveryProtectedPo14 = { ap: 0, po: "e6631668d167084db5de3748e7f7b5ff", handoffs: 0, invoices: 0 };
const recoveryPdfBytes = 662;
const recoveryPdfSha256 = "6fba2f69511f672298ce91ea4a2c2b3eb2221255d345e2e2d6d4bd6450577540";
function recoveryIdentifier(value: string) { return '"' + value.replaceAll('"', '""') + '"'; }
function recoveryIdsFor(f: RecoveryFixture): Record<string, readonly number[]> {
  return {
    suppliers: [f.supplierId], mkt_rfqs: [f.rfqId], mkt_vendor_quotes: [f.quoteId],
    mkt_purchase_orders: [f.poId], mkt_purchase_order_lines: f.lineIds,
    mkt_po_shipments: [f.shipmentId], mkt_po_shipment_items: f.shipmentItemIds,
    mkt_po_goods_receipts: [f.grId], mkt_po_goods_receipt_items: f.receiptItemIds,
    vendor_invoices: f.invoiceId === undefined ? [] : [f.invoiceId],
    vendor_invoice_lines: f.invoiceLineIds,
    mkt_ap_preparations: [], payment_requests: [], mkt_accounting_handoffs: [],
  };
}
const recoveryOwnedIds: Record<string, number[]> = {};
for (const f of recoveryFixtures) for (const [table, ids] of Object.entries(recoveryIdsFor(f))) {
  (recoveryOwnedIds[table] ??= []).push(...ids);
}
async function recoveryExactIds(table: string, column: string, value: number, expected: readonly number[]) {
  const result = await admin!.query(`select id from public.${recoveryIdentifier(table)}
    where ${recoveryIdentifier(column)}=$1::integer order by id`, [value]);
  requireThat(JSON.stringify(result.rows.map(row => row.id)) === JSON.stringify(expected), "RECOVERY_EXACT_RELATED_IDS");
}
async function recoveryAuditUnchanged(detached: boolean) {
  const actual = (await admin!.query(`select id,action,mkt_purchase_order_id,
    md5((to_jsonb(a)-'mkt_purchase_order_id')::text) fingerprint
    from public.activity_logs a where id=any($1::integer[]) order by id`, [recoveryAuditIds])).rows;
  requireThat(actual.length === recoveryAuditProof.length && actual.every((row, index) => {
    const expected = recoveryAuditProof[index];
    return row.id === expected.id && row.action === expected.action && row.fingerprint === expected.fingerprint
      && row.mkt_purchase_order_id === (detached ? null : 18);
  }), "RECOVERY_AUDIT_CONTENT_OR_REFERENCE_CHANGED");
}
async function recoveryProtectedPoUnchanged() {
  const actual = await po14Fingerprint() as Record<string, unknown>;
  requireThat(Object.entries(recoveryProtectedPo14).every(([key, value]) => actual[key] === value), "RECOVERY_PROTECTED_PO14_DRIFT");
}
async function verifyRecoveryGraph(companyId?: number, lockOwnedParents = false) {
  for (const f of recoveryFixtures.filter(row => companyId === undefined || row.companyId === companyId)) {
    stage = `company_${f.companyId}_recovery_exact_graph`;
    // The build-only helper calls this again inside the original cleanup
    // transaction, after its PO/invoice/AP locks and before any deletion.
    // Lock all reviewed parents so a new FK dependent cannot appear between
    // the catalog check and the original cleanup's DELETE statements.
    if (lockOwnedParents) {
      for (const [table, ids] of Object.entries(recoveryIdsFor(f))) {
        if (ids.length === 0) continue;
        const locked = await admin!.query(`select id from public.${recoveryIdentifier(table)}
          where id=any($1::integer[]) order by id for update`, [ids]);
        requireThat(JSON.stringify(locked.rows.map(row => row.id)) === JSON.stringify(ids), "RECOVERY_OWNED_PARENT_CHANGED");
      }
      if (f.auditIds.length) await admin!.query("select id from public.activity_logs where id=any($1::integer[]) order by id for update", [f.auditIds]);
    }
    const reference = `${marker}-${f.companyId}`;
    const parent = (await admin!.query(`select
      (select count(*)::int from public.suppliers where id=$1::integer and name=$2::text and company_id=$3::integer) supplier,
      (select count(*)::int from public.mkt_rfqs where id=$4::integer and rfq_number=$2::text and company_id=$3::integer and notes=$5::text) rfq,
      (select count(*)::int from public.mkt_vendor_quotes where id=$6::integer and rfq_id=$4::integer and vendor_id=$1::integer and notes=$5::text) quote,
      (select count(*)::int from public.mkt_purchase_orders where id=$7::integer and po_number=$2::text and company_id=$3::integer
        and vendor_id=$1::integer and rfq_id=$4::integer and quote_id=$6::integer and created_by=$5::text) po,
      (select count(*)::int from public.mkt_po_shipments where id=$8::integer and po_id=$7::integer and shipment_number=$2::text and notes=$5::text) shipment,
      (select count(*)::int from public.mkt_po_goods_receipts where id=$9::integer and shipment_id=$8::integer and receipt_number=$2::text and notes=$5::text) receipt`,
    [f.supplierId, reference, f.companyId, f.rfqId, marker, f.quoteId, f.poId, f.shipmentId, f.grId])).rows[0];
    requireThat(Object.values(parent).every(value => value === 1), "RECOVERY_EXACT_MARKER_GRAPH");
    for (const [table, column, value, ids] of [
      ["mkt_purchase_order_lines", "po_id", f.poId, f.lineIds],
      ["mkt_po_shipments", "po_id", f.poId, [f.shipmentId]],
      ["mkt_po_shipment_items", "shipment_id", f.shipmentId, f.shipmentItemIds],
      ["mkt_po_goods_receipts", "shipment_id", f.shipmentId, [f.grId]],
      ["mkt_po_goods_receipt_items", "goods_receipt_id", f.grId, f.receiptItemIds],
      ["vendor_invoices", "mkt_purchase_order_id", f.poId, f.invoiceId === undefined ? [] : [f.invoiceId]],
      ["vendor_invoices", "supplier_id", f.supplierId, f.invoiceId === undefined ? [] : [f.invoiceId]],
      ["mkt_ap_preparations", "mkt_purchase_order_id", f.poId, []],
      ["mkt_ap_preparations", "supplier_id", f.supplierId, []],
      ["payment_requests", "supplier_id", f.supplierId, []],
      ["mkt_accounting_handoffs", "mkt_purchase_order_id", f.poId, []],
      ["mkt_accounting_handoffs", "supplier_id", f.supplierId, []],
      ["activity_logs", "mkt_purchase_order_id", f.poId, f.auditIds],
      ["mkt_notification_queue", "purchase_order_id", f.poId, []],
    ] as const) await recoveryExactIds(table, column, value, ids);
    if (f.invoiceId !== undefined) {
      await recoveryExactIds("vendor_invoice_lines", "invoice_id", f.invoiceId, f.invoiceLineIds);
      const invoice = (await admin!.query(`select count(*)::integer n from public.vendor_invoices
        where id=$1 and company_id=$2 and supplier_id=$3 and mkt_purchase_order_id=$4
          and mkt_goods_receipt_id=$5 and vendor_invoice_ref=$6 and notes=$7
          and status::text='ready_for_ap' and three_way_match_status='passed'
          and amount_paid=0 and journal_entry_id is null
          and attachment_object_path=$8 and attachment_size=$9`,
      [f.invoiceId, f.companyId, f.supplierId, f.poId, f.grId, reference, marker, f.objectPath, recoveryPdfBytes])).rows[0];
      requireThat(invoice.n === 1, "RECOVERY_INVOICE_UNPAID_UNPOSTED_OR_ATTACHMENT_CHANGED");
      const object = (await admin!.query(`select count(*)::integer n from storage.objects o
        join storage.buckets b on b.id=o.bucket_id
        where b.id='private-uploads' and b.public=false and o.name=$1
          and (o.metadata->>'size')::integer=$2`,
      [f.objectPath!.slice("/objects/".length), recoveryPdfBytes])).rows[0];
      requireThat(object.n === 1, "RECOVERY_EXACT_PRIVATE_OBJECT_METADATA");
      const { ObjectStorageService } = await import("../../artifacts/api-server/src/lib/objectStorage");
      const storage = new ObjectStorageService();
      const handle = await storage.getObjectEntityFile(f.objectPath!);
      requireThat(handle.bucket === "private-uploads" && handle.path === f.objectPath!.slice("/objects/".length), "RECOVERY_PRIVATE_HANDLE_SCOPE");
      const bytes = Buffer.from(await (await storage.downloadObject(handle)).arrayBuffer());
      requireThat(bytes.length === recoveryPdfBytes &&
        recoveryHash("sha256").update(bytes).digest("hex") === recoveryPdfSha256 &&
        recoveryHash("sha256").update(invoicePdf(reference)).digest("hex") === recoveryPdfSha256,
      "RECOVERY_PRIVATE_PDF_CONTENT_CHANGED");
      await recoveryAuditUnchanged(false);
    }
  }
  // Refuse every unreviewed FK dependent, including CASCADE/SET NULL effects.
  // Only the three pinned activity rows may survive the original PO deletion.
  const references = (await admin!.query(`select cn.nspname child_schema,c.relname child_table,
      a.attname child_column,p.relname parent_table,pa.attname parent_column,
      cardinality(k.conkey) width
    from pg_constraint k join pg_class c on c.oid=k.conrelid
      join pg_namespace cn on cn.oid=c.relnamespace join pg_class p on p.oid=k.confrelid
      join pg_namespace pn on pn.oid=p.relnamespace
      join pg_attribute a on a.attrelid=c.oid and a.attnum=k.conkey[1]
      join pg_attribute pa on pa.attrelid=p.oid and pa.attnum=k.confkey[1]
    where k.contype='f' and pn.nspname='public' and p.relname=any($1::text[])`,
  [Object.keys(recoveryOwnedIds)])).rows;
  const values: unknown[] = [];
  const clauses = references.map(ref => {
    requireThat(ref.width === 1 && ref.parent_column === "id", "RECOVERY_UNKNOWN_FK_SHAPE");
    values.push(recoveryOwnedIds[ref.parent_table]);
    let predicate = `${recoveryIdentifier(ref.child_column)}=any($${values.length}::integer[])`;
    const allowed = ref.child_schema === "public"
      ? (ref.child_table === "activity_logs" ? recoveryAuditIds : recoveryOwnedIds[ref.child_table]) : undefined;
    if (allowed) { values.push(allowed); predicate += ` and id<>all($${values.length}::integer[])`; }
    return `select count(*)::integer n from ${recoveryIdentifier(ref.child_schema)}.${recoveryIdentifier(ref.child_table)} where ${predicate}`;
  });
  requireThat(clauses.length > 0, "RECOVERY_FK_METADATA_MISSING");
  const unexpected = (await admin!.query(clauses.join(" union all "), values)).rows;
  requireThat(unexpected.every(row => row.n === 0), "RECOVERY_UNEXPECTED_DEPENDENT");
  await recoveryProtectedPoUnchanged();
  passed("EXACT_3279_GRAPH_PRIVATE_PDF_AUDITS_AND_DEPENDENCIES_VERIFIED", { companyId: companyId ?? "both" });
}
async function main() {
  requireThat(mode === "--check" || mode === "--recover-reviewed", "RECOVERY_MODE");
  requireThat(mode !== "--recover-reviewed" ||
    process.env.BIZPORTAL_VENDOR_ACCEPTANCE_RECOVER_DEV === marker, "RECOVERY_EXPLICIT_MARKER_REQUIRED");
  await preflight();
  await recoveryProtectedPoUnchanged();
  await verifyRecoveryGraph();
  if (mode === "--check") { passed("RECOVERY_3279_READ_ONLY_CHECK_COMPLETE"); return; }
  for (const f of recoveryFixtures) fixtures.push({ ...f, lineIds: [...f.lineIds],
    reference: `${marker}-${f.companyId}`, token: "" }); // No vendor token lookup or HTTP exercise.
  seeded = true;
  await cleanup(); // Pinned original cleanup plus additional graph/path guards only.
  for (const [table, ids] of Object.entries(recoveryOwnedIds)) {
    const remaining = await admin!.query(`select count(*)::integer n from public.${recoveryIdentifier(table)} where id=any($1::integer[])`, [ids]);
    requireThat(remaining.rows[0].n === 0, "RECOVERY_OWNED_ROW_REMAINS");
  }
  const object = await admin!.query(`select count(*)::integer n from storage.objects
    where bucket_id='private-uploads' and name=$1`, [recoveryFixtures[0].objectPath.slice("/objects/".length)]);
  requireThat(object.rows[0].n === 0, "RECOVERY_PRIVATE_OBJECT_REMAINS");
  await recoveryAuditUnchanged(true);
  await recoveryProtectedPoUnchanged();
  passed("REVIEWED_3279_FAILED_RUN_RECOVERY_COMPLETE", { marker, auditRowsRetained: 3 });
}
