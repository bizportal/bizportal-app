import { describe, expect, it } from "vitest";
import { invoiceAttachmentsForMessage } from "../lib/gmail-invoice-candidates";
import type { GmailAttachment, GmailInvoiceMessage } from "../lib/gmail-invoice-ocr";

function pdf(fileName: string): GmailAttachment {
  return {
    attachmentId: `att-${fileName}`,
    inlineData: null,
    fileName,
    mimeType: "application/pdf",
    size: 1234,
  };
}

function billing(attachments: GmailAttachment[], senderName = "Sukma Andinasari"): GmailInvoiceMessage {
  return {
    id: "synthetic-source-message",
    threadId: "synthetic-thread",
    subject: "INVOICE CAHAYA SEJATI TEKNOLOGI PERIODE OKTOBER 2026 & EDARAN",
    senderEmail: "account-officer@example.invalid",
    senderName,
    receivedAt: null,
    attachments,
  };
}

describe("Sukma CST Gmail invoice attachment filter", () => {
  it("never treats Faktur Pajak and a circular as the payable invoice", () => {
    const input = billing([
      pdf("FK_001234_PerPostingOCT26.pdf"),
      pdf("FK_001234_PT_CST.pdf"),
      pdf("EDARAN PENYERAHAN BUKTI POTONG TAHUN 2026.pdf"),
    ]);
    expect(invoiceAttachmentsForMessage(input)).toEqual([]);
  });

  it("selects only the last genuine invoice PDF, not FK, SRT or circular", () => {
    const actual = pdf("Invoice-Layanan-Oktober-2026.pdf");
    const input = billing([
      pdf("FK_001234_PerPostingOCT26.pdf"),
      actual,
      pdf("SRT - surat-pemberitahuan.pdf"),
      pdf("Edaran - Bukti Potong.pdf"),
    ]);
    expect(invoiceAttachmentsForMessage(input)).toEqual([actual]);
  });

  it("keeps a non-tax PDF without an invoice keyword to preserve existing billing formats", () => {
    const actual = pdf("Tagihan_2026_OCT.pdf");
    expect(invoiceAttachmentsForMessage(billing([pdf("FK_OCT.pdf"), actual]))).toEqual([actual]);
  });

  it("does not change unrelated senders' multi-attachment and tax-support behavior", () => {
    const supporting = pdf("FK_OCT.pdf");
    const circular = pdf("EDARAN 2026.pdf");
    const actual = pdf("VendorInvoice.pdf");
    const other = billing([supporting, circular, actual, pdf("SRT - surat.pdf")], "Account Officer Lain");
    expect(invoiceAttachmentsForMessage(other)).toEqual([supporting, circular, actual]);
  });

  it("does not guess from non-PDF attachments in the special billing case", () => {
    const image: GmailAttachment = { ...pdf("invoice.jpg"), mimeType: "image/jpeg" };
    expect(invoiceAttachmentsForMessage(billing([image, pdf("EDARAN 2026.pdf")]))).toEqual([]);
  });
});
