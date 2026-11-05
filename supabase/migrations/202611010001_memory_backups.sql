-- Application-level memory snapshots. Room remains the primary database.
-- New private bucket only; no existing records, buckets or policies are deleted.
begin;
do $$ begin
  if exists (select 1 from storage.buckets where id = 'iseeyou-memory-backups' and public) then
    raise exception 'iseeyou-memory-backups already exists as a public bucket; stop and review';
  end if;
end $$;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('iseeyou-memory-backups', 'iseeyou-memory-backups', false, 41943040, array['application/zip'])
on conflict (id) do nothing;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='iseeyou_backup_insert_own') then
    create policy iseeyou_backup_insert_own on storage.objects for insert to authenticated
      with check (bucket_id = 'iseeyou-memory-backups' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='iseeyou_backup_read_own') then
    create policy iseeyou_backup_read_own on storage.objects for select to authenticated
      using (bucket_id = 'iseeyou-memory-backups' and (storage.foldername(name))[1] = (select auth.uid())::text);
  end if;
end $$;
-- Snapshots are immutable: clients receive no UPDATE or DELETE permission here.
commit;

select id, public, file_size_limit from storage.buckets where id='iseeyou-memory-backups';
select policyname, cmd, roles from pg_policies
where schemaname='storage' and tablename='objects'
  and policyname in ('iseeyou_backup_insert_own','iseeyou_backup_read_own');
