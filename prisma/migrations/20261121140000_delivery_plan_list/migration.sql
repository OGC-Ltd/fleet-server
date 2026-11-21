SET lock_timeout = '5s';

-- Which Deliveries report a Planner sheet is read on (operator, 2026-11-21:
-- "swap a planner from FG to VS and vice versa"). 'vs' = Van Sales, 'fg' =
-- Finished Goods; NULL = by the truck's fleet group, as every sheet was.
ALTER TABLE "delivery_plans" ADD COLUMN "list" TEXT;
ALTER TABLE "delivery_plans" ADD CONSTRAINT "delivery_plans_list_check" CHECK ("list" IS NULL OR "list" IN ('vs', 'fg'));
