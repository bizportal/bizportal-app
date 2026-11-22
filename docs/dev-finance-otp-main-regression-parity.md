# Signed DEV Finance OTP regression parity on official main

Test-only import of the previously PASS integrated OTP-to-Finance HTTP contract from `develop` to Hostinger-connected `main`. Main has stricter DEV Super Admin pinning: `BIZPORTAL_SIGNED_OTP_ACCOUNT_EMAIL_DEV` and `BIZPORTAL_SIGNED_OTP_ACCOUNT_ID_DEV` are mandatory for signed OTP in DEV. Synthetic tests set both to isolated invalid.example addresses and restore original environment values after each test.

No authentication runtime logic, OTP provider, customer data, Finance role, RLS, flags, API endpoint, or deployment is changed. Real OTP emails are mocked; no user email is sent. The feature flag remains OFF by default and production is untouched.

Nine focused integrated HTTP tests PASS, including issued cookie, tenant scope refusal, invalidation and tampering. Full API suite and CI required before merging to main. Related to #94.
