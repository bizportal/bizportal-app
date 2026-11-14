import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@workspace/db", () => ({ pool: { query: db.query } }));

import { reviewGmailInvoiceCandidate } from "./gmail-invoice-candidates";

type Candidate = {
  id: number; companyId: number; status: string;
  vendorInvoiceId: number | null; history: string[];
};
let candidate: Candidate;

beforeEach(() => {
  candidate = { id: 41, companyId: 1, status: "ready", vendorInvoiceId: null, history: [] };
  db.query.mockReset();
  db.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (!String(sql).includes("update public.gmail_invoice_candidates")) {
      throw new Error("Unexpected SQL in isolated review test");
    }
    const [id, companyId, actor, isReject, reason] = args as [number,number,string,boolean,string];
    const allowed = isReject
      ? ["new","ready","manual_review","failed","duplicate","supporting"].includes(candidate.status)
      : candidate.status === "rejected";
    if (candidate.id !== id || candidate.companyId !== companyId ||
        candidate.vendorInvoiceId != null || !allowed) return { rows: [] };
    candidate.status = isReject ? "rejected" : "ready";
    candidate.history.push(`${isReject ? "rejected" : "restored"}:${actor}:${reason}`);
    return { rows: [{ id: candidate.id, status: candidate.status }] };
  });
});

const decision = (value: "reject" | "restore", companyId = 1, reason = "Verified review reason") =>
  reviewGmailInvoiceCandidate({
    companyId, candidateId: 41, actorEmail: "reviewer@example.com",
    decision: value, reason,
  });

describe("Gmail source candidate review atomic contract (mocked DB; no live writes)", () => {
  it("rejects only with a reason of 10–500 characters before SQL", async () => {
    await expect(decision("reject", 1, "short")).rejects.toMatchObject({ status: 400 });
    await expect(decision("reject", 1, "x".repeat(501))).rejects.toMatchObject({ status: 400 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("rejects a ready candidate once and records review decision", async () => {
    await expect(decision("reject")).resolves.toEqual({ id: 41, status: "rejected" });
    expect(candidate.history).toHaveLength(1);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate rejection with conflict 409 and no second history entry", async () => {
    await decision("reject");
    await expect(decision("reject")).rejects.toMatchObject({ status: 409, code: "GMAIL_REVIEW_CONFLICT" });
    expect(candidate.history).toHaveLength(1);
  });

  it("restores a previously rejected candidate and preserves both audit entries", async () => {
    await decision("reject");
    await expect(decision("restore", 1, "restored after review")).resolves.toEqual({ id: 41, status: "ready" });
    expect(candidate.history).toHaveLength(2);
  });

  it("rejects restoration unless status is rejected", async () => {
    await expect(decision("restore")).rejects.toMatchObject({ status: 409 });
    expect(candidate.history).toHaveLength(0);
  });

  it("rejects candidate from other company even if ID matches", async () => {
    await expect(decision("reject", 2)).rejects.toMatchObject({ status: 409 });
    expect(candidate.history).toHaveLength(0);
  });

  it("cannot change candidates already linked to a vendor invoice", async () => {
    candidate.vendorInvoiceId = 777;
    await expect(decision("reject")).rejects.toMatchObject({ status: 409 });
    expect(candidate.status).toBe("ready");
    expect(candidate.history).toHaveLength(0);
  });

  it("requires company/id/status/linked-invoice guards and append-only JSON review history in SQL", async () => {
    await decision("reject");
    const [query, args] = db.query.mock.calls[0] as [string, unknown[]];
    expect(query).toContain("where id=$1 and company_id=$2 and vendor_invoice_id is null");
    expect(query).toContain("status='rejected'");
    expect(query).toContain("status in ('new','ready','manual_review','failed','duplicate','supporting')");
    expect(query).toContain("'{source_review_history}'");
    expect(query).toContain("jsonb_build_array(jsonb_build_object(");
    expect(query).toContain("returning id,status");
    expect(args).toEqual([41, 1, "reviewer@example.com", true, "Verified review reason"]);
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
