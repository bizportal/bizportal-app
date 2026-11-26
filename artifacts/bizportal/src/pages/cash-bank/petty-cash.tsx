import { DatePicker } from "@/components/ui/date-picker";
import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { useCompany } from "@/contexts/CompanyContext";
import { Plus, Wallet, RefreshCw, ArrowDownLeft, ArrowUpRight, ArrowLeft } from "lucide-react";
import { isPettyCashChoice, pettyCashReadError } from "./petty-cash-policy";

const API = "/api";
function fmt(n: number | string) { return new Intl.NumberFormat("id-ID").format(Number(n) || 0); }

const TX_TYPES = [
  { value: "CASH_IN",       label: "Cash In",       in: true },
  { value: "CASH_OUT",      label: "Cash Out",       in: false },
  { value: "REIMBURSEMENT", label: "Reimburse",      in: true },
  { value: "SETTLEMENT",    label: "Settlement",     in: true },
  { value: "ADVANCE",       label: "Kasbon/Advance", in: false },
  { value: "EXPENSE",       label: "Pengeluaran",    in: false },
];

const STATUS_CFG: Record<string, { label: string; color: string }> = {
  DRAFT:     { label: "Draft",     color: "bg-slate-700 text-slate-300" },
  APPROVED:  { label: "Disetujui", color: "bg-blue-500/20 text-blue-300" },
  COMPLETED: { label: "Selesai",   color: "bg-green-500/20 text-green-300" },
};

export default function CashBankPettyCash() {
  const { activeCompanyId } = useCompany();
  const [txs, setTxs] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({});
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [serviceAvailable, setServiceAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ account_id: "", transaction_type: "CASH_OUT", date: new Date().toISOString().slice(0,10), amount: "", description: "", category: "", recipient: "", receipt_no: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const latestLoadId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const loadId = ++latestLoadId.current;
    if (!activeCompanyId) {
      setServiceAvailable(false);
      setTxs([]);
      setSummary({});
      setAccounts([]);
      setError(null);
      setShowModal(false);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setServiceAvailable(false);
    try {
      const [txR, accR] = await Promise.all([
        fetch(`${API}/cash-bank/petty-cash?companyId=${activeCompanyId}&limit=100`, { credentials: "include" }),
        fetch(`${API}/cash-bank/accounts?companyId=${activeCompanyId}`, { credentials: "include" }),
      ]);
      if (loadId !== latestLoadId.current) return;
      if (!txR.ok) {
        setError(pettyCashReadError(txR.status));
        setTxs([]);
        setSummary({});
        setAccounts([]);
        return;
      }
      if (!accR.ok) {
        setError(pettyCashReadError(accR.status));
        setAccounts([]);
        return;
      }
      const [txData, accData] = await Promise.all([txR.json(), accR.json()]);
      if (loadId !== latestLoadId.current) return;
      if (!Array.isArray(txData?.data) || !Array.isArray(accData?.data)) {
        setError("Respons layanan Kas Kecil tidak valid; pembuatan transaksi dinonaktifkan.");
        return;
      }
      setTxs(txData.data);
      setSummary(txData.summary ?? {});
      setAccounts(accData.data.filter((account: any) => isPettyCashChoice(account, activeCompanyId)));
      setServiceAvailable(true);
    } catch {
      if (loadId !== latestLoadId.current) return;
      setError("Layanan Kas Kecil tidak dapat dihubungi. Tidak ada transaksi yang disimpan.");
      setAccounts([]);
      setTxs([]);
      setSummary({});
    } finally {
      if (loadId === latestLoadId.current) setLoading(false);
    }
  }, [activeCompanyId]);

  useEffect(() => { void load(); }, [load]);

  const save = async () => {
    if (!serviceAvailable || !activeCompanyId) return;
    if (!accounts.some((account: any) => String(account.id) === form.account_id)) {
      setError("Pilih rekening Kas Kecil yang valid. Kas Besar SC tidak menggunakan form ini.");
      return;
    }
    const amount = Number(form.amount);
    if (!form.transaction_type || !form.date || !Number.isFinite(amount) || amount <= 0) {
      setError("Lengkapi tipe transaksi, tanggal dan nominal positif.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`${API}/cash-bank/petty-cash`, {
        method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include",
        body: JSON.stringify({ ...form, companyId: activeCompanyId }),
      });
      const saveResult = response.ok ? await response.json().catch(() => null) : null;
      if (!response.ok || !saveResult || saveResult.ok === false || saveResult.error) {
        setError(`Transaksi belum terkonfirmasi tersimpan (HTTP ${response.status}). Periksa layanan Kas Kecil.`);
        return;
      }
      setShowModal(false);
      setForm({ account_id: "", transaction_type: "CASH_OUT", date: new Date().toISOString().slice(0,10), amount: "", description: "", category: "", recipient: "", receipt_no: "", notes: "" });
      await load();
    } catch {
      setError("Gagal menghubungi layanan. Transaksi belum disimpan.");
    } finally { setSaving(false); }
  };

  const action = async (id: number, endpoint: string) => {
    if (!serviceAvailable) return;
    setActionLoading(id);
    setError(null);
    try {
      const result = await fetch(`${API}/cash-bank/petty-cash/${id}/${endpoint}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, credentials: "include",
      });
      const actionResult = result.ok ? await result.json().catch(() => null) : null;
      if (!result.ok || !actionResult || actionResult.ok === false || actionResult.error) {
        setError(`Perubahan status belum terkonfirmasi (HTTP ${result.status}).`);
        return;
      }
      await load();
    } catch {
      setError("Gagal menghubungi layanan. Status transaksi belum diubah.");
    } finally { setActionLoading(null); }
  };

  const filtered = txs.filter(t => typeFilter === "all" || t.transaction_type === typeFilter);
  const f = (k: string) => (v: string) => setForm(p => ({ ...p, [k]: v }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.history.back()}
            aria-label="Kembali"
            className="rounded-md p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <ArrowLeft size={18} />
          </button>
          <div>
            <h1 className="text-2xl font-black text-white">Kas Kecil (Petty Cash)</h1>
            <p className="text-sm text-slate-400 mt-0.5">Transaksi kas kecil & pengeluaran operasional</p>
          </div>
        </div>
        <Button onClick={() => setShowModal(true)} disabled={!serviceAvailable || loading} className="bg-orange-500 hover:bg-orange-600 text-white">
          <Plus size={14} className="mr-1.5" /> Transaksi Baru
        </Button>
      </div>

      {error && (
        <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">{error}</p>
      )}
      <p className="text-xs text-slate-500">Kas Besar SC (Account #18) terpisah dan tidak tersedia melalui alur Kas Kecil.</p>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total Masuk", value: summary.total_in ?? 0, color: "text-green-400", icon: ArrowDownLeft },
          { label: "Total Keluar", value: summary.total_out ?? 0, color: "text-red-400", icon: ArrowUpRight },
          { label: "Saldo Kas Kecil", value: summary.balance ?? 0, color: parseFloat(summary.balance || "0") >= 0 ? "text-orange-400" : "text-red-400", icon: Wallet },
        ].map(item => (
          <Card key={item.label} style={{ background: "#1E293B", border: "1px solid rgba(255,255,255,0.08)" }}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-1">
                <item.icon size={14} className={item.color} />
                <p className="text-xs text-slate-400">{item.label}</p>
              </div>
              <p className={`text-xl font-black ${item.color}`}>Rp {fmt(item.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filter */}
      <div className="flex gap-3">
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-44 bg-slate-800 border-slate-700 text-white"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Semua Tipe</SelectItem>
            {TX_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon" onClick={load} className="text-slate-400 hover:text-white">
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Transactions */}
      <div className="space-y-2">
        {filtered.map(tx => {
          const typeCfg = TX_TYPES.find(t => t.value === tx.transaction_type);
          const statusCfg = STATUS_CFG[tx.status] ?? { label: tx.status, color: "bg-slate-700 text-slate-300" };
          const isIn = typeCfg?.in ?? true;
          const isLoading = actionLoading === tx.id;
          return (
            <Card key={tx.id} style={{ background: "#1E293B", border: "1px solid rgba(255,255,255,0.08)" }}>
              <CardContent className="p-3">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${isIn ? "bg-green-500/10" : "bg-red-500/10"}`}>
                      {isIn ? <ArrowDownLeft size={14} className="text-green-400" /> : <ArrowUpRight size={14} className="text-red-400" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-xs text-slate-400">{tx.transaction_no}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300">{typeCfg?.label ?? tx.transaction_type}</span>
                      </div>
                      <p className="text-sm text-slate-300 truncate mt-0.5">{tx.description ?? "—"}</p>
                      <p className="text-xs text-slate-500">{tx.date} {tx.account_name ? `• ${tx.account_name}` : ""} {tx.recipient ? `• ${tx.recipient}` : ""}</p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className={`text-base font-black ${isIn ? "text-green-400" : "text-red-400"}`}>
                      {isIn ? "+" : "-"}Rp {fmt(tx.amount)}
                    </p>
                    <div className="flex gap-1.5 mt-1.5 justify-end">
                      {tx.status === "DRAFT" && (
                        <>
                          <Button size="sm" disabled={isLoading} onClick={() => action(tx.id, "approve")} className="h-6 px-2 text-[10px] bg-blue-500/20 text-blue-300 hover:bg-blue-500/30 border border-blue-500/30">
                            {isLoading ? "..." : "Setujui"}
                          </Button>
                          <Button size="sm" disabled={isLoading} onClick={() => action(tx.id, "complete")} className="h-6 px-2 text-[10px] bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30">
                            {isLoading ? "..." : "Selesai"}
                          </Button>
                        </>
                      )}
                      {tx.status === "APPROVED" && (
                        <Button size="sm" disabled={isLoading} onClick={() => action(tx.id, "complete")} className="h-6 px-2 text-[10px] bg-green-500/20 text-green-300 hover:bg-green-500/30 border border-green-500/30">
                          {isLoading ? "..." : "Selesai & Posting"}
                        </Button>
                      )}
                      {tx.entry_id && <span className="text-[10px] text-slate-600 font-mono">JE #{tx.entry_id}</span>}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
        {!loading && !filtered.length && (
          <div className="text-center py-12 text-slate-500">
            <Wallet size={32} className="mx-auto mb-3 text-slate-700" />
            <p>Belum ada transaksi kas kecil.</p>
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent style={{ background: "#1E293B", border: "1px solid rgba(255,255,255,0.1)", color: "white" }}>
          <DialogHeader><DialogTitle>Transaksi Kas Kecil Baru</DialogTitle></DialogHeader>
          {error && <p role="alert" className="text-sm text-amber-200">{error}</p>}
          <div className="grid grid-cols-2 gap-3 py-2">
            <div>
              <Label className="text-xs text-slate-400">Tipe Transaksi *</Label>
              <Select value={form.transaction_type} onValueChange={f("transaction_type")}>
                <SelectTrigger className="bg-slate-800 border-slate-700 text-white mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>{TX_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Rekening Kas Kecil</Label>
              <Select value={form.account_id || "__none__"} onValueChange={(v) => f("account_id")(v === "__none__" ? "" : v)}>
                <SelectTrigger className="bg-slate-800 border-slate-700 text-white mt-1"><SelectValue placeholder="Pilih rekening..." /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">— Tanpa Rekening —</SelectItem>
                  {accounts.map((a: any) => <SelectItem key={a.id} value={String(a.id)}>{a.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-slate-400">Jumlah (Rp) *</Label>
              <Input type="number" value={form.amount} onInput={(e: any) => f("amount")(e.target.value)} className="bg-slate-800 border-slate-700 text-white mt-1" />
            </div>
            <div>
              <Label className="text-xs text-slate-400">Tanggal *</Label>
              <DatePicker value={form.date} onChange={(v) => f("date")(v)} className="bg-slate-800 border-slate-700 text-white mt-1" />
            </div>
            <div className="col-span-2">
              <Label className="text-xs text-slate-400">Keterangan</Label>
              <Input value={form.description} onInput={(e: any) => f("description")(e.target.value)} className="bg-slate-800 border-slate-700 text-white mt-1" />
            </div>
            <div>
              <Label className="text-xs text-slate-400">Kategori</Label>
              <Input value={form.category} onInput={(e: any) => f("category")(e.target.value)} className="bg-slate-800 border-slate-700 text-white mt-1" placeholder="cth: Makan, Transport" />
            </div>
            <div>
              <Label className="text-xs text-slate-400">Penerima / Vendor</Label>
              <Input value={form.recipient} onInput={(e: any) => f("recipient")(e.target.value)} className="bg-slate-800 border-slate-700 text-white mt-1" />
            </div>
            <div>
              <Label className="text-xs text-slate-400">No. Bukti / Kwitansi</Label>
              <Input value={form.receipt_no} onInput={(e: any) => f("receipt_no")(e.target.value)} className="bg-slate-800 border-slate-700 text-white mt-1" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowModal(false)} className="text-slate-400">Batal</Button>
            <Button onClick={save} disabled={saving || !serviceAvailable} className="bg-orange-500 hover:bg-orange-600 text-white">
              {saving ? "Menyimpan..." : "Simpan (Draft)"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
