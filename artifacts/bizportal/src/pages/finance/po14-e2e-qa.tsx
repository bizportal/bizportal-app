import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { AppShell } from "@/components/layout/AppShell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCompany } from "@/contexts/CompanyContext";
import { FinanceCompanyScopeCard } from "@/pages/purchase/FinanceCompanyScopeCard";
import { requestFinanceCompanyScope } from "@/lib/financeCompanyScope";

const entityKeys = ["invoiceId", "apId", "requestId", "handoffId", "mutationId",
  "matchId", "groupId", "allocationId", "journalId"] as const;
const checkKeys = ["invoiceCreated", "threeWayMatched", "apPrepared", "paymentApproved",
  "bankImported", "automaticMatched", "allocationCreated", "journalPosted",
  "paymentFinalized", "replayIdempotent", "auditRollback"] as const;
type Receipt = {
  id: string; reference: "PO-20261117-00014"; companyId: 1; actor: string;
  amount: "100000.00"; createdAt: string; auditCount: 1; workerSha256: string;
  evidence: {
    ok: true; contract: "po14-real-sql-v1"; reference: "PO-20261117-00014"; runId: string;
    actor: { email: string; companyId: 1 };
    entities: Record<typeof entityKeys[number], number>;
    checks: Record<typeof checkKeys[number], true>;
    totals: { debit: "100000.00"; credit: "100000.00" };
    auditCounts: { approval: 1; bank: 1; finalization: 1 };
    isolatedDatabase: { name: string; removed: true };
    sheetTransport: "synthetic_fixture"; outboundNotifications: 0;
    businessDatabaseUsed: false; realBankTransfer: false;
  };
};
type Data = {
  contractVersion: 2; sandbox: true; bankTransfer: false; businessLedgerPosted: false;
  sheetTransport: "synthetic_fixture"; result: Receipt | null; replay: boolean;
};
const endpoint = "/api/mkt/admin/po14-e2e-qa";
const failureCodes = new Set(["QA_WORKER_TIMEOUT", "QA_WORKER_FAILED", "QA_WORKER_UNAVAILABLE",
  "QA_WORKER_CHANGED", "QA_WORKER_NOT_READY", "QA_WORKER_INPUT_FAILED", "QA_WORKER_OUTPUT_LIMIT",
  "QA_EVIDENCE_INVALID", "QA_RECEIPT_INVALID", "QA_DIFFERENT_ACTOR", "QA_UNAVAILABLE", "QA_RUNNING"]);
function responseError(payload: any, fallback: string): string {
  const message = typeof payload?.error === "string" && payload.error.length <= 300 ? payload.error : fallback;
  const code = typeof payload?.code === "string" && failureCodes.has(payload.code) ? payload.code : null;
  return code ? `${message} (Kode: ${code})` : message;
}
function safeResponse(data: any): data is Data {
  if (data?.contractVersion !== 2 || data.sandbox !== true || data.bankTransfer !== false ||
      data.businessLedgerPosted !== false || data.sheetTransport !== "synthetic_fixture" ||
      typeof data.replay !== "boolean") return false;
  if (data.result === null) return true;
  const row = data.result;
  const proof = row?.evidence;
  return row?.reference === "PO-20261117-00014" && row.companyId === 1 &&
    typeof row.actor === "string" && row.amount === "100000.00" && row.auditCount === 1 &&
    typeof row.workerSha256 === "string" && /^[a-f0-9]{64}$/.test(row.workerSha256) &&
    proof?.ok === true && proof.contract === "po14-real-sql-v1" && proof.runId === row.id &&
    proof.reference === row.reference && proof.actor?.email === row.actor && proof.actor.companyId === 1 &&
    entityKeys.every(key => Number.isSafeInteger(proof.entities?.[key]) && proof.entities[key] > 0) &&
    checkKeys.every(key => proof.checks?.[key] === true) &&
    proof.totals?.debit === "100000.00" && proof.totals?.credit === "100000.00" &&
    proof.auditCounts?.approval === 1 && proof.auditCounts?.bank === 1 && proof.auditCounts?.finalization === 1 &&
    proof.isolatedDatabase?.removed === true && proof.outboundNotifications === 0 &&
    proof.sheetTransport === "synthetic_fixture" && proof.businessDatabaseUsed === false &&
    proof.realBankTransfer === false;
}

function stages(receipt: Receipt) {
  const id = receipt.evidence.entities;
  return [
    ["Vendor Invoice dan three-way match", `Invoice #${id.invoiceId} · PO #14 · GR #6`],
    ["AP dan Payment Request", `AP #${id.apId} · Payment Request #${id.requestId} · Handoff #${id.handoffId}`],
    ["Persetujuan Super Admin", receipt.actor],
    ["Impor mutasi dan pencocokan otomatis", `Mutasi #${id.mutationId} · Match #${id.matchId}`],
    ["Alokasi dan posting jurnal", `Grup #${id.groupId} · Alokasi #${id.allocationId} · Jurnal #${id.journalId}`],
    ["Finalisasi pembayaran", "Payment Request paid · handoff posted pada database uji"],
    ["Replay dan rollback audit", "Tidak ada duplikasi; kegagalan audit membatalkan perubahan uji"],
  ];
}

export default function Po14E2eQa() {
  const { activeCompanyId } = useCompany();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const current = ++loadSeq.current;
    setLoading(true); setError(""); setData(null);
    try {
      let result = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      if (result.status === 403 && activeCompanyId === 1) {
        await requestFinanceCompanyScope(1);
        result = await fetch(endpoint, { credentials: "include", cache: "no-store" });
      }
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) throw Error(responseError(payload, "Bukti SQL QA belum tersedia"));
      if (!safeResponse(payload)) throw Error("Bukti layanan SQL tidak lengkap atau masih memakai kontrak simulasi lama");
      if (current === loadSeq.current) { setError(""); setData(payload); }
    } catch (e) {
      if (current === loadSeq.current) setError(e instanceof Error ? e.message : "Gagal memuat QA");
    } finally { if (current === loadSeq.current) setLoading(false); }
  }, [activeCompanyId]);
  useEffect(() => { void load(); }, [load]);

  async function run() {
    if (activeCompanyId !== 1 || running) return;
    const current = ++loadSeq.current;
    setRunning(true); setError("");
    try {
      const result = await fetch(endpoint, { method: "POST", credentials: "include", cache: "no-store",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reference: "PO-20261117-00014" }) });
      const payload = await result.json().catch(() => ({}));
      if (!result.ok) {
        // A failed worker may be retried manually; a rejected session/scope must be verified again.
        if ([401, 403, 404].includes(result.status) && current === loadSeq.current) setData(null);
        throw Error(responseError(payload, "Uji transaksi PO #14 belum berhasil"));
      }
      if (!safeResponse(payload) || !payload.result) throw Error("Bukti layanan SQL tidak lengkap; hasil belum PASS");
      if (current === loadSeq.current) { setError(""); setData(payload); setLoading(false); }
    } catch (e) {
      if (current === loadSeq.current) setError(e instanceof Error ? e.message : "Uji transaksi belum berhasil");
    } finally { setRunning(false); }
  }

  return <AppShell>
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Uji Transaksi PO #14 — Finance DEV</h1>
          <p className="text-sm text-muted-foreground">Sesi Super Admin asli · layanan Finance · database uji terisolasi</p>
        </div>
        <Link href="/finance/payment-approval-qa" className="text-sm underline">Persetujuan QA sebelumnya</Link>
      </div>
      <Card><CardHeader><CardTitle className="text-base">Transaksi uji internal</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p><strong>PO:</strong> PO-20261117-00014 · <strong>GR:</strong> #6 · <strong>Shipment:</strong> #8</p>
          <p><strong>Supplier:</strong> CST (internal) · <strong>Item:</strong> Frozen Tuna Saku · <strong>Nominal:</strong> Rp100.000</p>
          <p>Layanan membuat Invoice, AP, mutasi, alokasi, dan jurnal pada database sementara. Hasil diperiksa sebelum bukti disimpan.</p>
          <p>Sumber mutasi adalah rekening koran uji. Koneksi Google Sheets dan transfer bank sungguhan tidak termasuk pengujian ini.</p>
        </CardContent>
      </Card>
      {activeCompanyId !== 1 ? <FinanceCompanyScopeCard onVerified={() => void load()} /> :
        !data && error ? <FinanceCompanyScopeCard onVerified={() => void load()} /> :
        data && <p role="status" className="text-sm text-green-600">Perusahaan Finance CST telah diverifikasi oleh server untuk sesi ini.</p>}
      <Card><CardHeader><CardTitle className="text-base">Bukti transaksi layanan</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2 flex-wrap">
            <Badge variant="secondary">DATABASE UJI</Badge>
            <Badge variant="outline">Tidak ada transfer bank</Badge>
            <Badge variant="outline">Tidak membuat GL bisnis</Badge>
          </div>
          {loading ? <p role="status">Memverifikasi sesi dan membaca bukti SQL...</p> :
            data?.result ? <div className="space-y-3">
              <p role="status" className="font-semibold">PASS — transaksi SQL terisolasi terverifikasi</p>
              <p className="text-sm">Aktor sesi: {data.result.actor}</p>
              <p className="font-medium">Debit Rp100.000 = kredit Rp100.000</p>
              <div className="space-y-2">
                {stages(data.result).map(([title, detail], i) => <div key={title} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2"><strong>{i + 1}. {title}</strong><Badge variant="outline">PASS</Badge></div>
                  <p className="text-muted-foreground mt-1">{detail}</p>
                </div>)}
              </div>
              <p className="text-sm">Audit persetujuan: 1 · audit posting bank: 1 · audit finalisasi: 1. Database sementara telah dihapus.</p>
              <p className="text-xs text-muted-foreground break-all">Bukti #{data.result.id} · versi worker {data.result.workerSha256.slice(0, 12)}</p>
              {data.replay && <p className="text-sm">Bukti tersimpan diperiksa ulang; tidak membuat transaksi uji tambahan.</p>}
            </div> : <p className="text-sm">Belum ada bukti transaksi SQL untuk versi layanan ini.</p>}
          {running && <p role="status" className="text-sm">Menjalankan layanan dan memeriksa replay serta rollback. Tunggu sampai hasil tampil.</p>}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {!loading && activeCompanyId === 1 && data &&
            <Button onClick={() => void run()} disabled={running || !data}>
              {running ? "Pengujian berlangsung..." : data?.result ? "Periksa Bukti Tersimpan" : "Jalankan Uji Transaksi PO #14"}
            </Button>}
          <Button variant="outline" onClick={() => void load()} disabled={loading || running}>Periksa ulang status</Button>
        </CardContent>
      </Card>
      <p className="text-sm text-muted-foreground">Bukti ini berlaku untuk layanan SQL di database uji. Pencatatan pada database bisnis CST-DEV dan PROD tetap terpisah.</p>
    </div>
  </AppShell>;
}
