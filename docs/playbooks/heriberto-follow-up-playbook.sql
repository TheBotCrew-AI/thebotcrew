-- ============================================================
-- Dr. Heriberto Valdivia — follow-up playbook, v3 (0070: preset + exceptions) · 2026-10-12
--
-- Apply on prod AFTER migration 0070 and the Worker that reads `preset` /
-- `sequence`. The deployed Worker before 0070 ignores both keys, so applying
-- this early would run Heriberto on the flat ladder — wait for the deploy.
-- Re-run to update: it is a plain UPDATE of one jsonb column (the 0039 trigger
-- keeps the previous version in tenant_config_history). v2 (the hand-written
-- angle pools) is the previous history row if ever needed.
--
-- What runs: the platform preset `medicina-estetica` (core/playbooks/) — four
-- stages, each an ordered sequence of steps with cover marks; facts from
-- services[].description, files from media_assets (text until the files land,
-- `prueba` skipped without its before/after). The two overrides below are the
-- only clinic-specific lines worth keeping from v2:
--   · Láser I   the $3,500/session price if the treatment starts within 14 days
--               of the free evaluation (the oferta step), and the recovery days
--               as the que-esperar step.
--   · Botox A   evaluation and application on the SAME day, payment at the
--               clinic — the oferta step; the lead's zone as the que-esperar step.
-- Everything else (the doctor's name in `quien`, …) is the preset's generic
-- wording on purpose: one more override per stage is cheap when it earns it.
-- ============================================================

UPDATE public.tenant_config
SET follow_up_playbook = $json$
{
  "preset": "medicina-estetica",
  "byInterest": {
    "Láser CO₂ Fraccionado": {
      "I": {
        "sequence": [
          {
            "covers": "quien",
            "asset": "consultorio",
            "text": "Quién lo atiende: di en una línea que la evaluación y el láser los hace el Dr. Valdivia en persona, en el consultorio, y pregunta si lo que quiere tratar son manchas, cicatrices o textura. Una sola pregunta."
          },
          {
            "covers": "que-esperar",
            "asset": "que-esperar",
            "text": "Recuperación: di en una línea que el láser contempla días de cuidado de la piel y que el número de sesiones se define en la evaluación según su piel, y pregunta si eso es lo que la o lo detiene. Una sola pregunta."
          },
          {
            "covers": "prueba",
            "asset": "antes-despues",
            "text": "Resultados: di en una línea que es un caso real del consultorio con láser, sin prometer el mismo resultado, y pregunta si eso es lo que busca. Una sola pregunta."
          },
          {
            "covers": "oferta",
            "text": "Precio especial: di en una línea el precio por sesión si inicia el tratamiento dentro de los 14 días de su evaluación según \"Lo que le interesa\", que la evaluación es sin costo, y pregunta si quiere saber si es candidata o candidato. No repitas el precio normal. Una sola pregunta."
          }
        ]
      }
    },
    "Botox": {
      "A": {
        "sequence": [
          {
            "covers": "que-esperar",
            "asset": "que-esperar",
            "text": "Su zona: retoma en una línea la zona o línea de expresión que mencionó y di que el bótox suaviza esas líneas con resultado natural, y pregunta si quiere que le aparten su valoración con el Dr. Valdivia. Una sola pregunta, en neutro."
          },
          {
            "covers": "prueba",
            "asset": "antes-despues",
            "text": "Resultados: di en una línea que es un caso real del consultorio con bótox en una zona parecida, sin prometer el mismo resultado, y pregunta si quiere que le aparten su valoración. Una sola pregunta."
          },
          {
            "covers": "oferta",
            "text": "Una sola visita: di en una línea que la valoración y la aplicación son el mismo día si el doctor la o lo ve candidato, y que el pago es en el consultorio el día de la cita; pregunta si le aparta un espacio. Sin días ni horas. Una sola pregunta."
          },
          {
            "covers": "cierre",
            "text": "Cierre suave: di en una línea que sólo falta que diga que sí para apartarle su lugar, y pregunta si se lo apartan. Sin días ni horas. Una sola pregunta."
          }
        ]
      }
    }
  }
}
$json$::jsonb
WHERE business_name = 'Dr. Heriberto Valdivia';
