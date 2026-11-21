/**
 * Reconcile an existing Google Sheet configuration with its bank account.
 *
 * CST-DEV's canonical public.bank_sheet_configs stores company_id and
 * bank_account_number, NOT bank_account_id. Match by company + normalized
 * number, and fail closed on ambiguous matches rather than guessing.
 *
 * Read-only: never create/update an account or a Sheet configuration here.
 */
export const bankSheetConfigAccountJoin = `
  left join lateral (
    select account.id, account.name, account.coa_id, account.account_type
      from public.company_bank_accounts account
     where account.company_id = config.company_id
       and nullif(regexp_replace(coalesce(account.account_number,''),'[^0-9]','','g'),'')
         = nullif(regexp_replace(coalesce(config.bank_account_number,''),'[^0-9]','','g'),'')
       and (
         select count(*)
           from public.company_bank_accounts possible
          where possible.company_id = config.company_id
            and nullif(regexp_replace(coalesce(possible.account_number,''),'[^0-9]','','g'),'')
              = nullif(regexp_replace(coalesce(config.bank_account_number,''),'[^0-9]','','g'),'')
       ) = 1
     limit 1
  ) cba on true
`;
