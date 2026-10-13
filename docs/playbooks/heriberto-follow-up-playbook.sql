-- ============================================================
-- Dr. Heriberto Valdivia — follow-up playbook, v4 (0070 preset + exceptions, short-form directives) · 2026-10-12
--
-- Apply on prod AFTER migration 0070 and the Worker that reads `preset` /
-- `sequence`. The deployed Worker before 0070 ignores both keys, so applying
-- this early would run Heriberto on the flat ladder — wait for the deploy.
-- Re-run to update: it is a plain UPDATE of one jsonb column (the 0039 trigger
-- keeps the previous version in tenant_config_history). v3 (same steps, the
-- "di en una línea X y pregunta Y" directives that produced four nudges of the
-- same silhouette) and v2 (the hand-written angle pools) are the previous
-- history rows if ever needed.
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
            "text": "Quién lo atiende: SOLO pregunta si lo que quiere tratar son manchas, cicatrices o textura, mencionando de paso que la evaluación y el láser los hace el Dr. Valdivia en persona."
          },
          {
            "covers": "que-esperar",
            "asset": "que-esperar",
            "text": "Recuperación: que el láser contempla unos días de cuidado de la piel, en media línea; y pregunta si eso es lo que la o lo detiene."
          },
          {
            "covers": "prueba",
            "asset": "antes-despues",
            "text": "Resultados: que es un caso real del consultorio con láser, sin prometer el mismo resultado; y pregunta si eso es lo que busca."
          },
          {
            "covers": "oferta",
            "text": "Precio especial: el precio por sesión si inicia dentro de los 14 días de su evaluación, según \"Lo que le interesa\", en una frase corta; y pregunta si quiere saber si es candidata o candidato. Sin el precio normal, sin explicar la evaluación."
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
            "text": "Su zona: nombra la zona o línea de expresión que mencionó, con sus palabras, y pregunta si le aparta su valoración con el Dr. Valdivia. En neutro. Sin explicar el bótox."
          },
          {
            "covers": "prueba",
            "asset": "antes-despues",
            "text": "Resultados: que es un caso real del consultorio con bótox en una zona parecida, sin prometer el mismo resultado; y pregunta si le aparta su valoración."
          },
          {
            "covers": "oferta",
            "text": "Una sola visita: que valoración y aplicación son el mismo día si el doctor la o lo ve candidato, en media línea; y pregunta si le aparta un espacio. Sin el pago, sin días ni horas."
          },
          {
            "covers": "cierre",
            "text": "Cierre suave: SOLO la pregunta: si le aparta su lugar. Sin días ni horas, sin dato antes."
          }
        ]
      }
    }
  }
}
$json$::jsonb
WHERE business_name = 'Dr. Heriberto Valdivia';
