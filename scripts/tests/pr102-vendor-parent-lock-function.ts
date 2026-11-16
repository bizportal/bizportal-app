/* Disposable-only prototype. NOT an authorized CST-DEV migration. */
export const vendorParentLockFunctionSql = String.raw`CREATE FUNCTION finance_ops_private.mkt_finance_lock_vendor_invoice_parents_dev(
      p_po_id integer,p_gr_id integer,p_supplier_id integer,p_vendor_token text)
    RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $func$
    DECLARE v_scope text; v_company integer;
    BEGIN
      v_scope := pg_catalog.current_setting('app.marketplace_company_id',true);
      IF v_scope IS NULL OR v_scope !~ '^[1-9][0-9]{0,8}$' THEN RETURN FALSE; END IF;
      v_company := v_scope::integer;
      IF p_po_id IS NULL OR p_po_id <= 0 OR p_gr_id IS NULL OR p_gr_id <= 0
         OR p_supplier_id IS NULL OR p_supplier_id <= 0 OR p_vendor_token IS NULL
         OR p_vendor_token !~ '^[0-9a-fA-F]{64}$' THEN RETURN FALSE; END IF;
      PERFORM 1 FROM public.mkt_purchase_orders po
        WHERE po.id=p_po_id AND po.company_id=v_company AND po.vendor_id=p_supplier_id
          AND po.vendor_token=p_vendor_token
          AND (po.vendor_token_expires_at IS NULL OR po.vendor_token_expires_at > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC'))
        FOR UPDATE OF po;
      IF NOT FOUND THEN RETURN FALSE; END IF;
      PERFORM 1 FROM public.mkt_po_goods_receipts gr
        INNER JOIN public.mkt_po_shipments sh ON sh.id=gr.shipment_id
        WHERE gr.id=p_gr_id AND sh.po_id=p_po_id
        FOR UPDATE OF gr;
      IF NOT FOUND THEN RETURN FALSE; END IF;
      RETURN TRUE;
    END;
    $func$`;
