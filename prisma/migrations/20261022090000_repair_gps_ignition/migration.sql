SET lock_timeout = '5s';
-- GPS and ignition as Telematics fault categories (operator, 2026-10-22).
-- Same list as repairs.workflow.schema.ts FAULT_CATEGORIES.
ALTER TABLE "repair_report_items" DROP CONSTRAINT "repair_report_items_fault_category_check";
ALTER TABLE "repair_report_items"
    ADD CONSTRAINT "repair_report_items_fault_category_check"
    CHECK ("fault_category" IS NULL OR "fault_category" IN (
        'fuel_probe', 'tracker', 'gps', 'ignition', 'sensor',
        'engine', 'transmission', 'brakes', 'suspension_steering', 'tyres',
        'electrical', 'hydraulics', 'body', 'other'));
