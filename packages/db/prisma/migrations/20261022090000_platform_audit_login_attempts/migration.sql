-- P6-14: superuser logins are audited, failures included (docs/SECURITY/02 §9).
--
-- A failed login with an email that matches no superuser has no superuser to
-- point at, and inventing one would be worse than recording none. Relaxing
-- NOT NULL is additive (P12): every existing row and every existing writer
-- stays valid; only the new "unknown email" failure row uses NULL.
ALTER TABLE "platform"."platform_audit_logs" ALTER COLUMN "superuser_id" DROP NOT NULL;
