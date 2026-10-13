/**
 * Platform default playbook for aesthetic-medicine clinics (0070).
 *
 * `tenant_config.follow_up_playbook = {"preset": "medicina-estetica"}` runs this
 * whole arc with zero tenant text: every fact the nudges state comes from the
 * tenant's `services[].description` ("Lo que le interesa" in the prompt) and
 * every file from its `media_assets` rows — a step whose file the tenant lacks
 * goes out as text (except `prueba`, which is skipped). Anything the tenant
 * writes on top (`stages`, `byInterest`) overrides this per stage and field.
 *
 * The arc per stage, inside Meta's 24 h window for NI/I:
 *   NI  precio → quien → que-esperar → oferta       (the lead has nothing in hand)
 *   I   quien → que-esperar → prueba → oferta       (saw the price, stopped)
 *   A   que-esperar → prueba → oferta → cierre      (asked about their case)
 *   C   cierre → duda → cierre → cierre             (asked for slots; only close)
 *
 * Directives are deliberately generic: no doctor's name, no clinic-specific
 * promise. Shape rules (one line + one closed question, no dates) live in the
 * reactivation prompt, not here.
 */

export const MEDICINA_ESTETICA_PLAYBOOK = {
  stages: {
    NI: {
      cadence: [10, 60, 240, 1200],
      objective:
        'Este lead sólo mandó el mensaje del anuncio y no ha conversado. Dale en UNA línea el dato que el anuncio prometía (qué incluye, precio o cómo funciona), tomado de "Lo que le interesa", y cierra con una pregunta cerrada facilísima sobre su caso. Todavía NO le pidas agendar ni le ofrezcas apartar lugar.',
      sequence: [
        {
          covers: 'precio',
          asset: 'precios',
          text: 'Dato del anuncio: di en una línea el precio o qué incluye el tratamiento, tomado de "Lo que le interesa", y pregunta si es para una zona o inquietud en particular. Una sola pregunta.',
        },
        {
          covers: 'quien',
          asset: 'consultorio',
          text: 'Quién lo atiende: di en una línea que la valoración y el tratamiento los hace el médico en persona, en el consultorio, y pregunta qué le gustaría mejorar. Una sola pregunta.',
        },
        {
          covers: 'que-esperar',
          asset: 'que-esperar',
          text: 'Qué esperar: di en una línea qué se siente, cuánto dura o qué cuidados pide el tratamiento, con datos de "Lo que le interesa" (si no los hay, el resultado que busca), y pregunta si sería su primera vez. Una sola pregunta.',
        },
        {
          covers: 'oferta',
          text: 'Último toque del día: di en una línea que el primer paso es la valoración con el médico, donde le dice con franqueza si es candidata o candidato, y pregunta si quiere saberlo. Si "Lo que le interesa" dice que la valoración es sin costo, dilo; si no lo dice, no afirmes nada sobre su costo. Una sola pregunta.',
        },
      ],
    },
    I: {
      cadence: [20, 180, 600, 1320],
      objective:
        'Este lead ya vio el precio o la oferta y se detuvo ahí. Quítale en UNA línea la duda más común del tratamiento (si duele, cuánto dura, quién lo aplica, si es seguro) con datos de "Lo que le interesa", y pregunta si quiere saber si es candidata o candidato. No repitas el precio.',
      sequence: [
        {
          covers: 'quien',
          asset: 'consultorio',
          text: 'Quién lo atiende: di en una línea que la valoración y el tratamiento los hace el médico en persona, en el consultorio, y pregunta qué le gustaría mejorar. Una sola pregunta.',
        },
        {
          covers: 'que-esperar',
          asset: 'que-esperar',
          text: 'Qué esperar: di en una línea qué se siente, cuánto dura o qué cuidados pide el tratamiento, con datos de "Lo que le interesa" (si no los hay, el resultado que busca), y pregunta si eso le acomoda. Una sola pregunta.',
        },
        {
          covers: 'prueba',
          asset: 'antes-despues',
          text: 'Resultados: di en una línea que es un caso real de la clínica con el mismo tratamiento, sin prometer el mismo resultado, y pregunta si eso es lo que busca. Una sola pregunta.',
        },
        {
          covers: 'oferta',
          text: 'Último toque del día: di en una línea que en la valoración el médico le dice con franqueza si el tratamiento es para su caso, y pregunta si quiere saberlo. Si "Lo que le interesa" dice que la valoración es sin costo, dilo; si no lo dice, no afirmes nada sobre su costo. Una sola pregunta.',
        },
      ],
    },
    A: {
      cadence: [15, 120, 480, 1200],
      objective:
        'Este lead ya preguntó por su caso. Retoma SU situación con sus propias palabras (lo que contó: zona, molestia, meta), di en una línea qué pasa en la consulta o valoración, y pregunta si quiere que le aparten un lugar. No propongas días ni horas.',
      sequence: [
        {
          covers: 'que-esperar',
          asset: 'que-esperar',
          text: 'Su caso: retoma en una línea lo que contó (zona, molestia, meta) y di qué puede esperar del tratamiento en su caso con datos de "Lo que le interesa"; pregunta si quiere que le aparten su valoración. Una sola pregunta, en neutro.',
        },
        {
          covers: 'prueba',
          asset: 'antes-despues',
          text: 'Resultados: di en una línea que es un caso real de la clínica parecido a lo que contó, sin prometer el mismo resultado, y pregunta si quiere que le aparten su valoración. Una sola pregunta.',
        },
        {
          covers: 'oferta',
          text: 'Valoración: di en una línea que en la valoración el médico revisa su caso y le arma un plan claro antes de decidir, y pregunta si le aparta un espacio. Si "Lo que le interesa" dice que la valoración es sin costo, dilo. Una sola pregunta.',
        },
        {
          covers: 'cierre',
          text: 'Cierre suave: di en una línea que sólo falta que diga que sí para apartarle su lugar, y pregunta si se lo apartan. Sin días ni horas. Una sola pregunta.',
        },
      ],
    },
    C: {
      cadence: [10, 60, 300, 1080],
      objective:
        'Este lead ya pidió horarios o dijo que sí quiere. Tu único trabajo es cerrar: alude a los horarios que ya vio SIN repetirlos (pudieron ocuparse) y pregunta si le aparta uno o le busca otro. Nada de información nueva, nada de precios.',
      sequence: [
        {
          covers: 'cierre',
          text: 'Cierre: pregunta en una línea si le aparta alguno de los horarios que ya le compartiste o le busca otro. Sin repetir día ni hora. Una sola pregunta.',
        },
        {
          covers: 'duda',
          text: 'Obstáculo: pregunta directo si hay algo que le impida tomar el horario, para ayudarle a resolverlo. Una sola pregunta.',
        },
        {
          covers: 'cierre',
          text: 'Un paso: di en una línea que sólo falta que elija y el resto lo resuelve el equipo, y pregunta cuál le acomoda mejor de los que vio, sin repetirlos. Una sola pregunta.',
        },
        {
          covers: 'cierre',
          text: 'Cierre: pregunta en una línea si le aparta alguno de los horarios que ya le compartiste o le busca otro. Sin repetir día ni hora. Una sola pregunta.',
        },
      ],
    },
  },
} as const;
