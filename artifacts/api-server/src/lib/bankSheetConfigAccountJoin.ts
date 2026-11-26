/**
 * Reconcile an existing Google Sheet configuration with its bank account.
 *
 * The legacy CST-DEV schema stores company_id + bank_account_number only.
 * Newer schemas may also contain bank_account_id. Preserve that explicit
 * foreign-key binding whenever it is present and non-empty; do not silently
 * replace a broken explicit binding by guessing from the account number.
 *
 * Only legacy rows (or migrated rows whose bank_account_id is NULL) fall back
 * to a company-scoped normalized number match, and only when exactly one
 * account matches. Read-only: this join never creates or updates records.
 */
export const bankSheetConfigAccountJoin = `
  left join lateral (
    select account.id, account.name, account.coa_id, account.account_type
      from public.company_bank_accounts account
     where account.company_id = config.company_id
       and (
         (
           nullif(to_jsonb(config)->>'bank_account_id','') is not null
           and account.id::text = to_jsonb(config)->>'bank_account_id'
         )
         or (
           nullif(to_jsonb(config)->>'bank_account_id','') is null
           and nullif(regexp_replace(coalesce(account.account_number,''),'[^0-9]','','g'),'')
             = nullif(regexp_replace(coalesce(config.bank_account_number,''),'[^0-9]','','g'),'')
           and (
             select count(*)
               from public.company_bank_accounts possible
              where possible.company_id = config.company_id
                and nullif(regexp_replace(coalesce(possible.account_number,''),'[^0-9]','','g'),'')
                  = nullif(regexp_replace(coalesce(config.bank_account_number,''),'[^0-9]','','g'),'')
           ) = 1
         )
       )
     limit 1
  ) cba on true
`;
