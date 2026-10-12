-- ============================================================
-- Dr. Heriberto Valdivia — follow-up playbook (0068), v1 · 2026-10-12
--
-- Apply on prod AFTER migration 0068 and the Worker that reads it. Re-run to
-- update: it is a plain UPDATE of one jsonb column (the 0039 trigger keeps the
-- previous version in tenant_config_history). NULL the column to go back to the
-- flat ladder with no deploy.
--
-- Shape: stages.<NI|I|A|C> = { cadence (minutes, round 0 only), objective, angles }
--        byInterest.<services[].name> .<stage> = same, wins over `stages`.
-- Cadence rule of thumb: every NI/I touch lands inside Meta's 24 h window
-- (FB/IG stop delivering after it); the 0049 taper (days 2–3) is unchanged.
-- Angles are DIRECTIVES, not copy — the same convention as follow_up_angles.
-- Facts the nudge may state come from services[].description at send time, so
-- a price change in `services` propagates here with no edit.
-- ============================================================

UPDATE public.tenant_config
SET follow_up_playbook = $json$
{
  "stages": {
    "NI": {
      "cadence": [10, 60, 240, 1200],
      "objective": "Este lead sólo mandó el mensaje del anuncio y no ha conversado. Dale en UNA línea el dato que el anuncio prometía (qué incluye, precio o cómo funciona), tomado de \"Lo que le interesa\", y cierra con una pregunta cerrada facilísima sobre su caso. Todavía NO le pidas agendar ni le ofrezcas apartar lugar.",
      "angles": [
        "Ángulo de dato: da en una línea el precio o qué incluye el tratamiento que le interesa, y pregunta si es para una zona o inquietud en particular. Una sola pregunta.",
        "Ángulo de primera vez: pregunta en una línea si sería su primera vez con el tratamiento o ya lo conoce. Una sola pregunta, en neutro.",
        "Ángulo de quién: di en una línea que la valoración y la aplicación las hace el Dr. Valdivia en persona, y pregunta qué le gustaría mejorar. Una sola pregunta.",
        "Ángulo de duda: pregunta directo si le quedó alguna duda del anuncio que te la contesto por aquí. Una sola pregunta."
      ]
    },
    "I": {
      "cadence": [20, 180, 600, 1320],
      "objective": "Este lead ya vio el precio o la oferta y se detuvo ahí. Quítale en UNA línea la duda más común del tratamiento (si duele, cuánto dura, quién lo aplica, si es seguro) con datos de \"Lo que le interesa\", y pregunta si quiere saber si es candidata o candidato. No repitas el precio.",
      "angles": [
        "Ángulo de objeción: aborda en una línea la duda más común del tratamiento (dolor, duración o seguridad) con lo que diga la config, y pregunta si es eso lo que la detiene. Una sola pregunta.",
        "Ángulo de candidatura: di en una línea que en la valoración el doctor le dice con franqueza si el tratamiento es para ella o para él, y pregunta si quiere saberlo. Una sola pregunta.",
        "Ángulo de expectativa: di en una línea qué resultado se busca con el tratamiento según la config, y pregunta si eso es lo que ella o él quiere. Una sola pregunta.",
        "Ángulo de presupuesto: normaliza en una línea que muchas personas empiezan por una sola zona o sesión, y pregunta si le interesa saber cómo funciona así. Una sola pregunta."
      ]
    },
    "A": {
      "cadence": [15, 120, 480, 1200],
      "objective": "Este lead ya preguntó por su caso. Retoma SU situación con sus propias palabras (lo que contó: zona, molestia, meta), di en una línea qué pasa en la consulta o valoración, y pregunta si quiere que le aparten un lugar. No propongas días ni horas.",
      "angles": [
        "Ángulo de su caso: retoma en una línea lo que contó de su caso y pregunta si quiere que le aparten su valoración con el Dr. Valdivia. Una sola pregunta, en neutro.",
        "Ángulo de consulta: di en una línea que en la consulta el doctor revisa su caso y le arma un plan claro antes de decidir, y pregunta si le aparta un espacio. Una sola pregunta.",
        "Ángulo de duda pendiente: pregunta directo si le quedó alguna duda que no le dejó agendar. Una sola pregunta.",
        "Ángulo de agenda blanda: el consultorio agenda por la tarde; pregunta si le acomoda más al inicio o al final de la semana, sin dar horarios. Una sola pregunta."
      ]
    },
    "C": {
      "cadence": [10, 60, 300, 1080],
      "objective": "Este lead ya pidió horarios o dijo que sí quiere. Tu único trabajo es cerrar: alude a los horarios que ya vio SIN repetirlos (pudieron ocuparse) y pregunta si le aparta uno o le busca otro. Nada de información nueva, nada de precios.",
      "angles": [
        "Ángulo de cierre: pregunta en una línea si le aparta alguno de los horarios que ya le compartiste o le busca otro. Una sola pregunta, sin repetir día ni hora.",
        "Ángulo de agenda real: di en una línea que los espacios de la tarde se van rápido (NUNCA inventes cuántos quedan) y pregunta si prefiere que le aparte el suyo. Una sola pregunta.",
        "Ángulo de un paso: di en una línea que sólo falta que elija y el resto lo resuelve el equipo, y pregunta cuál le acomoda mejor de los que vio. Una sola pregunta.",
        "Ángulo de obstáculo: pregunta directo si hay algo que le impida tomar el horario, para ayudarle a resolverlo. Una sola pregunta."
      ]
    }
  },
  "byInterest": {
    "Botox": {
      "NI": {
        "angles": [
          "Ángulo de dato: di en una línea que el bótox va por zona con el precio de la config, y pregunta si le interesa para una zona en particular. Una sola pregunta.",
          "Ángulo de duele: di en una línea que es un piquete pequeño y la aplicación toma minutos, y pregunta si sería su primera vez. Una sola pregunta.",
          "Ángulo de quién: di en una línea que lo aplica el Dr. Valdivia en persona, y pregunta qué línea de expresión le gustaría suavizar. Una sola pregunta.",
          "Ángulo de fecha: pregunta en una línea si lo quiere para una ocasión en especial, para decirle si da tiempo de ver el efecto. Una sola pregunta."
        ]
      },
      "I": {
        "angles": [
          "Ángulo de duración: di en una línea cuánto suele durar el efecto según la config (si la config no lo dice, no lo afirmes) y pregunta si eso le acomoda. Una sola pregunta.",
          "Ángulo de natural: di en una línea que el objetivo es suavizar líneas y prevenir nuevas, con resultado natural, y pregunta si es lo que busca. Una sola pregunta.",
          "Ángulo de una zona: normaliza en una línea que muchas personas empiezan con una sola zona, y pregunta cuál le interesa. Una sola pregunta.",
          "Ángulo de candidatura: di en una línea que en la valoración el doctor le dice con franqueza si es candidata o candidato, y pregunta si quiere saberlo. Una sola pregunta."
        ]
      },
      "A": {
        "angles": [
          "Ángulo de su zona: retoma en una línea la zona o línea que mencionó y pregunta si quiere que le aparten su valoración, que es el mismo día de la aplicación si el doctor la ve candidata. Una sola pregunta.",
          "Ángulo de una sola visita: di en una línea que la valoración y la aplicación son el mismo día, y pregunta si le acomoda más temprano o más tarde dentro de la tarde, sin dar horas. Una sola pregunta.",
          "Ángulo de duda pendiente: pregunta directo si le quedó alguna duda que no le dejó agendar. Una sola pregunta.",
          "Ángulo de cero riesgo: di en una línea que el pago es en el consultorio el día de la cita, y pregunta si quiere apartar su espacio. Una sola pregunta."
        ]
      }
    },
    "Láser CO₂ Fraccionado": {
      "NI": {
        "angles": [
          "Ángulo de dato: di en una línea que el primer paso es la evaluación con el médico y lo que cuesta según la config, y pregunta si lo que quiere tratar son manchas, cicatrices o textura. Una sola pregunta.",
          "Ángulo de para qué: di en una línea para qué sirve el láser según la config, y pregunta qué le preocupa de su piel. Una sola pregunta.",
          "Ángulo de quién: di en una línea que la evaluación la hace el Dr. Valdivia en persona, y pregunta si sería su primera vez con láser. Una sola pregunta.",
          "Ángulo de duda: pregunta directo si le quedó alguna duda del anuncio que te la contesto por aquí. Una sola pregunta."
        ]
      },
      "I": {
        "angles": [
          "Ángulo de precio especial: di en una línea el precio por sesión si inicia dentro de los 14 días de su evaluación según la config, sin repetir el costo de la evaluación, y pregunta si quiere saber si es candidata o candidato. Una sola pregunta.",
          "Ángulo de recuperación: di en una línea que en la evaluación el doctor le explica cuántos días de cuidado necesita la piel, y pregunta si eso es lo que la detiene. Una sola pregunta.",
          "Ángulo de sesiones: di en una línea que el número de sesiones se define en la evaluación según su piel, y pregunta qué le gustaría mejorar. Una sola pregunta.",
          "Ángulo de candidatura: di en una línea que en la evaluación el doctor le dice con franqueza si el láser es para su caso, y pregunta si quiere saberlo. Una sola pregunta."
        ]
      },
      "A": {
        "angles": [
          "Ángulo de su piel: retoma en una línea lo que contó (manchas, cicatrices, textura) y pregunta si quiere que le aparten su evaluación con el Dr. Valdivia. Una sola pregunta, en neutro.",
          "Ángulo de evaluación: di en una línea que en la evaluación el doctor revisa su piel, confirma si el láser es para su caso y le arma un plan, y pregunta si le aparta un espacio. Una sola pregunta.",
          "Ángulo de duda pendiente: pregunta directo si le quedó alguna duda que no le dejó agendar. Una sola pregunta.",
          "Ángulo de agenda blanda: el consultorio agenda por la tarde; pregunta si le acomoda más al inicio o al final de la semana, sin dar horarios. Una sola pregunta."
        ]
      }
    },
    "Sculptra": {
      "NI": {
        "angles": [
          "Ángulo de dato: di en una línea qué es Sculptra y qué busca según la config, y pregunta si lo que le interesa es firmeza, volumen o flacidez. Una sola pregunta.",
          "Ángulo de plan: di en una línea que Sculptra trabaja por meses y no por sesión suelta, y pregunta si sería su primera vez con un bioestimulador. Una sola pregunta.",
          "Ángulo de quién: di en una línea que la valoración la hace el Dr. Valdivia en persona, y pregunta qué zona le preocupa. Una sola pregunta.",
          "Ángulo de duda: pregunta directo si le quedó alguna duda del anuncio que te la contesto por aquí. Una sola pregunta."
        ]
      },
      "I": {
        "angles": [
          "Ángulo de tiempo: di en una línea que el efecto se empieza a notar alrededor del tercer mes, así que entre antes empiece antes lo ve, y pregunta si quiere saber si es candidata o candidato. Una sola pregunta.",
          "Ángulo de candidatura: di en una línea que en la valoración el doctor le dice con franqueza si Sculptra es para su caso, y pregunta si quiere saberlo. Una sola pregunta.",
          "Ángulo de expectativa: di en una línea que el resultado es gradual y natural porque estimula su propio colágeno, y pregunta si es lo que busca. Una sola pregunta.",
          "Ángulo de presupuesto: di en una línea que en la valoración sale un plan con precio claro antes de decidir, y pregunta si le interesa conocerlo. Una sola pregunta."
        ]
      },
      "A": {
        "angles": [
          "Ángulo de su caso: retoma en una línea lo que contó y pregunta si quiere que le aparten su valoración con el Dr. Valdivia. Una sola pregunta, en neutro.",
          "Ángulo de plan: di en una línea que el primer paso es la valoración, donde se define cuántas sesiones necesita, y pregunta si le acomoda más temprano o más tarde dentro de la tarde, sin dar horas. Una sola pregunta.",
          "Ángulo de duda pendiente: pregunta directo si le quedó alguna duda que no le dejó agendar. Una sola pregunta.",
          "Ángulo de agenda blanda: el consultorio agenda por la tarde; pregunta si le acomoda más al inicio o al final de la semana, sin dar horarios. Una sola pregunta."
        ]
      }
    }
  }
}
$json$::jsonb
WHERE business_name = 'Dr. Heriberto Valdivia';
