import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { useSupabaseAuth } from "@/contexts/SupabaseAuthContext";

export interface Company {
  id: number;
  companyName: string;
  companyCode: string;
  logoUrl?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  npwp?: string | null;
  isActive: boolean;
  isHolding?: boolean;
}

// Sentinel ID for "All Companies (Consolidated)" mode.
// Must not clash with any real company id (positive integers starting from 1).
export const CONSOLIDATED_ID = 0;

export type CompanyScope = number | typeof CONSOLIDATED_ID | null;

interface CompanyContextValue {
  companies: Company[];
  activeCompany: Company | null;
  activeCompanyId: CompanyScope;
  /** Alias for activeCompanyId — same value */
  selectedCompanyId: CompanyScope;
  isConsolidated: boolean;
  setActiveCompany: (company: Company) => void;
  setConsolidated: () => void;
  setConsolidatedMode: () => void;
  isLoading: boolean;
  loadError: string | null;
  refetch: () => void;
  /** Query param string for API calls, e.g. "companyId=3" or "companyId=all" */
  companyQueryParam: string;
}

const CompanyContext = createContext<CompanyContextValue>({
  companies: [],
  activeCompany: null,
  activeCompanyId: null,
  selectedCompanyId: null,
  isConsolidated: false,
  setActiveCompany: () => {},
  setConsolidated: () => {},
  setConsolidatedMode: () => {},
  isLoading: false,
  loadError: null,
  refetch: () => {},
  companyQueryParam: "",
});

const STORAGE_KEY = "biz_active_company_id";
const CONSOLIDATED_STORAGE_VALUE = "all";
const COMPANY_REQUEST_TIMEOUT_MS = 10_000;

export function CompanyProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isApiAvailable, signOut } = useSupabaseAuth();
  const [companies, setCompanies] = useState<Company[]>([]);

  const [activeCompanyId, setActiveCompanyIdState] = useState<CompanyScope>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === CONSOLIDATED_STORAGE_VALUE) return CONSOLIDATED_ID;
      return stored ? Number(stored) : null;
    } catch {
      return null;
    }
  });

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fetchedRef = useRef(false);
  const autoRetryAttemptsRef = useRef(0);

  const fetchCompanies = useCallback(async () => {
    if (!isApiAvailable) {
      setLoadError("API perusahaan belum tersedia. Coba lagi setelah koneksi DEV pulih.");
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), COMPANY_REQUEST_TIMEOUT_MS);
    setIsLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/companies", {
        credentials: "include",
        signal: controller.signal,
      });
      if (res.status === 401) {
        setCompanies([]);
        setLoadError("Sesi login tidak valid. Silakan login ulang.");
        signOut();
        return;
      }
      if (!res.ok) throw new Error(`Daftar perusahaan gagal dimuat (HTTP ${res.status}).`);
      const data: unknown = await res.json();
      if (!Array.isArray(data) || !data.every((entry) =>
        entry && typeof entry === "object" && Number.isSafeInteger(entry.id)
        && entry.id > 0 && typeof entry.companyName === "string")) {
        throw new Error("Format respons daftar perusahaan tidak sesuai.");
      }
      setCompanies(data as Company[]);
      if (data.length === 0) setLoadError("Tidak ada perusahaan yang dapat diakses oleh sesi ini.");
      if (data.length > 0 && activeCompanyId !== CONSOLIDATED_ID) {
        const storedRaw = (() => {
          try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
        })();
        if (storedRaw === CONSOLIDATED_STORAGE_VALUE) return;
        const storedId = storedRaw ? Number(storedRaw) : null;
        if (!data.find((c) => c.id === storedId)) {
          setActiveCompanyIdState(data[0].id);
        }
      }
    } catch (error) {
      setLoadError(error instanceof Error && error.name !== "AbortError"
        ? error.message : "Permintaan perusahaan gagal atau melebihi batas waktu.");
    } finally {
      window.clearTimeout(timeout);
      setIsLoading(false);
    }
  }, [activeCompanyId, isApiAvailable, signOut]);

  useEffect(() => {
    if (isAuthenticated) {
      fetchedRef.current = false;
      autoRetryAttemptsRef.current = 0;
    }
  }, [isAuthenticated]);

  useEffect(() => {
    if (isAuthenticated && isApiAvailable && !fetchedRef.current) {
      fetchedRef.current = true;
      void fetchCompanies();
    } else if (!isAuthenticated) {
      setIsLoading(false);
    }
  }, [isAuthenticated, isApiAvailable, fetchCompanies]);

  // A cold DEV login can succeed before its first authenticated company
  // request finishes. Retry transient failures at most twice; never retry
  // invalid sessions, intentionally empty company access, or absent APIs.
  useEffect(() => {
    if (!isAuthenticated || !isApiAvailable || !loadError || companies.length > 0
      || autoRetryAttemptsRef.current >= 2
      || loadError.includes("Sesi login tidak valid")
      || loadError.includes("Tidak ada perusahaan yang dapat diakses")) return;
    const timer = window.setTimeout(() => {
      autoRetryAttemptsRef.current += 1;
      void fetchCompanies();
    }, 1500 * (autoRetryAttemptsRef.current + 1));
    return () => window.clearTimeout(timer);
  }, [isAuthenticated, isApiAvailable, loadError, companies.length, fetchCompanies]);

  const setActiveCompany = useCallback((company: Company) => {
    setActiveCompanyIdState(company.id);
    try { localStorage.setItem(STORAGE_KEY, String(company.id)); } catch {}
  }, []);

  const setConsolidated = useCallback(() => {
    setActiveCompanyIdState(CONSOLIDATED_ID);
    try { localStorage.setItem(STORAGE_KEY, CONSOLIDATED_STORAGE_VALUE); } catch {}
  }, []);

  const setConsolidatedMode = setConsolidated;

  const isConsolidated = activeCompanyId === CONSOLIDATED_ID;
  const activeCompany = isConsolidated
    ? null
    : (companies.find((c) => c.id === activeCompanyId) ?? companies[0] ?? null);

  const resolvedId: CompanyScope = isConsolidated
    ? CONSOLIDATED_ID
    : (activeCompany?.id ?? activeCompanyId);

  const companyQueryParam = isConsolidated
    ? "companyId=all"
    : resolvedId != null
      ? `companyId=${resolvedId}`
      : "";

  return (
    <CompanyContext.Provider
      value={{
        companies,
        activeCompany,
        activeCompanyId: resolvedId,
        selectedCompanyId: resolvedId,
        isConsolidated,
        setActiveCompany,
        setConsolidated,
        setConsolidatedMode,
        isLoading,
        loadError,
        refetch: fetchCompanies,
        companyQueryParam,
      }}
    >
      {children}
    </CompanyContext.Provider>
  );
}

export function useCompany() {
  return useContext(CompanyContext);
}

/** @deprecated Use companyQueryParam from useCompany() instead */
export function useCompanyQuery() {
  const { companyQueryParam } = useCompany();
  return companyQueryParam;
}
