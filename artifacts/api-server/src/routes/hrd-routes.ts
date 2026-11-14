import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { pool } from "@workspace/db";
import { getProductionSession, getProductionUser } from "./dev-auth";
import { authorizeHrdCompany } from "./hrd-access";
import { withHrdCompanyReadOnly } from "./hrd-readonly-db";
import { getEmployeeResignKasbonPrecheck } from "./hrd-resign-kasbon-precheck";
import { hrdStorageMetadataPreflightEnabled, probeHrdPrivateStorageMetadata } from "./hrd-storage-readiness";

type HrdReadRequest = Request & {
  hrdCompanyId?: number;
  hrdActor?: { role: string; email: string };
};

const router: IRouter = Router();
// The existing legacy HRD release is separate. This canonical first slice stays
// OFF in PROD until dedicated readiness and authenticated parity are proven.
function hrdReaderEnabled(): boolean {
  return process.env.APP_ENV?.trim().toLowerCase() === "production" &&
    process.env.HRD_CANONICAL_READONLY_ENABLED === "true";
}
// Exact owner identity from the verified legacy HRD access contract.
// A generic owner session does NOT grant document or HRD directory access.
const CST_HRD_OWNER_DB_USER_ID = "google_103728868378401731050";

router.use("/hrd", (req: HrdReadRequest, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store");
  if (!hrdReaderEnabled()) {
    res.status(404).json({ message: "Pembaca HRD belum diaktifkan." });
    return;
  }
  next();
});

router.use("/hrd", async (req: HrdReadRequest, res: Response, next: NextFunction) => {
  try {
    const session = getProductionSession(req);
    if (!session) {
      res.status(401).json({ message: "Sesi BizPortal diperlukan." });
      return;
    }
    const actor = await getProductionUser(session);
    if (!actor) {
      res.status(403).json({ message: "Akun HRD tidak berwenang." });
      return;
    }
    // The session lookup is not proof that an HRD account is still active.
    // Preserve the legacy database-level active user and designated owner gate.
    const active = await pool.query(
      `SELECT u.id::text AS db_user_id, u.company_id AS db_company_id,
        lower(btrim(u.role)) AS db_role
       FROM public.users u
       WHERE lower(coalesce(to_jsonb(u)->>'email','')) = $1
         AND coalesce((to_jsonb(u)->>'is_active')::boolean,false) IS TRUE
         AND lower(coalesce(to_jsonb(u)->>'status','active')) = 'active'
       LIMIT 1`,
      [actor.email.trim().toLowerCase()],
    );
    if (active.rowCount !== 1) {
      res.status(403).json({ message: "Akun HRD nonaktif atau tidak terverifikasi." });
      return;
    }
    const identity = active.rows[0] as {
      db_user_id: string; db_company_id: number | null; db_role: string;
    };
    const actorRole = actor.role.trim().toLowerCase();
    if (identity.db_role !== actorRole) {
      res.status(403).json({ message: "Role HRD belum terverifikasi." });
      return;
    }
    const cstOwnerHrdApproved =
      identity.db_user_id === CST_HRD_OWNER_DB_USER_ID &&
      Number(identity.db_company_id) === 1 &&
      identity.db_role === "owner" &&
      actorRole === "owner" &&
      actor.companyId === 1;
    const companyId = authorizeHrdCompany(
      { ...actor, cstOwnerHrdApproved }, req.query.companyId,
    );
    if (companyId === null) {
      res.status(403).json({ message: "Akses HRD perusahaan ini ditolak." });
      return;
    }
    req.hrdCompanyId = companyId;
    req.hrdActor = { role: actorRole, email: actor.email };
    next();
  } catch (error) {
    req.log?.error?.({ error }, "HRD read-only authentication unavailable");
    res.status(503).json({ message: "Otorisasi HRD tidak tersedia." });
  }
});

router.get("/hrd/readiness", async (req: HrdReadRequest, res: Response) => {
  const companyId = req.hrdCompanyId!;
  try {
    await withHrdCompanyReadOnly(companyId, async client => {
      await client.query(
        "SELECT id FROM public.employees WHERE company_id=$1 AND deleted_at IS NULL LIMIT 1",
        [companyId],
      );
    });
    res.json({ ready: true, companyId, readOnly: true, coverage: "HRD_DIRECTORY_STAGE1" });
  } catch (error) {
    req.log?.error?.({ error, companyId }, "HRD scoped readiness unavailable");
    res.status(503).json({ ready: false, message: "Pembaca direktori HRD belum siap." });
  }
});

/**
 * Metadata-only check of the existing private HRD bucket.
 * The HRD session/account/company middleware above always runs first.
 * Separate default-OFF flag ensures no storage credentials are used otherwise.
 */
router.get("/hrd/storage-readiness", async (req: HrdReadRequest, res: Response) => {
  if (!hrdStorageMetadataPreflightEnabled()) {
    res.status(404).json({ message: "Pemeriksaan storage HRD belum diaktifkan." });
    return;
  }
  const role = req.hrdActor?.role;
  if (role !== "owner" && role !== "super_admin") {
    res.status(403).json({ message: "Pemeriksaan storage hanya untuk Owner/Super Admin HRD." });
    return;
  }
  const ready = await probeHrdPrivateStorageMetadata();
  res.status(ready ? 200 : 503).json({
    ready, companyId:req.hrdCompanyId, storagePrivate:ready,
    readOnly:true, uploadEnabled:false, ocrEnabled:false,
    coverage:"HRD_STORAGE_METADATA_ONLY",
  });
});

router.get("/hrd/employees", async (req: HrdReadRequest, res: Response) => {
  const companyId = req.hrdCompanyId!;
  try {
    const employees = await withHrdCompanyReadOnly(companyId, async client => {
      const result = await client.query(
        `SELECT id, company_id, first_name, last_name, status, email, phone, position, hire_date
          FROM public.employees
          WHERE company_id=$1 AND deleted_at IS NULL
          ORDER BY first_name,last_name,id LIMIT 500`,
        [companyId],
      );
      return result.rows;
    });
    res.json({
      companyId, employees, readOnly: true, coverage: "HRD_DIRECTORY_STAGE1",
      statusChangeEnabled: false, documentUploadEnabled: false,
      ocrEnabled: false, canPay: false,
    });
  } catch (error) {
    req.log?.error?.({ error, companyId }, "HRD directory read unavailable");
    res.status(503).json({ message: "Direktori karyawan belum dapat dibaca." });
  }
});
/**
 * Stage-two advisory only: reproduces the legacy HRD resign kasbon precheck,
 * with a separate flag and the existing role-scoped READ ONLY transaction.
 * Does not register the employee-status PATCH endpoint.
 */
router.get("/hrd/employees/:id/resign-kasbon-precheck",async(req:HrdReadRequest,res:Response)=>{
  if (process.env.HRD_CANONICAL_RESIGN_PREFLIGHT_ENABLED !== "true") {
    res.status(404).json({message:"Pemeriksaan kasbon resign belum diaktifkan."});
    return;
  }
  const rawId=req.params.id;
  const employeeId=typeof rawId==="string" && /^[1-9][0-9]*$/.test(rawId)
    ?Number(rawId):NaN;
  if(!Number.isSafeInteger(employeeId)||employeeId<=0){
    res.status(400).json({message:"ID karyawan tidak valid."});
    return;
  }
  const companyId=req.hrdCompanyId!;
  const role=req.hrdActor?.role?.trim().toLowerCase();
  if(role!=="owner"&&role!=="super_admin"){
    res.status(403).json({message:"Pemeriksaan hanya untuk Owner/Super Admin HRD."});
    return;
  }
  try {
    const record=await withHrdCompanyReadOnly(companyId,async client=>{
      const employee=await client.query(
        "SELECT id,status FROM public.employees WHERE id=$1 AND company_id=$2 AND deleted_at IS NULL LIMIT 1",
        [employeeId,companyId],
      );
      if(employee.rowCount!==1)return null;
      const kasbon=await getEmployeeResignKasbonPrecheck(client,companyId,employeeId);
      return {employeeStatus:String(employee.rows[0].status),kasbon};
    });
    if(!record){
      res.status(404).json({message:"Karyawan tidak ditemukan pada perusahaan aktif."});
      return;
    }
    res.json({
      companyId,employeeId,employeeStatus:record.employeeStatus,...record.kasbon,
      checkReadOnly:true,kasbonUnchanged:true,canPay:false,canPostJournal:false,
      canChangeStatus:false,
    });
  }catch(error){
    req.log?.error?.({error,companyId,employeeId},"HRD read-only resign kasbon precheck failed");
    res.status(503).json({message:"Pemeriksaan kasbon tidak tersedia. Tidak ada status karyawan yang diubah."});
  }
});
export default router;
