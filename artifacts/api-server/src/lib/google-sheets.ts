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

/**
 * Narrow read-only inspection of formula/number precision for specific cash
 * balance exception rows. No cell value or formula text is returned.
 * The caller is responsible for enforcing DEV + signed Super Admin scope.
 */
export async function inspectCashBalanceSourceShapes(
  spreadsheetId: string,
  tabName: string,
  exceptionRows: readonly number[],
): Promise<Array<{
  rowNumber: number;
  hasFormulaInDebitCreditOrBalance: boolean;
  rawNumericPrecisionDiffersFromDisplay: boolean;
  numericCellCount: number;
}>> {
  const safeRows = [...new Set(exceptionRows)]
    .filter((n) => Number.isSafeInteger(n) && n >= 2 && n <= 10000)
    .slice(0, 20);
  if (safeRows.length === 0) return [];
  const credentials = getCredentials();
  const accessToken = await getAccessToken(credentials);
  const fetchCells = async (option: "FORMATTED_VALUE" | "UNFORMATTED_VALUE" | "FORMULA") => {
    const url = new URL(
      `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values:batchGet`,
    );
    const quoted = "'" + tabName.replace(/'/g, "''") + "'";
    for (const n of safeRows) {
      url.searchParams.append("ranges", `${quoted}!C${n}:E${n}`);
    }
    url.searchParams.set("valueRenderOption", option);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) throw new Error(`Google Sheets diagnostics unavailable (${response.status})`);
    return (await response.json()) as { valueRanges?: Array<{ values?: unknown[][] }> };
  };
  const [display, raw, formulas] = await Promise.all([
    fetchCells("FORMATTED_VALUE"),
    fetchCells("UNFORMATTED_VALUE"),
    fetchCells("FORMULA"),
  ]);
  const normalized = (source: { valueRanges?: Array<{ values?: unknown[][] }> }, index: number) =>
    (source.valueRanges?.[index]?.values?.[0] ?? []) as unknown[];
  return safeRows.map((n, index) => {
    const shown = normalized(display, index);
    const actual = normalized(raw, index);
    const formula = normalized(formulas, index);
    const numericCellCount = actual.filter((value) =>
      typeof value === "number" && Number.isFinite(value)).length;
    const normalizeShown = (value: unknown) => {
      const rawValue = String(value ?? "").trim().replace(/[^0-9.,-]/g, "");
      const dots = (rawValue.match(/\./g) ?? []).length;
      const commas = (rawValue.match(/,/g) ?? []).length;
      if (dots > 0 && commas === 0 && /^-?\d{1,3}(\.\d{3})+$/.test(rawValue)) {
        return Number(rawValue.replace(/\./g, ""));
      }
      if (commas > 0 && dots === 0 && /^-?\d{1,3}(,\d{3})+$/.test(rawValue)) {
        return Number(rawValue.replace(/,/g, ""));
      }
      return Number(rawValue.replace(",", "."));
    };
    return {
      rowNumber: n,
      hasFormulaInDebitCreditOrBalance: formula.some((v) => typeof v === "string" && v.startsWith("=")),
      rawNumericPrecisionDiffersFromDisplay: actual.some((v, i) =>
        typeof v === "number" && Number.isFinite(v)
          && Number.isFinite(normalizeShown(shown[i]))
          && Math.abs(v - normalizeShown(shown[i])) > 0.000001),
      numericCellCount,
    };
  });
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