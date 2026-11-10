-- Patient search key (FLT-03, review): the trigger function patient_search_text() no longer depends on the session's
-- search_path. It runs with the schema of the extension unaccent (public here, or a schema the host chose for its
-- extensions), so a data-only restore (search_path '') or such a schema no longer breaks every insert or update of a patient.
DO $$
DECLARE
  extension_schema text;
BEGIN
  SELECT n.nspname INTO STRICT extension_schema
  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
  WHERE e.extname = 'unaccent';
  EXECUTE format('ALTER FUNCTION patient_search_text() SET search_path = %I, pg_temp', extension_schema);
END
$$;
