 // Appended after the existing application fixture's DDL/RLS/pool setup.
 // Financial work still uses the real application module and native writer.
 const fs=await import('node:fs');
 const contract=JSON.parse(fs.readFileSync('__ROOT__/scripts/payroll-atomic-rehearsal/dev-selected-guards-provenance.json','utf8'));
 await admin.query(fs.readFileSync('__ROOT__/scripts/payroll-atomic-rehearsal/dev-selected-guards.sql','utf8'));
 const definitions=(await admin.query(`SELECT proname,md5(pg_get_functiondef(oid)) AS hash FROM pg_proc
 WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])`,[Object.keys(contract.liveFunctionMd5)])).rows;
 assert.equal(definitions.length,4);
 for(const row of definitions)assert.equal(row.hash,contract.liveFunctionMd5[row.proname],row.proname+' must match inspected DEV function');
 ok('four selected guard definitions exactly match read-only CST-DEV metadata');
 const guards=()=>admin.query(`SELECT count(*)::integer AS n FROM pg_trigger WHERE NOT tgisinternal
  AND tgenabled='O' AND tgname IN ('trg_block_posted_update','trg_block_lines_mutation','trg_block_lines_delete',
  'trg_block_lines_update','payroll_dev_review_item_guard','payroll_dev_hr_review_status_guard')`);
 assert.equal((await guards()).rows[0].n,6);
 const previous=await import('__PREVIOUS__');
 const hasMessage=(e:unknown,pattern:RegExp)=>{
  let value:any=e;
  for(let n=0;n<6&&value;n++,value=value.cause)if(pattern.test(String(value.message)))return true;
  return false;
 };
 await reset();
 await assert.rejects(executeAtomic(1,previous.PayrollJournalService),(e)=>hasMessage(e,/IMMUTABILITY_VIOLATION/));
 await unchanged();
 ok('previous staged transaction patch fails on posted-checksum update and fully rolls back under real DEV immutability guard');

 await reset();
 const result=await executeAtomic();
 const expected={entries:1,lines:6,audit:1,outbox:1,balance:'400000.00',reservation:'confirmed',status:'approved',entry_id:result.entryId,payments:0,repayments:1};
 assert.deepEqual(await state(),expected);
 const metadata=(await admin.query('SELECT status,checksum_hash,previous_entry_id FROM accounting_entries WHERE id=$1',[result.entryId])).rows[0];
 assert.equal(metadata.status,'posted');assert.match(metadata.checksum_hash,/^[0-9a-f]{64}$/);assert.equal(metadata.previous_entry_id,null);
 assert.equal(outsideQueries,0);
 ok('revised native transaction finalizes checksum in draft and commits one accrual plus repayment with all six guards enabled');
 const replay=await executeAtomic();assert.equal(replay.reused,true);assert.equal(replay.entryId,result.entryId);assert.deepEqual(await state(),expected);
 ok('replay succeeds without touching the immutable posted journal or repeating the repayment');

 for(const [label,sqlText] of [
  ['posted checksum',"UPDATE accounting_entries SET checksum_hash='changed' WHERE id=$1"],
  ['posted journal total',"UPDATE accounting_entries SET total_debit=1 WHERE id=$1"],
  ['posted journal status',"UPDATE accounting_entries SET status='draft' WHERE id=$1"],
  ['posted line update',"UPDATE accounting_entry_lines SET debit=1 WHERE entry_id=$1"],
  ['posted line delete',"DELETE FROM accounting_entry_lines WHERE entry_id=$1"],
  ['posted line insertion',"INSERT INTO accounting_entry_lines(entry_id,account_id,debit,credit) VALUES($1,10,1,0)"],
 ] as const){
  await assert.rejects(admin.query(sqlText,[result.entryId]),(e)=>hasMessage(e,/IMMUTABILITY_VIOLATION/));
  assert.deepEqual(await state(),expected);ok('DEV guard still rejects '+label+' mutation after successful posting');
 }
 await reset();
 await assert.rejects(admin.query('UPDATE payroll_items SET base_salary=1 WHERE run_id=32'),/PAYROLL_RUN_LOCKED_FOR_REVIEW/);
 await assert.rejects(admin.query("UPDATE payroll_runs SET status='calculated' WHERE id=32"),/PAYROLL_HR_REVIEW_CANNOT_BE_REOPENED/);
 await unchanged();ok('actual Payroll item/review guards reject changing reviewed salaries or rewinding approval');

 await reset();
 await admin.query(`CREATE FUNCTION ci_fail_checksum() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.checksum_hash IS NULL AND NEW.checksum_hash IS NOT NULL THEN RAISE EXCEPTION 'INJECTED_CHECKSUM_FAILURE'; END IF;
 RETURN NEW;END $$; CREATE TRIGGER ci_fail_checksum BEFORE UPDATE ON accounting_entries FOR EACH ROW EXECUTE FUNCTION ci_fail_checksum()`);
 try{await assert.rejects(executeAtomic(),(e)=>hasMessage(e,/INJECTED_CHECKSUM_FAILURE/));await unchanged();}
 finally{await admin.query('DROP TRIGGER ci_fail_checksum ON accounting_entries;DROP FUNCTION ci_fail_checksum()');}
 ok('checksum failure before promotion rolls back journal lines, audit, outbox, loan and repayment');

 await reset();
 await admin.query(`CREATE FUNCTION ci_skip_checksum() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.checksum_hash IS NULL AND NEW.checksum_hash IS NOT NULL THEN RETURN NULL; END IF;
 RETURN NEW;END $$; CREATE TRIGGER ci_skip_checksum BEFORE UPDATE ON accounting_entries FOR EACH ROW EXECUTE FUNCTION ci_skip_checksum()`);
 try{await assert.rejects(executeAtomic(),(e)=>hasMessage(e,/JOURNAL_DRAFT_METADATA_NOT_FINALIZED/));await unchanged();}
 finally{await admin.query('DROP TRIGGER ci_skip_checksum ON accounting_entries;DROP FUNCTION ci_skip_checksum()');}
 ok('silently suppressed draft checksum update is detected before posting and completely rolled back');

 await reset();
 await admin.query(`CREATE FUNCTION ci_posting_order() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.status='draft' AND NEW.status='posted' THEN
  IF OLD.checksum_hash IS NULL THEN RAISE EXCEPTION 'CHECKSUM_WAS_NOT_READY_BEFORE_POSTING'; END IF;
  RAISE EXCEPTION 'INJECTED_PROMOTION_FAILURE_AFTER_METADATA';
 END IF; RETURN NEW;END $$; CREATE TRIGGER ci_posting_order BEFORE UPDATE OF status ON accounting_entries FOR EACH ROW EXECUTE FUNCTION ci_posting_order()`);
 try{await assert.rejects(executeAtomic(),(e)=>hasMessage(e,/INJECTED_PROMOTION_FAILURE_AFTER_METADATA/));await unchanged();}
 finally{await admin.query('DROP TRIGGER ci_posting_order ON accounting_entries;DROP FUNCTION ci_posting_order()');}
 ok('posting transition observes already-complete checksum; failed promotion leaves no financial residue');

 for(const [table,timing,event] of [['financial_outbox_events','BEFORE','INSERT'],['cash_advance_repayments','BEFORE','INSERT'],['payroll_runs','AFTER','UPDATE']]){
  await reset();await injectedFailure(table,timing,event,()=>executeAtomic());ok(table+' injected failure still rolls back atomically with actual DEV guards enabled');
 }
 await reset();const pair=await Promise.all([executeAtomic(),executeAtomic()]);
 assert.equal(pair.filter(r=>!r.reused).length,1);assert.equal(pair[0].entryId,pair[1].entryId);
 assert.equal((await state()).repayments,1);assert.equal((await state()).balance,'400000.00');
 ok('concurrent calls preserve one journal and repayment under immutable-journal guards');
 await reset();await assert.rejects(executeAtomic(2),/RUN_NOT_FOUND_IN_COMPANY/);await unchanged();
 ok('foreign company remains denied with selected real DEV guards');
 assert.equal((await guards()).rows[0].n,6);ok('all six copied DEV triggers remain enabled at end; none were relaxed');
 console.log('SELECTED_DEV_TRIGGER_CHECKS_PASS',passed,'LIVE_DB_MUTATIONS',false,'FULL_LIVE_SCHEMA_CLONED',false);
}finally{if(writer)await writer.end();await admin.end();}
