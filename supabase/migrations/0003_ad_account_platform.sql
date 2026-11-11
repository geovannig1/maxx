-- ad_accounts: which ad platform an account belongs to, and the account's country.
--
-- platform: the registered ad-platform id the app resolves the account's platform from
-- (src/lib/platforms/account-platform.ts). Every existing row is a Meta account, so the column is
-- NOT NULL with default 'meta'. The CHECK lists exactly the platforms registered in
-- src/lib/platforms/registry.ts; registering a second platform widens it in a new migration.
--
-- country: optional ISO 3166-1 alpha-2 code (upper case). When set, the phone calling code added to
-- national numbers for conversions matching comes from it; when null, configuration decides
-- (CONVERSIONS_PHONE_COUNTRY_CODE), exactly as before. Nothing fills it automatically.
--
-- Privileges are unchanged: the table keeps its service-role-only grant and policy, which cover the new
-- columns; anon and authenticated have no privilege on the table. No function, trigger or view reads
-- these columns.

ALTER TABLE public.ad_accounts
  ADD COLUMN platform text DEFAULT 'meta'::text NOT NULL,
  ADD COLUMN country text;

ALTER TABLE public.ad_accounts
  ADD CONSTRAINT ad_accounts_platform_check CHECK ((platform = ANY (ARRAY['meta'::text]))),
  ADD CONSTRAINT ad_accounts_country_check CHECK (((country IS NULL) OR (country ~ '^[A-Z]{2}$'::text)));

COMMENT ON COLUMN public.ad_accounts.platform IS 'Registered ad-platform id of this account (src/lib/platforms/registry.ts).';
COMMENT ON COLUMN public.ad_accounts.country IS 'ISO 3166-1 alpha-2 country of the account, or null. Sets the default phone calling code for conversions matching.';
