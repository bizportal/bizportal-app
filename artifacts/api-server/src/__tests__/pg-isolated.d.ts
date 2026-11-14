/**
 * Type surface used ONLY by disposable GitHub Actions PostgreSQL E2E tests.
 * The runtime implementation remains the installed pg@8 package.
 * This must not be imported into production application modules.
 * Replace with @types/pg as part of the normal dependency-lock update.
 */
declare module "pg" {
  type QueryRow = Record<string, unknown>;
  interface QueryResult<T extends QueryRow = QueryRow> {
    rows: T[];
    rowCount: number | null;
  }
  export class Client {
    constructor(config?: {connectionString?: string});
    connect(): Promise<void>;
    query<T extends QueryRow = QueryRow>(
      statement: string,
      values?: unknown[],
    ): Promise<QueryResult<T>>;
    end(): Promise<void>;
  }
  const pg: {Client: typeof Client};
  export default pg;
}
