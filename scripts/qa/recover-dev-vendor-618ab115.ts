/** One observed failed QA run only. Concatenated with the hash-pinned harness by
 * build-dev-vendor-recovery-618ab115.cjs; never creates or exercises invoices. */
const recoveryFixtures = [
  { companyId: 1, supplierId: 41, rfqId: 27, quoteId: 22, poId: 16,
    lineIds: [17, 18], shipmentId: 10, grId: 7, invoiceId: 13, apId: 3,
    paymentRequestId: 3, handoffId: 3, invoiceLineIds: [53, 54],
    shipmentItemIds: [9, 10], receiptItemIds: [7, 8], auditIds: [826, 827, 828, 829, 830, 831],
    objectPath: "/objects/uploads/40195108-1b1f-4f43-8a1a-b8a03fecd2e0.pdf" },
  { companyId: 3, supplierId: 42, rfqId: 28, quoteId: 23, poId: 17,
    lineIds: [19, 20], shipmentId: 11, grId: 8, invoiceId: 14, apId: 4,
    paymentRequestId: 4, handoffId: 4, invoiceLineIds: [55, 56],
    shipmentItemIds: [11, 12], receiptItemIds: [9, 10], auditIds: [832, 833, 834, 835, 836, 837],
    objectPath: "/objects/uploads/339ceecb-8d52-452d-bcc6-0a246ef5bc7a.pdf" },
] as const;
const recoveryOwnedIds: Record<string, number[]> = {
  suppliers: [41, 42], mkt_rfqs: [27, 28], mkt_vendor_quotes: [22, 23],
  mkt_purchase_orders: [16, 17], mkt_purchase_order_lines: [17, 18, 19, 20],
  mkt_po_shipments: [10, 11], mkt_po_shipment_items: [9, 10, 11, 12],
  mkt_po_goods_receipts: [7, 8], mkt_po_goods_receipt_items: [7, 8, 9, 10],
  vendor_invoices: [13, 14], vendor_invoice_lines: [53, 54, 55, 56],
  mkt_ap_preparations: [3, 4], payment_requests: [3, 4], mkt_accounting_handoffs: [3, 4],
};
const recoveryAuditIds = recoveryFixtures.flatMap(f => [...f.auditIds]);
function recoveryIdentifier(value: string) { return '"' + value.replaceAll('"', '""') + '"'; }
async function recoveryExactIds(table: string, column: string, value: number, expected: readonly number[]) {
  const result = await admin!.query(`select id from public.${recoveryIdentifier(table)}
    where ${recoveryIdentifier(column)}=$1::integer order by id`, [value]);
  requireThat(JSON.stringify(result.rows.map(row => row.id)) === JSON.stringify(expected), "RECOVERY_EXACT_RELATED_IDS");
}
async function verifyRecoveryGraph() {
  for (const f of recoveryFixtures) {
    const reference = `${marker}-${f.companyId}`;
    const parent = (await admin!.query(`select
      (select count(*)::int from public.suppliers where id=$1::integer and name=$2::text and company_id=$3::integer) supplier,
      (select count(*)::int from public.mkt_rfqs where id=$4::integer and rfq_number=$2::text and company_id=$3::integer and notes=$5::text) rfq,
      (select count(*)::int from public.mkt_vendor_quotes where id=$6::integer and rfq_id=$4::integer and vendor_id=$1::integer and notes=$5::text) quote,
      (select count(*)::int from public.mkt_purchase_orders where id=$7::integer and po_number=$2::text and company_id=$3::integer
        and vendor_id=$1::integer and rfq_id=$4::integer and quote_id=$6::integer and created_by=$5::text) po,
      (select count(*)::int from public.mkt_po_shipments where id=$8::integer and po_id=$7::integer and shipment_number=$2::text and notes=$5::text) shipment,
      (select count(*)::int from public.mkt_po_goods_receipts where id=$9::integer and shipment_id=$8::integer and receipt_number=$2::text and notes=$5::text) receipt,
      (select count(*)::int from public.vendor_invoices where id=$10::integer and mkt_purchase_order_id=$7::integer
        and mkt_goods_receipt_id=$9::integer and vendor_invoice_ref=$2::text and attachment_object_path=$11::text) invoice,
      (select count(*)::int from storage.objects where bucket_id='private-uploads' and name=$12::text) private_object`,
    [f.supplierId, reference, f.companyId, f.rfqId, marker, f.quoteId, f.poId,
      f.shipmentId, f.grId, f.invoiceId, f.objectPath, f.objectPath.slice("/objects/".length)])).rows[0];
    requireThat(Object.values(parent).every(value => value === 1), "RECOVERY_EXACT_MARKER_GRAPH");
    for (const [table, column, value, ids] of [
      ["mkt_purchase_order_lines", "po_id", f.poId, f.lineIds],
      ["mkt_po_shipments", "po_id", f.poId, [f.shipmentId]],
      ["mkt_po_shipment_items", "shipment_id", f.shipmentId, f.shipmentItemIds],
      ["mkt_po_goods_receipts", "shipment_id", f.shipmentId, [f.grId]],
      ["mkt_po_goods_receipt_items", "goods_receipt_id", f.grId, f.receiptItemIds],
      ["vendor_invoices", "mkt_purchase_order_id", f.poId, [f.invoiceId]],
      ["vendor_invoice_lines", "invoice_id", f.invoiceId, f.invoiceLineIds],
      ["mkt_ap_preparations", "mkt_purchase_order_id", f.poId, [f.apId]],
      ["payment_requests", "mkt_ap_preparation_id", f.apId, [f.paymentRequestId]],
      ["mkt_accounting_handoffs", "mkt_purchase_order_id", f.poId, [f.handoffId]],
      ["activity_logs", "mkt_purchase_order_id", f.poId, f.auditIds],
    ] as const) await recoveryExactIds(table, column, value, ids);
  }
  // Refuse unexpected FK dependents, including rows that a CASCADE/SET NULL
  // could otherwise change. The observed twelve activity rows are retained.
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
    if (allowed) {
      values.push(allowed); predicate += ` and id<>all($${values.length}::integer[])`;
    }
    return `select count(*)::integer n from ${recoveryIdentifier(ref.child_schema)}.${recoveryIdentifier(ref.child_table)} where ${predicate}`;
  });
  requireThat(clauses.length > 0, "RECOVERY_FK_METADATA_MISSING");
  const unexpected = (await admin!.query(clauses.join(" union all "), values)).rows;
  requireThat(unexpected.every(row => row.n === 0), "RECOVERY_UNEXPECTED_DEPENDENT");
  passed("EXACT_FAILED_RUN_GRAPH_AND_NO_UNEXPECTED_DEPENDENTS");
}
async function main() {
  requireThat(mode === "--check" || mode === "--recover-reviewed", "RECOVERY_MODE");
  requireThat(mode !== "--recover-reviewed" ||
    process.env.BIZPORTAL_VENDOR_ACCEPTANCE_RECOVER_DEV === marker, "RECOVERY_EXPLICIT_MARKER_REQUIRED");
  await preflight();
  await verifyRecoveryGraph();
  if (mode === "--check") { passed("RECOVERY_READ_ONLY_CHECK_COMPLETE"); return; }
  for (const f of recoveryFixtures) fixtures.push({ ...f, lineIds: [...f.lineIds],
    reference: `${marker}-${f.companyId}`, token: "" }); // No token lookup or vendor HTTP.
  seeded = true;
  await cleanup(); // Original unpaid/unposted/ownership guards remain unchanged.
  for (const [table, ids] of Object.entries(recoveryOwnedIds)) {
    const result = await admin!.query(`select count(*)::integer n from public.${recoveryIdentifier(table)} where id=any($1::integer[])`, [ids]);
    requireThat(result.rows[0].n === 0, "RECOVERY_OWNED_ROW_REMAINS");
  }
  const audit = (await admin!.query(`select count(*)::integer n from public.activity_logs
    where id=any($1::integer[]) and mkt_purchase_order_id is null`, [recoveryAuditIds])).rows[0];
  requireThat(audit.n === 12, "RECOVERY_AUDIT_NOT_RETAINED");
  passed("REVIEWED_FAILED_RUN_RECOVERY_COMPLETE", { marker, auditRowsRetained: audit.n });
}
