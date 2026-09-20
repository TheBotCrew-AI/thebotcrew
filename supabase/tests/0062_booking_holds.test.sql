-- ============================================================
-- Test — 0062: las transiciones de un apartado viven en SQL y son atómicas.
--
-- `pnpm test:unit` mockea db/queries, así que sólo prueba qué hace el Worker con
-- la respuesta del RPC. Lo que importa aquí es la respuesta misma: un webhook de
-- Stripe repetido NO puede pagar dos veces, el cron NO puede vencer un apartado
-- que acaba de pagarse, y un pago tardío queda marcado aparte en vez de
-- resucitar una cita ya cancelada.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0062_booking_holds.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client   uuid;
  v_tenant   uuid;
  v_conv     uuid;
  v_hold     uuid;
  v_hold2    uuid;
  v_hold3    uuid;
  v_ok       boolean;
  v_status   text;
  v_outcome  text;
  v_channel  text;
  v_loc      text;
  v_claimed  int;
  v_rows     int;
BEGIN
  SELECT t.client_id, t.id INTO v_client, v_tenant
  FROM public.tenants t WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- 0. la columna nace NULL (feature apagada para todos) ----------
  ASSERT (SELECT bool_and(booking_payment IS NULL) FROM public.tenant_config),
    'booking_payment debe nacer NULL: cobrar por cita es un cambio de oferta, no se prende solo';

  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, contact_phone, status)
  VALUES (v_client, 'whatsapp', 'test-0062-conv', 'test-0062-contact', '+526641112233', 'completed')
  RETURNING id INTO v_conv;

  -- ---------- 1. crear ----------
  v_hold := public.app_create_booking_hold(
    v_client, 'test-0062-conv', 'test-0062-contact', 'test-0062-appt-1', 'Consulta',
    now() + interval '3 days', 50000, 'MXN', 'cs_test_0062_1', 'https://checkout.stripe.com/c/pay/cs_test_0062_1',
    now() + interval '24 hours');
  ASSERT v_hold IS NOT NULL, 'app_create_booking_hold debió devolver un id';
  SELECT status, currency INTO v_status, v_channel FROM public.booking_holds WHERE id = v_hold;
  ASSERT v_status = 'pending', format('un hold nuevo debe ser pending, es %s', v_status);
  ASSERT v_channel = 'mxn', 'la moneda se guarda en minúsculas (Stripe la exige así)';

  -- ---------- 2. pagar: pending → paid, con el contexto que el webhook necesita ----------
  SELECT outcome, channel, ghl_location_id INTO v_outcome, v_channel, v_loc
  FROM public.app_settle_hold_payment('cs_test_0062_1', 'pi_0062_1');
  ASSERT v_outcome = 'paid', format('el primer pago debió ser paid, fue %s', v_outcome);
  ASSERT v_channel = 'whatsapp', 'settle debe traer el canal de la conversación';
  ASSERT v_loc IS NOT NULL, 'settle debe traer el ghl_location_id del tenant';

  -- ---------- 3. el mismo webhook otra vez: nada ----------
  SELECT count(*) INTO v_rows FROM public.app_settle_hold_payment('cs_test_0062_1', 'pi_0062_1');
  ASSERT v_rows = 0, 'un webhook repetido sobre un hold pagado no debe devolver fila';

  -- ---------- 4. el cron no toca lo pagado ni lo que aún no vence ----------
  v_hold2 := public.app_create_booking_hold(
    v_client, 'test-0062-conv', 'test-0062-contact', 'test-0062-appt-2', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_test_0062_2', 'https://checkout.stripe.com/c/pay/cs_test_0062_2',
    now() + interval '1 hour');
  SELECT count(*) INTO v_claimed FROM public.app_claim_expired_holds(20);
  ASSERT v_claimed = 0, format('nada está vencido todavía, el claim devolvió %s', v_claimed);

  -- ---------- 5. vencido: pending → expiring → expired ----------
  UPDATE public.booking_holds SET due_at = now() - interval '1 minute' WHERE id = v_hold2;
  SELECT count(*) INTO v_claimed FROM public.app_claim_expired_holds(20);
  ASSERT v_claimed = 1, format('debió reclamar exactamente 1 hold vencido, reclamó %s', v_claimed);
  SELECT status INTO v_status FROM public.booking_holds WHERE id = v_hold2;
  ASSERT v_status = 'expiring', format('tras el claim debe estar expiring, está %s', v_status);

  -- un segundo tick no lo vuelve a reclamar
  SELECT count(*) INTO v_claimed FROM public.app_claim_expired_holds(20);
  ASSERT v_claimed = 0, 'un hold en expiring no se reclama dos veces';

  v_ok := public.app_finish_hold(v_hold2, 'expired');
  ASSERT v_ok, 'expiring → expired debió devolver true';
  v_ok := public.app_finish_hold(v_hold2, 'expired');
  ASSERT NOT v_ok, 'expired → expired otra vez debe devolver false (doble llamada)';

  -- ---------- 6. pago tardío: expired → paid_late, no paid ----------
  SELECT outcome INTO v_outcome FROM public.app_settle_hold_payment('cs_test_0062_2', 'pi_0062_2');
  ASSERT v_outcome = 'paid_late', format('un pago sobre un hold vencido es paid_late, fue %s', v_outcome);

  -- ---------- 7. la carrera: el cron reclama, el pago llega, el cron ya no puede vencerlo ----------
  v_hold3 := public.app_create_booking_hold(
    v_client, 'test-0062-conv', 'test-0062-contact', 'test-0062-appt-3', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_test_0062_3', 'https://checkout.stripe.com/c/pay/cs_test_0062_3',
    now() - interval '1 minute');
  PERFORM public.app_claim_expired_holds(20);
  SELECT outcome INTO v_outcome FROM public.app_settle_hold_payment('cs_test_0062_3', 'pi_0062_3');
  ASSERT v_outcome = 'paid_late', 'un pago que cae mientras el cron libera el lugar es paid_late';
  v_ok := public.app_finish_hold(v_hold3, 'expired');
  ASSERT NOT v_ok, 'el cron no puede marcar expired un hold que ya se pagó (tarde) — debe leer false y no cancelar';

  -- ---------- 8. cancelación del lead: pending → cancelled; luego un pago no entra ----------
  v_hold := public.app_create_booking_hold(
    v_client, 'test-0062-conv', 'test-0062-contact', 'test-0062-appt-4', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_test_0062_4', 'https://checkout.stripe.com/c/pay/cs_test_0062_4',
    now() + interval '24 hours');
  v_ok := public.app_finish_hold(v_hold, 'cancelled');
  ASSERT v_ok, 'pending → cancelled debió devolver true';
  SELECT count(*) INTO v_rows FROM public.app_settle_hold_payment('cs_test_0062_4', 'pi_0062_4');
  ASSERT v_rows = 0, 'un hold cancelado no se paga (la sesión de Stripe ya se expiró del lado del Worker)';

  -- ---------- 9. reintento del cron: expiring → pending ----------
  v_hold := public.app_create_booking_hold(
    v_client, 'test-0062-conv', 'test-0062-contact', 'test-0062-appt-5', 'Consulta',
    now() + interval '3 days', 50000, 'mxn', 'cs_test_0062_5', 'https://checkout.stripe.com/c/pay/cs_test_0062_5',
    now() - interval '1 minute');
  PERFORM public.app_claim_expired_holds(20);
  v_ok := public.app_finish_hold(v_hold, 'pending');
  ASSERT v_ok, 'expiring → pending (GHL falló, reintentar) debió devolver true';
  SELECT count(*) INTO v_claimed FROM public.app_claim_expired_holds(20);
  ASSERT v_claimed = 1, 'devuelto a pending, el siguiente tick lo vuelve a reclamar';

  -- ---------- 10. un estado inventado revienta, no pasa en silencio ----------
  BEGIN
    PERFORM public.app_finish_hold(v_hold, 'paid');
    RAISE EXCEPTION 'app_finish_hold aceptó "paid" — pagar es de settle, no de finish';
  EXCEPTION
    WHEN raise_exception THEN
      IF SQLERRM LIKE '%unsupported target status%' THEN NULL; ELSE RAISE; END IF;
  END;

  -- ---------- 11. mover: la cita cambia de hora, el hold sigue ----------
  v_ok := public.app_move_hold('test-0062-appt-5', now() + interval '5 days');
  ASSERT v_ok, 'app_move_hold sobre un hold existente devuelve true';
  v_ok := public.app_move_hold('no-such-appt', now());
  ASSERT NOT v_ok, 'app_move_hold sobre una cita sin hold devuelve false';

  -- ---------- 12. los eventos nuevos pasan el CHECK; el kind de CAPI también ----------
  INSERT INTO public.bot_events (client_id, event_type, metadata)
  VALUES (v_client, 'booking_paid', '{}'::jsonb), (v_client, 'hold_expired', '{}'::jsonb),
         (v_client, 'hold_created', '{}'::jsonb), (v_client, 'hold_released', '{}'::jsonb),
         (v_client, 'booking_paid_late', '{}'::jsonb), (v_client, 'payment_error', '{}'::jsonb);
  ASSERT public.app_enqueue_capi_event(v_client, 'test-0062-conv', 'appointment_paid', 'Purchase',
    'test-0062-conv:appointment_paid', '{"messaging_channel":"whatsapp","user_data":{}}'::jsonb),
    'appointment_paid debe pasar el CHECK de capi_events.kind';

  -- ---------- 13. el reporte suma lo pagado (normal + tardío) ----------
  SELECT paid_count, paid_late_count INTO v_rows, v_claimed
  FROM public.paid_bookings_monthly WHERE client_id = v_client AND month = date_trunc('month', now());
  ASSERT v_rows = 3, format('paid_bookings_monthly debió contar 3 pagos este mes, cuenta %s', v_rows);
  ASSERT v_claimed = 2, format('de ellos 2 tardíos, cuenta %s', v_claimed);

  RAISE NOTICE '0062 ok';
END $$;

ROLLBACK;
