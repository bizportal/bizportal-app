import { useEffect, useRef, useState } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  isSelectableFinanceCompanyId, requestFinanceCompanyScope,
} from "@/lib/financeCompanyScope";

/**
 * DEV-only opt-in UI. The existing company selector is a display preference,
 * not authorization; only a deliberate server-confirmed selection can
 * produce the separate signed Finance-company cookie.
 */
export function FinanceCompanyScopeCard({ onVerificationStart, onVerified }: {
  onVerificationStart?: () => void;
  onVerified?: (companyId: number) => void;
} = {}) {
  const { activeCompany, activeCompanyId, isConsolidated, isLoading } = useCompany();
  const [busy, setBusy] = useState(false);
  const [confirmedCompanyId, setConfirmedCompanyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latestCompanyId = useRef(activeCompanyId);
  latestCompanyId.current = activeCompanyId;

  useEffect(() => {
    setConfirmedCompanyId(null);
    setError(null);
  }, [activeCompanyId]);

  const eligible = !isLoading && !isConsolidated
    && isSelectableFinanceCompanyId(activeCompanyId)
    && activeCompany?.id === activeCompanyId;
  const confirmed = eligible && confirmedCompanyId === activeCompanyId;

  const verifyCompany = async () => {
    if (!eligible || !isSelectableFinanceCompanyId(activeCompanyId) || busy) return;
    const selected = activeCompanyId;
    setBusy(true);
    setConfirmedCompanyId(null);
    setError(null);
    onVerificationStart?.();
    try {
      await requestFinanceCompanyScope(selected);
      if (latestCompanyId.current === selected) {
        setConfirmedCompanyId(selected);
        onVerified?.(selected);
      }
    } catch (cause) {
      if (latestCompanyId.current === selected) {
        setError(cause instanceof Error ? cause.message : "Verifikasi perusahaan Finance gagal.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Verifikasi Perusahaan Finance (DEV)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Gunakan perusahaan yang dipilih di BizPortal. Verifikasi ini membutuhkan
          sesi Super Admin yang sah dan izin Finance di server; tidak melakukan pembayaran
          atau posting jurnal.
        </p>
        <p>
          Perusahaan: <strong>{eligible ? activeCompany?.companyName : "Belum dipilih"}</strong>
        </p>
        {isConsolidated && (
          <p role="status">Mode Semua Perusahaan tidak dapat digunakan untuk Finance. Pilih satu perusahaan.</p>
        )}
        {confirmed && (
          <p role="status" className="text-green-700">
            Perusahaan telah diverifikasi oleh server untuk sesi Finance ini.
          </p>
        )}
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button
          type="button"
          variant="outline"
          disabled={!eligible || busy}
          onClick={() => void verifyCompany()}
        >
          {busy ? "Memverifikasi..." : "Verifikasi perusahaan Finance"}
        </Button>
      </CardContent>
    </Card>
  );
}
