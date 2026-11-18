-- Disposable QA-only: add the exact existing hosted auth lock columns.
ALTER TABLE public.users ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.portal_customers ADD COLUMN status_changed_at timestamptz DEFAULT now();
ALTER TABLE public.portal_company_members ADD COLUMN updated_at timestamptz DEFAULT now();
ALTER TABLE public.portal_company_requests ADD COLUMN updated_at timestamptz DEFAULT now();
