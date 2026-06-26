-- ============================================================
-- Migration 0019 — fix cartesian fan-out in reporting views
-- The Bot Crew · Agent Platform
--
-- The original client_summary / monthly_activity (0001) joined multiple
-- independent one-to-many branches (conversations→messages, appointments,
-- bot_events) in a single flat query and deduplicated with COUNT(DISTINCT).
-- Results were correct but the intermediate row set was the cartesian product
-- of those branches (hundreds of millions of rows on real data), so the views
-- timed out / never loaded.
--
-- Fix: aggregate each branch separately (one row per client/conversation)
-- BEFORE joining. Same columns, same values, ~26ms instead of a timeout.
-- ============================================================

CREATE OR REPLACE VIEW public.client_summary AS
WITH conv_agg AS (
  SELECT client_id,
    count(*)                                                AS total_conversations,
    count(*) FILTER (WHERE handoff_triggered)               AS handoffs,
    count(*) FILTER (WHERE outcome = 'appointment_booked')  AS booked_outcomes,
    count(*) FILTER (WHERE outcome IS NOT NULL)             AS decided_outcomes
  FROM conversations
  GROUP BY client_id
),
msg_agg AS (
  SELECT conv.client_id, count(m.id) AS total_messages
  FROM conversations conv
  JOIN messages m ON m.conversation_id = conv.id
  GROUP BY conv.client_id
),
appt_agg AS (
  SELECT client_id,
    count(*) FILTER (WHERE action = 'booked')      AS appointments_booked,
    count(*) FILTER (WHERE action = 'rescheduled') AS appointments_rescheduled,
    count(*) FILTER (WHERE action = 'cancelled')   AS appointments_cancelled
  FROM appointments
  GROUP BY client_id
),
event_agg AS (
  SELECT client_id,
    count(*) FILTER (WHERE event_type = 'out_of_hours_handled') AS out_of_hours
  FROM bot_events
  GROUP BY client_id
)
SELECT
  c.id,
  c.name,
  c.niche,
  coalesce(cv.total_conversations, 0)      AS total_conversations,
  coalesce(mg.total_messages, 0)           AS total_messages,
  coalesce(ap.appointments_booked, 0)      AS appointments_booked,
  coalesce(ap.appointments_rescheduled, 0) AS appointments_rescheduled,
  coalesce(ap.appointments_cancelled, 0)   AS appointments_cancelled,
  coalesce(cv.handoffs, 0)                 AS handoffs,
  coalesce(ev.out_of_hours, 0)             AS out_of_hours,
  round(cv.booked_outcomes::numeric / nullif(cv.decided_outcomes, 0) * 100, 1) AS booking_rate_pct
FROM clients c
LEFT JOIN conv_agg  cv ON cv.client_id = c.id
LEFT JOIN msg_agg   mg ON mg.client_id = c.id
LEFT JOIN appt_agg  ap ON ap.client_id = c.id
LEFT JOIN event_agg ev ON ev.client_id = c.id;

CREATE OR REPLACE VIEW public.monthly_activity AS
WITH msg_per_conv AS (
  SELECT conversation_id, count(*) AS msgs
  FROM messages
  GROUP BY conversation_id
),
appt_per_conv AS (
  SELECT conversation_id, count(*) FILTER (WHERE action = 'booked') AS bookings
  FROM appointments
  GROUP BY conversation_id
)
SELECT
  date_trunc('month', conv.started_at)      AS month,
  c.name                                    AS client,
  count(*)                                  AS conversations,
  coalesce(sum(mpc.msgs), 0)::bigint        AS messages,
  coalesce(sum(apc.bookings), 0)::bigint    AS bookings
FROM conversations conv
JOIN clients c ON c.id = conv.client_id
LEFT JOIN msg_per_conv  mpc ON mpc.conversation_id = conv.id
LEFT JOIN appt_per_conv apc ON apc.conversation_id = conv.id
GROUP BY 1, 2
ORDER BY 1 DESC, 3 DESC;
