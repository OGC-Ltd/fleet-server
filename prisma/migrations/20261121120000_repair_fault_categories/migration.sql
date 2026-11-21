SET lock_timeout = '5s';

-- One ControlTech job per unit for every telematics fault a flag names
-- (operator, 2026-11-21): a flag ticking fuel probe, GPS and tracker is one
-- job with one ticket, not three. `fault_category` stays the job's lead
-- category (it keys the open-job index and the probe/unit split); this holds
-- every category the job covers, the lead one included. Empty for jobs made
-- before it, which cover their `fault_category` alone.
ALTER TABLE "repair_report_items" ADD COLUMN "fault_categories" TEXT[] NOT NULL DEFAULT '{}';
