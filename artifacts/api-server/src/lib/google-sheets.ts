import crypto from "node:crypto";

interface GoogleServiceAccount {
  client_email?: string;
  private_key?: string;
  token_uri?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
}

export interface SpreadsheetValueUpdate {
  range: string;
  values: string[][];
}

interface SpreadsheetMetadata {
  properties?: { title?: string };
  sheets?: Array<{ properties?: { title?: string } }>;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function getCredentials(): Required<Pick<GoogleServiceAccount, "client_email" | "private_key">> &
  GoogleServiceAccount {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not configured");

  let credentials: GoogleServiceAccount;
  try {
    credentials = JSON.parse(raw) as GoogleServiceAccount;
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account is missing client_email or private_key");
  }
  return credentials as Required<Pick<GoogleServiceAccount, "client_email" | "private_key">> &
    GoogleServiceAccount;
}

async function getAccessToken(credentials: ReturnType<typeof getCredentials>): Promise<string> {
  const tokenUri = credentials.token_uri ?? "https://oauth2.googleapis.com/token";
  const now = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = encodeBase64Url(
    JSON.stringify({
      iss: credentials.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsigned = `${header}.${claim}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${signer.sign(credentials.private_key, "base64url")}`;

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!response.ok) throw new Error(`Google OAuth failed (${response.status})`);

  const data = (await response.json()) as GoogleTokenResponse;
  if (!data.access_token) throw new Error("Google OAuth did not return an access token");
  return data.access_token;
}

export async function inspectSpreadsheet(
  spreadsheetId: string,
): Promise<{ title: string; tabs: string[]; serviceAccountEmail: string }> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`,
  );
  url.searchParams.set("fields", "properties.title,sheets.properties.title");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Spreadsheet tidak ditemukan atau belum dibagikan ke Service Account");
    }
    throw new Error(`Google Sheets API failed (${response.status})`);
  }

  const data = (await response.json()) as SpreadsheetMetadata;
  return {
    title: data.properties?.title ?? "Untitled spreadsheet",
    tabs: (data.sheets ?? [])
      .map((sheet) => sheet.properties?.title)
      .filter((title): title is string => Boolean(title)),
    serviceAccountEmail: credentials.client_email,
  };
}

export async function readSpreadsheetValues(
  spreadsheetId: string,
  tabName: string,
): Promise<string[][]> {
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const range = `${tabName}!A:ZZ`;
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`,
  );
  url.searchParams.set("majorDimension", "ROWS");

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Spreadsheet tidak ditemukan atau belum dibagikan ke Service Account");
    }
    throw new Error(`Google Sheets API failed (${response.status})`);
  }

  const data = (await response.json()) as { values?: unknown[][] };
  return (data.values ?? []).map((row) =>
    row.map((value) => (value == null ? "" : String(value))),
  );
}

function quoteSheetName(tabName: string): string {
  return `'${tabName.replace(/'/g, "''")}'`;
}

export function spreadsheetCellRange(
  tabName: string,
  columnNumber: number,
  rowNumber: number,
): string {
  let column = columnNumber + 1;
  let letters = "";
  while (column > 0) {
    const remainder = (column - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    column = Math.floor((column - 1) / 26);
  }
  return `${quoteSheetName(tabName)}!${letters}${rowNumber}`;
}

/** Exact read-only numeric/FORMULA evidence for at most 20 cash mismatch rows. */
export async function readCashMismatchCellEvidence(
  spreadsheetId: string,
  tabName: string,
  columns: { debit: number; credit: number; saldo: number },
  rowNumbers: number[],
): Promise<Array<{
  rowNumber: number;
  debitRaw: number | null;
  creditRaw: number | null;
  saldoRaw: number | null;
  debitFormula: boolean;
  creditFormula: boolean;
  saldoFormula: boolean;
}>> {
  const selected = [...new Set(rowNumbers)].filter((n) =>
    Number.isInteger(n) && n >= 2 && n <= 100000).slice(0, 20);
  if (!selected.length) return [];
  if (Object.values(columns).some((n) => !Number.isInteger(n) || n < 0 || n > 100)) {
    throw new Error("CASH_AUDIT_HEADER_UNSUPPORTED");
  }
  const credentials = getCredentials();
  const token = await getAccessToken(credentials);
  const cellNames = ["debit", "credit", "saldo"] as const;
  const ranges = selected.flatMap((rowNumber) =>
    cellNames.map((name) => spreadsheetCellRange(tabName, columns[name], rowNumber)));
  async function batchRead(valueRenderOption: "UNFORMATTED_VALUE" | "FORMULA"): Promise<unknown[]> {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
    );
    for (const range of ranges) url.searchParams.append("ranges", range);
    url.searchParams.set("valueRenderOption", valueRenderOption);
    const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error("CASH_AUDIT_SOURCE_READ_UNAVAILABLE");
    const json = await response.json() as { valueRanges?: Array<{ values?: unknown[][] }> };
    if (!Array.isArray(json.valueRanges) || json.valueRanges.length !== ranges.length) {
      throw new Error("CASH_AUDIT_SOURCE_RANGE_MISMATCH");
    }
    return json.valueRanges.map((item) => item.values?.[0]?.[0] ?? null);
  }
  const [raw, formulas] = await Promise.all([
    batchRead("UNFORMATTED_VALUE"), batchRead("FORMULA"),
  ]);
  const numeric = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  const hasFormula = (value: unknown): boolean =>
    typeof value === "string" && value.startsWith("=");
  return selected.map((rowNumber, i) => {
    const j = i * 3;
    return {
      rowNumber,
      debitRaw: numeric(raw[j]), creditRaw: numeric(raw[j + 1]), saldoRaw: numeric(raw[j + 2]),
      debitFormula: hasFormula(formulas[j]),
      creditFormula: hasFormula(formulas[j + 1]),
      saldoFormula: hasFormula(formulas[j + 2]),
    };
  });
}

export async function writeSpreadsheetValues(
  spreadsheetId: string,
  updates: SpreadsheetValueUpdate[],
): Promise<void> {
  if (updates.length === 0) return;

  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const url = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchUpdate`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      valueInputOption: "USER_ENTERED",
      data: updates.map((update) => ({
        range: update.range,
        majorDimension: "ROWS",
        values: update.values,
      })),
    }),
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error(
        "Spreadsheet tidak dapat ditulis. Pastikan Service Account memiliki akses Editor",
      );
    }
    throw new Error(`Google Sheets write API failed (${response.status})`);
  }
}