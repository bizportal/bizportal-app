import { Router, type Request, type Response } from "express";
import { getProductionSession, getProductionUser, isSignedOtpDevEnabled } from "./dev-auth";
import { withFleetFinanceDevTransaction } from "@workspace/db/fleet-finance-dev";

/**
 * Actual owner-facing approval of DEV Company 3 rental-account mapping.
 * The signed OTP cookie is validated against the current users table on
 * EVERY request; no Fleet bearer service token, email claim or DEV picker
 * is accepted as approver authority.
 */
const router = Router();
const CODES = [
  ["1-1025-DV", "asset", "DEBIT"],
  ["1-1035-DV", "asset", "DEBIT"],
  ["4-1026-DV", "revenue", "CREDIT"],
  ["4-1027-DV", "revenue", "DEBIT"],
] as const;
const SCOPE = { sourceCompanyId: 1, companyId: 3 };
const enabled = () =>
  process.env.APP_ENV === "development" &&
  isSignedOtpDevEnabled() &&
  process.env.BIZPORTAL_FLEET_GOJEK_APPROVAL_ENABLED_DEV === "true";

async function currentApprover(req: Request): Promise<{ id: string; email: string } | null> {
  if (!isSignedOtpDevEnabled()) return null;
  const session = getProductionSession(req);
  if (!session) return null;
  const user = await getProductionUser(session);
  if (!user || user.role !== "super_admin" || !user.id || !user.email ||
      user.id !== session.id || user.email !== session.email) return null;
  return { id: String(user.id), email: user.email };
}

async function examine(client: any) {
  const rows = (await client.query(
    `SELECT id,code,name,type::text AS account_type,normal_balance,
            is_active,is_postable,is_header,status,approved_by,approved_at
       FROM public.chart_of_accounts
      WHERE company_id=$1 AND code=ANY($2::text[])
      ORDER BY code FOR UPDATE`,
    [3, CODES.map(c => c[0])],
  )).rows as Array<Record<string,unknown>>;
  const valid = rows.length === CODES.length && CODES.every(([code,type,balance]) => {
    const a = rows.find(r => r.code === code);
    return a && a.account_type === type && a.normal_balance === balance &&
      a.is_active === true && a.is_postable === true && a.is_header === false &&
      a.status === "ACTIVE";
  });
  const allApproved = valid && rows.every(row => Boolean(row.approved_by && row.approved_at));
  const noneApproved = valid && rows.every(row => !row.approved_by && !row.approved_at);
  return { valid, allApproved, noneApproved, rows };
}

router.get("/accounting/gojek-rental-approval", async (req:Request,res:Response):Promise<void> => {
  if (process.env.APP_ENV !== "development") {
    res.status(404).json({error:"Not found"});return;
  }
  try {
    const actor = await currentApprover(req);
    if (!actor) {res.status(403).json({error:"Diperlukan sesi OTP Super Admin yang sah."});return;}
    const result = await withFleetFinanceDevTransaction(SCOPE,async(client)=>{
      const info=await examine(client);
      return {
        sourceCompanyId:1,financeCompanyId:3,
        approvalEnabled:enabled(),coasValid:info.valid,
        approved:info.allApproved,
        partiallyApproved:!info.allApproved && !info.noneApproved,
        accounts:info.rows.map(row=>({
          code:row.code,name:row.name,normalBalance:row.normal_balance,
          approvedBy:row.approved_by,approvedAt:row.approved_at,
        })),
        canApprove:enabled() && info.noneApproved,
        postingEnabled:false,
        treatment:{
          deduction:"Dr Gojek clearing / Cr driver rental receivable; no bank cash assumed",
          rebate:"Proposed Dr contra revenue / Cr driver rental receivable; verify contract and any refund obligations",
          tax:"PPN and tax basis require document-specific Finance review; no automatic amount assumed",
        },
      };
    },{readOnly:true});
    res.setHeader("Cache-Control","private, no-store");
    res.json(result);
  }catch(error){
    req.log?.error({error},"Gojek rental approval preview failed");
    res.status(503).json({error:"Data persetujuan Finance DEV belum siap."});
  }
});

router.post("/accounting/gojek-rental-approval",async(req:Request,res:Response):Promise<void>=>{
  if (!enabled()) {res.status(404).json({error:"Persetujuan Gojek belum diaktifkan pada BizPortal DEV."});return;}
  // Require a same-origin browser submission: a cookie alone cannot approve.
  if (req.get("origin") !== "https://dev-bizportal.cstlogistic.co.id") {
    res.status(403).json({error:"Permintaan persetujuan harus berasal dari BizPortal DEV."});return;
  }
  if (req.body?.sourceCompanyId !== 1 || req.body?.financeCompanyId !== 3 ||
      req.body?.confirmRentalRevenue !== true ||
      req.body?.confirmDeductionClearing !== true ||
      req.body?.confirmRebateAndTaxReview !== true) {
    res.status(400).json({error:"Perusahaan dan tiga konfirmasi akuntansi wajib sesuai."});return;
  }
  try {
    const actor = await currentApprover(req);
    if (!actor) {res.status(403).json({error:"Hanya Super Admin dengan sesi OTP terverifikasi."});return;}
    const result = await withFleetFinanceDevTransaction(SCOPE,async(client)=>{
      const info = await examine(client);
      if (!info.valid) throw new Error("INVALID_COMPANY3_COA");
      if (info.allApproved) return {approved:true,idempotent:true,accounts:info.rows.length};
      if (!info.noneApproved) throw new Error("PARTIAL_APPROVAL_REQUIRES_REVIEW");
      // Only four validated Company 3 records; no journal or cash write.
      const updated = await client.query(
        `UPDATE public.chart_of_accounts
            SET approved_by=$1,approved_at=NOW(),updated_at=NOW()
          WHERE company_id=3 AND code=ANY($2::text[])
            AND approved_by IS NULL AND approved_at IS NULL
          RETURNING code,approved_by,approved_at`,
        [actor.email,CODES.map(c=>c[0])],
      );
      if (updated.rowCount !== CODES.length) throw new Error("APPROVAL_ATOMICITY_FAILED");
      return {approved:true,idempotent:false,accounts:updated.rowCount,approvedBy:actor.email};
    });
    res.setHeader("Cache-Control","private, no-store");
    res.status(result.idempotent ? 200 : 201).json({...result,postingEnabled:false});
  }catch(error){
    req.log?.error({error},"Gojek rental Super Admin approval failed");
    const conflict = error instanceof Error && /INVALID_COMPANY3_COA|PARTIAL_APPROVAL|APPROVAL_ATOMICITY/.test(error.message);
    res.status(conflict?409:503).json({error:conflict?"COA atau status persetujuan berubah. Periksa ulang.":"Persetujuan Finance belum berhasil disimpan."});
  }
});

export default router;
