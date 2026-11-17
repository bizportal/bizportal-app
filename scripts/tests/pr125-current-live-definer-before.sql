-- Test-only snapshot of current CST-DEV private function, no credentials or rows.
CREATE OR REPLACE FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
    p_po_id integer,p_gr_id integer,p_supplier_id integer,p_vendor_token text
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $pr125_body$
DECLARE v_company integer;
BEGIN
  -- This is the authenticated DB login, not the SECURITY DEFINER owner.
  -- A caller can change an ordinary GUC, but cannot forge session_user.
  v_company := (CASE WHEN session_user='bizportal_finance_cst_login_dev' THEN 1 WHEN session_user='bizportal_finance_diva_login_dev' THEN 3 ELSE NULL END);
  IF v_company IS NULL
    OR p_po_id IS NULL OR p_po_id<=0
    OR p_gr_id IS NULL OR p_gr_id<=0
    OR p_supplier_id IS NULL OR p_supplier_id<=0
    OR p_vendor_token IS NULL OR p_vendor_token !~ '^[0-9a-fA-F]{64}$'
  THEN RETURN FALSE; END IF;

  -- The row locks are held until the outer canonical Invoice transaction
  -- commits/rolls back. Fixed PO -> Goods Receipt -> Shipment order.
  PERFORM 1 FROM public.mkt_purchase_orders po
    WHERE po.id=p_po_id AND po.company_id=v_company
      AND po.vendor_id=p_supplier_id
      AND po.vendor_token=p_vendor_token
      AND (po.vendor_token_expires_at IS NULL OR
           po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'))
    FOR UPDATE OF po;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.mkt_po_goods_receipts gr
    INNER JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id
    WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
    FOR UPDATE OF gr;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  PERFORM 1 FROM public.mkt_po_shipments sh
    INNER JOIN public.mkt_po_goods_receipts gr ON gr.shipment_id=sh.id
    WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
    FOR UPDATE OF sh;
  IF NOT FOUND THEN RETURN FALSE; END IF;

  -- Waiting for a PO, GR or Shipment lock can outlast a token that was valid
  -- when the first SELECT started. Revalidate with wall-clock time AFTER all
  -- locks are held; the caller must not create an invoice with an expired token.
  PERFORM 1 FROM public.mkt_purchase_orders po
    WHERE po.id=p_po_id AND po.company_id=v_company
      AND po.vendor_id=p_supplier_id AND po.vendor_token=p_vendor_token
      AND (po.vendor_token_expires_at IS NULL OR
           po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'));
  RETURN FOUND;
END
$pr125_body$;
