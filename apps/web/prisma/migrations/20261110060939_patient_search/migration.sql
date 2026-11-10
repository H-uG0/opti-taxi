-- Patient search without accents and by phone (FLT-03): the extension unaccent and a search key
-- "searchText" (last name, first name, city, postal code, lowercase without accents, then the phone's digits in
-- national form), kept by a trigger on every insert or update, whatever writes the row; existing patients filled in.
CREATE EXTENSION IF NOT EXISTS unaccent;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "searchText" TEXT NOT NULL DEFAULT '';

CREATE OR REPLACE FUNCTION patient_search_text() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  digits text := regexp_replace(coalesce(NEW."phone", ''), '[^0-9]', '', 'g');
BEGIN
  -- +33 6 12 34 56 78 or 0033 6…: the national form 0612345678, as the search field reads it (lib/list-filters.ts).
  IF coalesce(NEW."phone", '') ~ '^\s*(\+|00)33' THEN
    digits := '0' || regexp_replace(digits, '^(00)?33', '');
  ELSIF length(digits) = 11 AND digits LIKE '33%' THEN
    digits := '0' || substr(digits, 3);
  END IF;
  NEW."searchText" := lower(unaccent(concat_ws(' ', NEW."lastName", NEW."firstName", NEW."city", NEW."postalCode")))
    || CASE WHEN digits <> '' THEN ' ' || digits ELSE '' END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER patient_search_text
  BEFORE INSERT OR UPDATE OF "lastName", "firstName", "city", "postalCode", "phone" ON "Patient"
  FOR EACH ROW EXECUTE FUNCTION patient_search_text();

-- Existing patients: the trigger fills their key (the update leaves every value as it is; updatedAt is not touched).
UPDATE "Patient" SET "lastName" = "lastName";
