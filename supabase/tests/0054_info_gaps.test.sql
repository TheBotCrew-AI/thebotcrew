-- ============================================================
-- Test — 0054: info gaps — candidatos, cola de extracción, acumulado y escalación.
--
-- Las cuatro invariantes que importan viven en SQL: qué conversación califica
-- (y cuál no), que el claim es atómico y respeta los 3 intentos, que el upsert
-- acumula sin reabrir un `closed` ni tocar un `dismissed`, y que la escalación
-- sólo ve lo que nadie contestó dentro de la ventana del tenant — una vez.
--
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--     -v ON_ERROR_STOP=1 -f supabase/tests/0054_info_gaps.test.sql
--
-- Corre dentro de una transacción y hace ROLLBACK: no deja rastro.
-- ============================================================

\set ON_ERROR_STOP on
BEGIN;

DO $$
DECLARE
  v_client  uuid;
  v_tenant  uuid;
  v_from    timestamptz := now() - interval '7 days';
  v_to      timestamptz := now();
  v_a uuid; v_b uuid; v_c uuid; v_d uuid; v_e uuid; v_f uuid; v_g uuid; v_h uuid;
  v_run     uuid;
  v_count   int;
  v_row     record;
  v_status  text;
  v_reasons text[];
BEGIN
  SELECT t.client_id, t.id INTO v_client, v_tenant
  FROM public.tenants t JOIN public.tenant_config tc ON tc.tenant_id = t.id
  WHERE t.is_active LIMIT 1;
  IF v_client IS NULL THEN
    RAISE EXCEPTION 'no hay tenants sembrados — corre `supabase db reset` primero';
  END IF;

  -- ---------- fixtures: ocho conversaciones ----------
  -- A: pending_info dentro de la ventana, sin humano → candidata (pending_info), escalable
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-A', 'contact-A', 'awaiting_human', now() - interval '2 days') RETURNING id INTO v_a;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_a, 'inbound', 'lead', '¿desde qué edad?', now() - interval '2 days');
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata, created_at)
  VALUES (v_client, v_a, 'pending_info', '{"question":"¿desde qué edad?"}', now() - interval '2 days');

  -- B: lead y luego humano → candidata (human_reply)
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-B', 'contact-B', 'active', now() - interval '1 day') RETURNING id INTO v_b;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at) VALUES
    (v_b, 'inbound', 'lead', '¿cómo se paga?', now() - interval '1 day' - interval '10 minutes'),
    (v_b, 'outbound', 'human_agent', 'Completo en la primera sesión', now() - interval '1 day');

  -- C: handed_off dentro de la ventana → candidata (handed_off)
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-C', 'contact-C', 'handed_off', now() - interval '3 days') RETURNING id INTO v_c;
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata, created_at)
  VALUES (v_client, v_c, 'status_changed', '{"from":"active","to":"handed_off"}', now() - interval '3 days');

  -- D: sólo lead y bot → NO candidata
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-D', 'contact-D', 'active', now() - interval '1 day') RETURNING id INTO v_d;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at) VALUES
    (v_d, 'inbound', 'lead', 'hola', now() - interval '1 day'),
    (v_d, 'outbound', 'bot', '¡Hola!', now() - interval '1 day');

  -- E: el humano abre la conversación (plantilla en frío), nunca hubo lead antes → NO candidata
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-E', 'contact-E', 'active', now() - interval '1 day') RETURNING id INTO v_e;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at)
  VALUES (v_e, 'outbound', 'human_agent', 'Hola, te escribimos de la clínica', now() - interval '1 day');

  -- F: pending_info FUERA de la ventana → NO candidata
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-F', 'contact-F', 'active', now() - interval '20 days') RETURNING id INTO v_f;
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata, created_at)
  VALUES (v_client, v_f, 'pending_info', '{"question":"vieja"}', now() - interval '20 days');

  -- G: pending_info hace 30h CON respuesta humana después → candidata, pero NO escalable
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-G', 'contact-G', 'active', now() - interval '1 day') RETURNING id INTO v_g;
  INSERT INTO public.messages (conversation_id, direction, sender_type, content, sent_at) VALUES
    (v_g, 'inbound', 'lead', '¿precio?', now() - interval '31 hours'),
    (v_g, 'outbound', 'human_agent', '$3,400', now() - interval '29 hours');
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata, created_at)
  VALUES (v_client, v_g, 'pending_info', '{"question":"¿precio?"}', now() - interval '30 hours');

  -- H: pending_info hace 1h, sin humano → candidata, todavía NO escalable (ventana 24h)
  INSERT INTO public.conversations (client_id, channel, ghl_conversation_id, ghl_contact_id, status, last_message_at)
  VALUES (v_client, 'whatsapp', 'ig-H', 'contact-H', 'active', now() - interval '1 hour') RETURNING id INTO v_h;
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata, created_at)
  VALUES (v_client, v_h, 'pending_info', '{"question":"reciente"}', now() - interval '1 hour');

  -- ---------- 1. candidatos ----------
  SELECT count(*) INTO v_count FROM public.app_info_gap_candidates(v_client, v_from, v_to)
  WHERE conversation_id IN (v_a, v_b, v_c, v_d, v_e, v_f, v_g, v_h);
  ASSERT v_count = 5, format('se esperaban 5 candidatas (A,B,C,G,H), hay %s', v_count);

  SELECT reasons INTO v_reasons FROM public.app_info_gap_candidates(v_client, v_from, v_to) WHERE conversation_id = v_a;
  ASSERT v_reasons = ARRAY['pending_info'], format('A: reasons = %s', v_reasons);
  SELECT reasons INTO v_reasons FROM public.app_info_gap_candidates(v_client, v_from, v_to) WHERE conversation_id = v_b;
  ASSERT v_reasons = ARRAY['human_reply'], format('B: reasons = %s', v_reasons);
  SELECT reasons INTO v_reasons FROM public.app_info_gap_candidates(v_client, v_from, v_to) WHERE conversation_id = v_c;
  ASSERT v_reasons = ARRAY['handed_off'], format('C: reasons = %s', v_reasons);
  SELECT reasons INTO v_reasons FROM public.app_info_gap_candidates(v_client, v_from, v_to) WHERE conversation_id = v_g;
  ASSERT v_reasons = ARRAY['pending_info', 'human_reply'], format('G: reasons = %s', v_reasons);
  SELECT count(*) INTO v_count FROM public.app_info_gap_candidates(v_client, v_from, v_to) WHERE conversation_id IN (v_d, v_e, v_f);
  ASSERT v_count = 0, 'D (solo bot), E (humano abre) y F (fuera de ventana) no deben calificar';

  -- ---------- 2. tenants con la función encendida + abrir corrida ----------
  UPDATE public.tenant_config SET info_gaps = '{"enabled": true, "min_candidates": 3}'::jsonb WHERE tenant_id = v_tenant;
  SELECT * INTO v_row FROM public.app_info_gap_tenants() WHERE tenant_id = v_tenant;
  ASSERT v_row.tenant_id IS NOT NULL AND v_row.has_open_run = false AND v_row.last_window_to IS NULL,
    'el tenant recién encendido debe aparecer sin corridas';

  v_run := public.app_open_info_gap_run(v_tenant, v_client, v_from, v_to, 60);
  SELECT candidates INTO v_count FROM public.info_gap_runs WHERE id = v_run;
  ASSERT v_count >= 5, format('la corrida debió encolar al menos 5, encoló %s', v_count);
  SELECT * INTO v_row FROM public.app_info_gap_tenants() WHERE tenant_id = v_tenant;
  ASSERT v_row.has_open_run = true, 'con la corrida abierta has_open_run debe ser true';
  SELECT count(*) INTO v_count FROM public.app_info_gap_finalizable_runs() WHERE id = v_run;
  ASSERT v_count = 0, 'una corrida con cola pendiente no es finalizable';

  -- ---------- 3. claim atómico ----------
  SELECT count(*) INTO v_count FROM public.app_claim_info_gap_extractions(2);
  ASSERT v_count = 2, format('el claim de 2 devolvió %s', v_count);
  SELECT count(*) INTO v_count FROM public.info_gap_extractions WHERE run_id = v_run AND status = 'processing' AND attempts = 1;
  ASSERT v_count = 2, 'las claimadas deben estar processing con attempts=1';
  SELECT * INTO v_row FROM public.info_gap_extractions WHERE run_id = v_run AND status = 'processing' LIMIT 1;

  -- reintento: pending otra vez, se vuelve a poder claimar; al tercer intento ya no
  PERFORM public.app_complete_info_gap_extraction(v_row.id, 'pending', NULL, 'openai 500');
  UPDATE public.info_gap_extractions SET status = 'done', result = '{"gaps":[]}' WHERE run_id = v_run AND status = 'processing';
  UPDATE public.info_gap_extractions SET status = 'done', result = '{"gaps":[]}' WHERE run_id = v_run AND status = 'pending' AND id <> v_row.id;
  SELECT count(*) INTO v_count FROM public.app_claim_info_gap_extractions(10);
  ASSERT v_count = 1, format('sólo la reintentable debía salir, salieron %s', v_count);
  PERFORM public.app_complete_info_gap_extraction(v_row.id, 'pending', NULL, 'openai 500');
  PERFORM public.app_claim_info_gap_extractions(10);
  PERFORM public.app_complete_info_gap_extraction(v_row.id, 'pending', NULL, 'openai 500');
  SELECT attempts INTO v_count FROM public.info_gap_extractions WHERE id = v_row.id;
  ASSERT v_count = 3, format('tras tres claims attempts debe ser 3, es %s', v_count);
  SELECT count(*) INTO v_count FROM public.app_claim_info_gap_extractions(10);
  ASSERT v_count = 0, 'con 3 intentos la fila no debe volver a salir';

  -- el claim trae el ghl_conversation_id: lo necesita llm_usage
  -- (la fila con 3 intentos sigue pending; la corrida no es finalizable hasta marcarla)
  SELECT count(*) INTO v_count FROM public.app_info_gap_finalizable_runs() WHERE id = v_run;
  ASSERT v_count = 0, 'con una fila pending (aunque agotada) la corrida no es finalizable';
  PERFORM public.app_complete_info_gap_extraction(v_row.id, 'failed', NULL, 'retries_exhausted');
  SELECT count(*) INTO v_count FROM public.app_info_gap_finalizable_runs() WHERE id = v_run;
  ASSERT v_count = 1, 'sin pending ni processing la corrida debe ser finalizable';

  -- ---------- 4. upsert acumulado ----------
  v_status := public.app_upsert_info_gap(v_tenant, 'formas_pago:sesion', 'formas_pago', 'pago por sesión', 'offering',
    '¿se paga todo junto?', 'Completo en la primera sesión', 'El paquete se paga completo…', now() - interval '2 days');
  ASSERT v_status = 'open', format('primer upsert debe devolver open, devolvió %s', v_status);
  v_status := public.app_upsert_info_gap(v_tenant, 'formas_pago:sesion', 'formas_pago', 'pago por sesión', 'offering',
    '¿puedo pagar por sesiones?', NULL, NULL, now() - interval '1 day');
  SELECT * INTO v_row FROM public.info_gaps WHERE tenant_id = v_tenant AND topic_key = 'formas_pago:sesion';
  ASSERT v_row.occurrences = 2, format('occurrences debe ser 2, es %s', v_row.occurrences);
  ASSERT jsonb_array_length(v_row.question_examples) = 2, 'la segunda pregunta debe agregarse';
  ASSERT jsonb_array_length(v_row.human_answers) = 1, 'un human_answer NULL no agrega nada';
  ASSERT v_row.suggested_text = 'El paquete se paga completo…', 'el texto sugerido original se conserva';
  ASSERT v_row.last_seen > v_row.first_seen, 'last_seen avanza';

  -- closed: sigue contando pero no se reabre
  UPDATE public.info_gaps SET status = 'closed' WHERE tenant_id = v_tenant AND topic_key = 'formas_pago:sesion';
  v_status := public.app_upsert_info_gap(v_tenant, 'formas_pago:sesion', 'formas_pago', 'pago por sesión', 'offering',
    'otra vez', NULL, NULL, now());
  ASSERT v_status = 'closed', format('un closed debe devolver closed, devolvió %s', v_status);
  SELECT occurrences, status INTO v_row FROM public.info_gaps WHERE tenant_id = v_tenant AND topic_key = 'formas_pago:sesion';
  ASSERT v_row.occurrences = 3 AND v_row.status = 'closed', 'closed cuenta y se queda closed';

  -- dismissed: no se toca
  UPDATE public.info_gaps SET status = 'dismissed' WHERE tenant_id = v_tenant AND topic_key = 'formas_pago:sesion';
  v_status := public.app_upsert_info_gap(v_tenant, 'formas_pago:sesion', 'formas_pago', 'pago por sesión', 'offering',
    'y otra', NULL, NULL, now());
  ASSERT v_status = 'dismissed', format('un dismissed debe devolver dismissed, devolvió %s', v_status);
  SELECT occurrences INTO v_count FROM public.info_gaps WHERE tenant_id = v_tenant AND topic_key = 'formas_pago:sesion';
  ASSERT v_count = 3, 'dismissed no acumula';

  -- ---------- 5. cerrar la corrida ----------
  PERFORM public.app_finish_info_gap_run(v_run, 'done', 4, 1);
  SELECT * INTO v_row FROM public.info_gap_runs WHERE id = v_run;
  ASSERT v_row.status = 'done' AND v_row.finished_at IS NOT NULL AND v_row.extracted = 4, 'finish no estampó la corrida';
  SELECT * INTO v_row FROM public.app_info_gap_tenants() WHERE tenant_id = v_tenant;
  ASSERT v_row.has_open_run = false AND v_row.last_window_to = v_to, 'la siguiente ventana empieza donde terminó ésta';

  -- ---------- 6. escalación ----------
  -- sin tag configurado: nada
  SELECT count(*) INTO v_count FROM public.app_unanswered_pending_info() WHERE conversation_id IN (v_a, v_g, v_h);
  ASSERT v_count = 0, 'sin pending_info_escalation_tag no se escala nada';

  UPDATE public.tenant_config SET pending_info_escalation_tag = 'dato-sin-respuesta' WHERE tenant_id = v_tenant;
  SELECT count(*) INTO v_count FROM public.app_unanswered_pending_info() WHERE conversation_id IN (v_a, v_g, v_h);
  ASSERT v_count = 1, format('sólo A debe escalar (G tuvo humano, H es reciente); salieron %s', v_count);
  SELECT * INTO v_row FROM public.app_unanswered_pending_info() WHERE conversation_id = v_a;
  ASSERT v_row.escalation_tag = 'dato-sin-respuesta' AND v_row.ghl_contact_id = 'contact-A'
     AND v_row.question = '¿desde qué edad?', 'la fila de escalación no trae tag/contacto/pregunta';

  -- ventana por tenant: con 48h, A (2 días = 48h exactas o más) sigue; con 72h ya no
  UPDATE public.tenant_config SET pending_info_escalation_hours = 72 WHERE tenant_id = v_tenant;
  SELECT count(*) INTO v_count FROM public.app_unanswered_pending_info() WHERE conversation_id = v_a;
  ASSERT v_count = 0, 'con ventana de 72h una pregunta de 48h aún no escala';
  UPDATE public.tenant_config SET pending_info_escalation_hours = NULL WHERE tenant_id = v_tenant;

  -- idempotente: una vez escalada, no vuelve a salir
  INSERT INTO public.bot_events (client_id, conversation_id, event_type, metadata)
  VALUES (v_client, v_a, 'pending_info_escalated', '{"tag":"dato-sin-respuesta"}');
  SELECT count(*) INTO v_count FROM public.app_unanswered_pending_info() WHERE conversation_id = v_a;
  ASSERT v_count = 0, 'una conversación ya escalada no debe volver a salir';

  -- opted_out nunca se escala
  UPDATE public.conversations SET status = 'opted_out' WHERE id = v_h;
  UPDATE public.bot_events SET created_at = now() - interval '2 days' WHERE conversation_id = v_h AND event_type = 'pending_info';
  SELECT count(*) INTO v_count FROM public.app_unanswered_pending_info() WHERE conversation_id = v_h;
  ASSERT v_count = 0, 'una conversación opted_out no se escala';

  -- ---------- 7. RLS cerrado en las tablas nuevas ----------
  SELECT bool_and(c.relrowsecurity) INTO v_row FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname IN ('info_gap_runs', 'info_gap_extractions', 'info_gaps', 'info_gap_reports');
  ASSERT v_row.bool_and = true, 'las cuatro tablas nuevas deben tener RLS activo';

  RAISE NOTICE '0054 ok';
END $$;

ROLLBACK;
