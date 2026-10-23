-- V8 (additive): staff display labels.
--
-- Two independent overrides, both presentation-only and both nullable so `null`
-- means "no override":
--
--   role_permission_classes.label       -- per-role display name, so one role bound
--                                          to `administrator` can read "Server
--                                          Leads" while the others keep their own.
--   permission_classes."displayName"    -- server-wide rename of a power level.
--
-- Neither touches `permissions`. A label is a UI concern; wiring it into the
-- class's `name` would let a rename ship alongside a stored permission list and
-- silently change what the class grants.

ALTER TABLE "role_permission_classes" ADD COLUMN "label" TEXT;

ALTER TABLE "permission_classes" ADD COLUMN "displayName" TEXT;
