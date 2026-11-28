/** Presentation only: never grant access or treat a failed read as zero records. */
export type KasbonListReadState = "loading" | "unavailable" | "empty" | "filtered-empty" | "ready";
export function parseKasbonListResponse(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload) ? payload :
    payload !== null && typeof payload === "object" && "data" in payload ? payload.data : undefined;
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Daftar kasbon tidak tersedia.");
  }
  return rows as Record<string, unknown>[];
}
export function kasbonListReadState(
  queryStatus: "pending" | "error" | "success", total: number, visible: number,
): KasbonListReadState {
  if (queryStatus === "pending") return "loading";
  if (queryStatus !== "success") return "unavailable";
  if (total === 0) return "empty";
  return visible === 0 ? "filtered-empty" : "ready";
}
