import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "@/components/layout/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { FinanceCompanyScopeCard } from "@/pages/purchase/FinanceCompanyScopeCard";

const STATUS_LABELS = {
  candidate_ready_for_review: "Cocok untuk ditinjau",
  partial_payment_review: "Pembayaran sebagian",
  overpayment_review: "Kelebihan pembayaran",
  multiple_receipts_review: "Beberapa mutasi",
  ambiguous_invoice_reference: "Referensi ambigu",
  unverified_ar_source: "Bukti AR belum lengkap",
  no_invoice_reference: "Tanpa referensi invoice",
} as const;
const SUMMARY_KEYS = ["invoicedDocuments", "missingInvoiceNumbers", "missingPostedArEvidence",
  "unmatchedIncomingMutations", "suggestedExact", "requiresReview"] as const;
type PreviewSummary = Record<typeof SUMMARY_KEYS[number], number>;
type PreviewMatch = {
  mutationId: number; mutationAmount: number; status: keyof typeof STATUS_LABELS;
  invoiceId: number | null; invoiceNumber: string | null; reason: string;
};
type CustomerPreview = { companyId: number; summary: PreviewSummary; matches: PreviewMatch[] };
type PreviewState = { kind: "scope_required" | "loading" }
  | { kind: "error"; message: string }
  | { kind: "success"; preview: CustomerPreview };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function parsePreview(value: unknown, companyId: number): CustomerPreview {
  const invalid = () => new Error("Respons preview tidak sesuai. Data belum dapat ditampilkan.");
  if (!isRecord(value) || value.mode !== "read_only_preview" || value.autoApproveEnabled !== false
    || value.autoPostEnabled !== false || value.companyId !== companyId
    || !isRecord(value.summary) || !Array.isArray(value.matches)) throw invalid();
  const summary = value.summary;
  if (!SUMMARY_KEYS.every(key => typeof summary[key] === "number"
    && Number.isSafeInteger(summary[key]) && summary[key] >= 0)) throw invalid();
  const matches = value.matches;
  if (!matches.every(match => isRecord(match) && positiveId(match.mutationId)
    && typeof match.mutationAmount === "number" && Number.isFinite(match.mutationAmount) && match.mutationAmount > 0
    && typeof match.status === "string" && Object.hasOwn(STATUS_LABELS, match.status)
    && (match.invoiceId === null || positiveId(match.invoiceId))
    && (match.invoiceNumber === null || typeof match.invoiceNumber === "string")
    && typeof match.reason === "string" && match.reason.trim().length > 0)) throw invalid();
  const typedSummary = summary as PreviewSummary;
  const typedMatches = matches as PreviewMatch[];
  if (!typedMatches.every(match => match.status === "no_invoice_reference" || match.status === "ambiguous_invoice_reference"
    ? match.invoiceId === null && match.invoiceNumber === null
    : positiveId(match.invoiceId) && typeof match.invoiceNumber === "string" && match.invoiceNumber.trim().length > 0)) throw invalid();
  const exact = typedMatches.filter(match => match.status === "candidate_ready_for_review").length;
  if (typedSummary.missingInvoiceNumbers > typedSummary.invoicedDocuments
    || typedSummary.missingPostedArEvidence > typedSummary.invoicedDocuments
    || typedSummary.unmatchedIncomingMutations < typedMatches.length
    || typedSummary.suggestedExact !== exact
    || typedSummary.requiresReview !== typedMatches.length - exact
    || new Set(typedMatches.map(match => match.mutationId)).size !== typedMatches.length) throw invalid();
  return { companyId, summary: typedSummary, matches: typedMatches };
}

function CompanyCustomerPreview({ companyId }: { companyId: number }) {
  const [state, setState] = useState<PreviewState>({ kind: "scope_required" });
  const [verified, setVerified] = useState(false);
  const [scopeVersion, setScopeVersion] = useState(0);
  const request = useRef<{ generation: number; controller?: AbortController }>({ generation: 0 });
  const mounted = useRef(true);
  const cancel = useCallback(() => {
    request.current.generation += 1;
    request.current.controller?.abort();
    request.current.controller = undefined;
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; cancel(); };
  }, [cancel]);

  const load = useCallback(async () => {
    if (!mounted.current) return;
    cancel();
    const generation = request.current.generation;
    const controller = new AbortController();
    request.current.controller = controller;
    const current = () => mounted.current && !controller.signal.aborted
      && request.current.generation === generation;
    // Do not retain a former successful response while refreshing or failing.
    setState({ kind: "loading" });
    try {
      const response = await fetch(`/api/sales/customer-invoices/auto-match-preview?company_id=${companyId}`, {
        method: "GET", credentials: "include", cache: "no-store", signal: controller.signal,
      });
      if (!current()) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          setVerified(false);
          setScopeVersion(version => version + 1);
        }
        const message = response.status === 403
          ? "Verifikasi perusahaan Finance diperlukan atau sudah berakhir. Verifikasi perusahaan di atas untuk memuat ulang."
          : response.status === 401
            ? "Sesi login belum terverifikasi. Pastikan sesi Super Admin masih aktif pada halaman ini."
            : "Preview invoice belum dapat dimuat. Jumlah invoice belum diketahui; coba perbarui preview.";
        setState({ kind: "error", message });
        return;
      }
      const body: unknown = await response.json();
      if (!current()) return;
      const preview = parsePreview(body, companyId);
      setState({ kind: "success", preview });
    } catch (error) {
      if (!current()) return;
      setState({ kind: "error", message: error instanceof Error
        && error.message === "Respons preview tidak sesuai. Data belum dapat ditampilkan."
        ? error.message : "Preview invoice belum dapat dimuat. Jumlah invoice belum diketahui; coba perbarui preview." });
    }
  }, [cancel, companyId]);

  const verificationStarted = useCallback(() => {
    cancel();
    setVerified(false);
    setState({ kind: "scope_required" });
  }, [cancel]);
  const companyVerified = useCallback((selected: number) => {
    if (!mounted.current || selected !== companyId) return;
    setVerified(true);
    void load();
  }, [companyId, load]);

  return (
    <>
      <FinanceCompanyScopeCard key={scopeVersion}
        onVerificationStart={verificationStarted} onVerified={companyVerified} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Hasil hanya untuk perusahaan yang diverifikasi pada sesi ini.</p>
        <Button variant="outline" disabled={!verified || state.kind === "loading"} onClick={() => void load()}>
          Perbarui preview
        </Button>
      </div>
      {state.kind === "scope_required" && <p role="status">Verifikasi perusahaan Finance untuk memuat preview invoice.</p>}
      {state.kind === "loading" && <p role="status">Memuat preview invoice perusahaan…</p>}
      {state.kind === "error" && <p role="alert" className="rounded-md border border-destructive/40 p-4 text-destructive">{state.message}</p>}
      {state.kind === "success" && <CustomerPreviewResults preview={state.preview} />}
    </>
  );
}

function CustomerPreviewResults({ preview }: { preview: CustomerPreview }) {
  const { summary, matches } = preview;
  const metrics: [string, number][] = [
    ["Dokumen invoice diperiksa", summary.invoicedDocuments],
    ["Nomor invoice belum lengkap", summary.missingInvoiceNumbers],
    ["Bukti AR belum lengkap", summary.missingPostedArEvidence],
    ["Mutasi masuk belum dicocokkan", summary.unmatchedIncomingMutations],
    ["Kandidat cocok untuk ditinjau", summary.suggestedExact],
    ["Kandidat perlu pemeriksaan", summary.requiresReview],
  ];
  return (
    <section aria-label="Hasil preview invoice" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {metrics.map(([label, count]) => <Card key={label}>
          <CardContent className="p-4">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">{count}</p>
          </CardContent>
        </Card>)}
      </div>
      {summary.invoicedDocuments === 0 && <p>Tidak ada dokumen berstatus invoice pada perusahaan ini.</p>}
      <Card>
        <CardHeader><CardTitle className="text-base">Pemeriksaan mutasi bank masuk</CardTitle></CardHeader>
        <CardContent>
          {matches.length === 0 ? <p className="text-sm text-muted-foreground">Belum ada hasil pencocokan untuk ditampilkan.</p> : (
            <Table>
              <TableHeader><TableRow>
                <TableHead>Mutasi</TableHead><TableHead>Referensi invoice</TableHead>
                <TableHead className="text-right">Nilai mutasi</TableHead>
                <TableHead>Hasil pemeriksaan</TableHead><TableHead>Keterangan</TableHead>
              </TableRow></TableHeader>
              <TableBody>{matches.map(match => <TableRow key={match.mutationId}>
                <TableCell>#{match.mutationId}</TableCell>
                <TableCell>{match.invoiceNumber ?? "Belum teridentifikasi"}</TableCell>
                <TableCell className="text-right whitespace-nowrap">{new Intl.NumberFormat("id-ID", {
                  style: "currency", currency: "IDR", maximumFractionDigits: 2,
                }).format(match.mutationAmount)}</TableCell>
                <TableCell><Badge variant="outline">{STATUS_LABELS[match.status]}</Badge></TableCell>
                <TableCell>{match.reason}</TableCell>
              </TableRow>)}</TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

export function CustomerArPreviewPage() {
  const { activeCompanyId, activeCompany, isConsolidated, isLoading } = useCompany();
  const companyId = !isLoading && !isConsolidated && (activeCompanyId === 1 || activeCompanyId === 3)
    && activeCompany?.id === activeCompanyId ? activeCompanyId : null;
  return (
    <AppShell>
      <div className="flex flex-col gap-5">
        <div className="space-y-2">
          <div className="flex items-center gap-3"><h1 className="text-2xl font-bold">Invoice Pelanggan — Preview AR</h1><Badge variant="outline">Baca-saja</Badge></div>
          <p className="text-sm text-muted-foreground">Dokumen yang sudah berstatus invoice dan kandidat penerimaan bank. Kelengkapan nomor invoice dan bukti AR ditampilkan terpisah.</p>
          <p className="text-sm text-muted-foreground">Maksimal 300 dokumen invoice dan 300 mutasi masuk yang belum dicocokkan per preview.</p>
          <p className="text-sm">Kandidat perlu ditinjau. Preview ini tidak menyetujui pembayaran atau memposting jurnal.</p>
        </div>
        {companyId === null ? <p role="status">Pilih satu perusahaan CST atau DIVA untuk memeriksa invoice pelanggan.</p>
          // A fresh component is required even on CST → DIVA → CST. No response
          // or local verification is reused across company selections.
          : <CompanyCustomerPreview key={companyId} companyId={companyId} />}
      </div>
    </AppShell>
  );
}
