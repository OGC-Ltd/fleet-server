-- SUKARI's gate, supplied by the operator.
--
-- Held here rather than typed into the box so the value is tracked, reviewable
-- and redeployable — the same reason the hub is measured by a committed script
-- instead of set by hand.
--
-- Independently corroborated by telemetry: clustering every outbound halt of
-- 30 s or more across 68 departures puts 65% of them within 13 m of this point,
-- halting for a median of 157 s. That is the weigh-out. Re-run that clustering
-- if the site changes and this needs revisiting.
--
-- 60 m radius: comfortably clears the 13-20 m halt spread while staying well
-- short of the next halt cluster 83 m further in.
UPDATE "organisations"
   SET "gate_lat"      = -0.821842,
       "gate_lng"      = 34.381860,
       "gate_radius_m" = 60
 WHERE "code" = 'SUKARI';
