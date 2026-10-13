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
 * promise. Shape rules (≤160 chars, one closed question, no dates, how a nudge
 * opens) live in the reactivation prompt, not here — but the SILHOUETTE varies on
 * purpose from step to step: some are "SOLO la pregunta", some "a short fact and
 * the question". Four touches cut from the same mould (reaction + fact + question)
 * are what read as a program, whatever the words.
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
          text: 'Dato del anuncio: el precio o qué incluye, tomado de "Lo que le interesa", en una frase corta; y pregunta para qué zona o inquietud lo quiere.',
        },
        {
          covers: 'quien',
          asset: 'consultorio',
          text: 'Quién lo atiende: que el médico lo hace en persona, en el consultorio, dicho de paso; y pregunta qué le gustaría mejorar.',
        },
        {
          covers: 'que-esperar',
          asset: 'que-esperar',
          text: 'Qué esperar: SOLO una pregunta, sobre lo que más frena (si le preocupa que duela, la recuperación o cuánto dura), eligiendo según "Lo que le interesa". Sin dato antes.',
        },
        {
          covers: 'oferta',
          text: 'Último toque del día: pregunta si quiere saber si es candidata o candidato, y que eso se lo dice el médico en la valoración. Si "Lo que le interesa" dice que la valoración es sin costo, dilo en dos palabras; si no lo dice, nada sobre su costo.',
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
          text: 'Quién lo atiende: SOLO pregunta qué le gustaría mejorar, mencionando de paso que el médico lo valora en persona.',
        },
        {
          covers: 'que-esperar',
          asset: 'que-esperar',
          text: 'Qué esperar: un dato corto de "Lo que le interesa" (qué se siente, cuánto dura o qué cuidados pide) y pregunta si eso le acomoda.',
        },
        {
          covers: 'prueba',
          asset: 'antes-despues',
          text: 'Resultados: que es un caso real de la clínica con el mismo tratamiento, sin prometer el mismo resultado; y pregunta si eso es lo que busca.',
        },
        {
          covers: 'oferta',
          text: 'Último toque del día: SOLO pregunta si quiere saber si el tratamiento es para su caso, que es lo que el médico le dice en la valoración. Si "Lo que le interesa" dice que es sin costo, dilo en dos palabras; si no, nada sobre su costo.',
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
          text: 'Su caso: nombra lo que contó (zona, molestia, meta) con sus palabras, en media línea, y pregunta si quiere que le aparten su valoración. En neutro. Sin explicar el tratamiento.',
        },
        {
          covers: 'prueba',
          asset: 'antes-despues',
          text: 'Resultados: que es un caso real de la clínica parecido a lo que contó, sin prometer el mismo resultado; y pregunta si le aparta su valoración.',
        },
        {
          covers: 'oferta',
          text: 'Valoración: SOLO pregunta si le aparta un espacio para que el médico revise su caso. Si "Lo que le interesa" dice que la valoración es sin costo, dilo en dos palabras.',
        },
        {
          covers: 'cierre',
          text: 'Cierre suave: una pregunta y ya: si le aparta su lugar. Sin días ni horas, sin dato antes.',
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
          text: 'Cierre: SOLO la pregunta: si le aparta alguno de los horarios que ya vio o le busca otro. Sin repetir día ni hora.',
        },
        {
          covers: 'duda',
          text: 'Obstáculo: SOLO la pregunta, directa y sin rodeo: si algo le impide tomar el horario.',
        },
        {
          covers: 'cierre',
          text: 'Un paso: que sólo falta que elija, en media línea, y pregunta cuál le acomoda de los que vio, sin repetirlos.',
        },
        {
          covers: 'cierre',
          text: 'Cierre: SOLO la pregunta, con otras palabras que la vez anterior: si le aparta uno de los horarios que vio o le busca otro. Sin repetir día ni hora.',
        },
      ],
    },
  },
} as const;
