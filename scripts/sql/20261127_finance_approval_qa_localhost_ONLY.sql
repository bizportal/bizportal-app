-- Test fixture ONLY: Docker localhost PostgreSQL on port 55495.
-- The live business databases and the existing long-lived QA container
-- must never receive this fixture.
DO $$ BEGIN
 IF current_database() <> 'finance_approval_qa' THEN
   RAISE EXCEPTION 'QA_APPROVAL_FIXTURE_DATABASE_INVALID';
 END IF;
END $$;
CREATE TABLE public.qa_approval_scenarios (
 id bigint PRIMARY KEY,
 company_id integer NOT NULL,
 scenario_ref text NOT NULL,
 amount numeric(18,2) NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved')),
 approved_at timestamptz,
 approved_by text
);
CREATE TABLE public.qa_approval_audit (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 scenario_id bigint NOT NULL REFERENCES public.qa_approval_scenarios(id),
 company_id integer NOT NULL,
 actor text NOT NULL,
 action text NOT NULL
);
INSERT INTO public.qa_approval_scenarios
 (id,company_id,scenario_ref,amount,status)
 VALUES (9001,1,'QA-PO14-APPROVAL',100000.00,'pending');
