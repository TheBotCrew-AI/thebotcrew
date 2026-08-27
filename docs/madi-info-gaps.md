# MADI Skin Care — huecos de información del bot

> Corte: 2026-08-25. Fuente: los 75 hilos de WhatsApp de MADI desde el go-live (2026-07-29):
> 30 con intervención humana y 47 eventos `pending_info` (14 hilos). Cada hueco lista la duda
> **tal cual la escribió el lead**, lo que **respondió el equipo de MADI** en el hilo (cuando lo hizo),
> y qué falta para cerrarlo en `tenant_config.prompt_overrides.offering`.
>
> Estado: ☐ pendiente · ◐ el equipo ya lo contestó en chat, falta pasarlo a la config · ☑ en config.
>
> **Desde 2026-08-25 este tracker se genera solo.** El runner de 0054 produce el mismo reporte por
> corrida (docs/business-logic.md §8); se abre en el navegador en
> `https://thebotcrew-agents.floral-credit-be7e.workers.dev/reports/info-gaps/19cf934b-2e36-4f4b-aa77-d3287e8d38fb?key=<report_key>`
> con `select report_key from tenant_config where tenant_id = '19cf934b-…'`. Este archivo queda como
> la base de comparación de la primera corrida (que redescubrió los huecos abiertos de abajo) y no se
> actualiza a mano de aquí en adelante.
>
> **2026-08-25 — primer cierre.** Los huecos 1, 2, 4, 5, 8, 9, 10, 11, 12, 14, 15 y la mitad segura de 6 y 13 pasaron a la config
> de prod con la respuesta que el equipo ya daba en chat (`offering`: reglas que afectan la cotización; `faq`: respuestas
> cerradas que se buscan con `lookupFaq`). Gate: `madi-info-gaps.eval.ts` (5 casos, rojo→verde). Lo que sigue abierto
> necesita a MADI; la lista de preguntas está en cada sección.

## Resumen

| # | Hueco | Hilos | Estado | Quién lo cierra |
|---|-------|-------|--------|-----------------|
| 1 | Formas de pago: paquete completo vs por sesión | 10 | ☑ | cerrado 2026-08-25 (`offering`) |
| 2 | Precios de combinaciones que no están en la lista | 9 | ☑ | cerrado 2026-08-25: seis combos cargados; piernas + bikini → $3,800 |
| 3 | Las promos de láser vencen (fecha) | 9 | — | no aplica: las fechas no existen, es el precio normal del paquete (Leo, 2026-08-25) |
| 4 | Horario real: fines de semana y tardes | 5 | ☑ | cerrado 2026-08-25 (`hours`: L–V 8–19, sáb–dom 8–16) |
| 5 | Resultados, nº de sesiones, garantía, retoques | 3 | ☑ | cerrado 2026-08-25 (`faq`) |
| 6 | Aclaramiento/blanqueamiento de axilas o bikini | 5 | ☑/☐ | la línea segura ya está en `faq`; MADI confirma si hay tratamiento específico |
| 7 | Edad mínima / menores de edad | 2 | ☑ | cerrado 2026-08-26 (`faq`): sí se puede, acompañados de un adulto |
| 8 | Equipo: marca, certificación, quién aplica | 2 | ☑ | cerrado 2026-08-25 con la descripción de Marina (Triodo Diamond) |
| 9 | Qué incluye "cuerpo completo" | 3 | ☑ | cerrado 2026-08-25 (`offering`) |
| 10 | Bikini vs brasileño (zona y precio por sesión) | 1 | ☑ | cerrado 2026-08-25 con la descripción de Marina ($500/$600 por sesión, mismo paquete) |
| 11 | Cómo llegar dentro del edificio | 3 | ☑ | cerrado 2026-08-25 (`offering` + `faq`) |
| 12 | Frecuencia entre sesiones (matiz 15–20 días) | 2 | ☑ | cerrado 2026-08-25 (`offering`) |
| 13 | Recuperación / cuidados posteriores | 1 | ☑/☐ | "no requiere recuperación" ya está en `offering`; cuidados posteriores siguen con MADI |
| 14 | Sucursales / otros estados | 1 | ☑ | cerrado 2026-08-25 (`faq`: solo Tijuana) |
| 15 | Vacantes / empleo | 1 | ☑ | cerrado 2026-08-25 (`faq`: no hay vacantes; no se recibe CV) |
| 16 | SOP y temas hormonales | 1 | ☐ | MADI (sigue siendo handoff; falta la línea) |
| 17 | Duración de sesión cuerpo completo | 1 | ☐ | MADI |
| 18 | Cancelación / reagenda / solo con cita | 0 | ☐ | Leo lo investiga con MADI (2026-08-25); hasta entonces el bot lo confirma con el equipo |

Cuatro leads con `pending_info` a los que **nadie contestó nunca**: blanqueamiento bikini (08-03),
axilas + piernas completas costo (08-17), edad mínima (08-19), sucursales/La Paz (08-22). Ver §Hilos sin respuesta.

---

## 1. Formas de pago — paquete completo vs por sesión  ☑

**El hueco más grande: 1 de cada 3 hilos con humano entró por esto.** La config dice textualmente que
"formas de pago, planes o mensualidades" no están confirmadas, y el equipo lo contestó igual las 10 veces.

Como lo preguntan:
- "Los pagos son por sesión o como serían?" · "Es pago por sesión" · "Tendría que pagar 2400 ya, oh puedo pagarlo por sesiones"
- "Se pagan al inicio o poco a poco en cada sesión?" · "Disculpe y como son los pagos??" · "como manejan los pagos"
- "Y debo pagar por cesión o todo junto?" · "Se paga separado cada sección oh?" · "Se pagan los 2400 completos desde la primera sesión"
- "El pago se hace todo junto???" · "Puedo pagar por transferencia"

Lo que respondió MADI (consistente en los 10):
- El precio de paquete **es promocional y se paga completo en la primera sesión**.
- Alternativa: **pago por sesión** al precio de sesión suelta (bikini/axilas $500; las 3 áreas piernas+axilas+bigote $1,200) — "un poquito más elevado pero si se le hace más cómodo".
- Aceptan **efectivo, tarjeta de crédito/débito y transferencia**.
- No existen mensualidades ni planes.

Para cerrar: quitar "formas de pago" de la lista de "lo que AÚN no tienes" en `offering` y añadir la regla.
El bot YA tiene los precios por sesión ("uso restringido"), así que la respuesta sale sola:
"el paquete se paga completo en la primera sesión; si prefieres ir por sesión, X es $Y por sesión".
Caso #14 (54fdd449): la lead preguntó **cinco veces** lo mismo y no quiso agendar hasta saberlo.

## 2. Precios de combinaciones fuera de la lista  ☑

La config tiene 8 combos. Los leads piden otros y el equipo los cotiza al momento — casi siempre como "especial".
Lo que dijo MADI en chat (a confirmar como tabla oficial, con o sin fecha de vencimiento):

| Combinación (6 sesiones) | Precio dicho | Hilo | Nota |
|---|---|---|---|
| Axilas + piernas completas | **$3,400** | #23, #30, (aeea9f9f sin respuesta) | pedida 3 veces; el bot dijo "no tengo precio" |
| Brazos completos + piernas completas | **$3,900** | #8 | "especial hasta el 15 de agosto"; la lead entendió $3,900 por sesión |
| Piernas completas + axilas + bigote | **$3,500** | #16 | por sesión las 3 áreas: $1,200 |
| Piernas completas + brazos completos + cara + axilas | **$4,200** | #18 | |
| Cara + glúteos | **$3,200** | #11 | **glúteos no existe como zona en la config** |
| Axilas + bigote + patillas | **$3,200** | #21 | la lead pidió axila+bigote; el equipo ofreció esto |
| Axilas + bigote (solo) | — | #21, e03f84a1 | nunca se cotizó |
| Medias piernas + axilas + bigote | — (1 sesión: $1,500) | #26 | solo se dio precio de sesión suelta |
| Piernas completas + bikini, **8 sesiones** | $4,400 | #9 | el bot no sabe que existen paquetes de 8 |
| Piernas completas + bikini | **$3,800** (config: $3,500) | #9 | ⚠ discrepancia con la config |
| Axilas + medias piernas | $2,800 | #2 | coincide con config |

Cerrado 2026-08-25 (Leo): los precios del equipo **son la lista real** ("promo" es solo cómo los llaman). Cargados en
`offering` los seis combos con precio (axilas + piernas completas $3,400; brazos + piernas $3,900; piernas + axilas + bigote
$3,500; piernas + brazos + cara + axilas $4,200; cara + glúteos $3,200; axilas + bigote + patillas $3,200) y **piernas
completas + bikini pasó de $3,500 a $3,800**, el precio que cobra el equipo. Decisiones: no hay paquete de 8 sesiones
(lo que hizo el equipo fue sumar dos sesiones al precio por sesión del paquete — demasiado enredado para el bot; todo
queda en 6); glúteos existe solo dentro de su combo; axilas + bigote solo y piernas completas solas siguen sin precio
(el bot los confirma con el equipo).

## 3. Las promos de láser tienen fecha de vencimiento  — no aplica

El equipo cierra con urgencia en 9 hilos: "esta especial finaliza el **5 de agosto**" (#2), "**15 de agosto**" (#8, #9),
"**20 de agosto**" (#11, #16, #18, #20), "**24 de agosto**" (#21, #22, #23), "**31 de agosto**" (#30).
El bot presenta los precios de paquete como fijos y no sabe que son promocionales ni hasta cuándo.

Resuelto 2026-08-25 (Leo): **las fechas no existen** — el equipo las dice para meter urgencia, pero es el precio normal del paquete.
El bot da los precios como están y no inventa vencimientos; la urgencia queda del lado del equipo.

## 4. Horario real — fines de semana y tardes  ☑

La config (`hours`) dice **lunes a viernes 08:00–17:00**. En los hilos el equipo agenda:
- Sábados: 15 ago 10 am (#10), 5 sept 10 am (#10), 26 sept 11 am (#24)
- Domingo: "mañana domingo 12:30" (#26, 23 ago)
- Tardes: 5:30 pm (#2), 6:00 pm (#22, #27), **6:30 pm** (#7)

Y el bot ya se equivocó las dos veces que le preguntaron: "Me imagino abren sábado" → "Sí, atendemos **todos los días** de 08:00 a 17:00" (#24, inventado); "A las 8 am atienden?" → "Sí" (#21).

Cerrado 2026-08-25 con el horario publicado de la clínica: **lunes a viernes 8:00–19:00, sábado y domingo 8:00–16:00** (`hours`, siete días). Gate: `madi-info-gaps.eval.ts` → "weekend and evening hours".

## 5. Resultados, número de sesiones, garantía, retoques  ☑

Como lo preguntan:
- "Qué sucede si después de las 12 sesiones aún tengo vello? ¿Incluyen retoques o sesiones adicionales?" (#5)
- "Me interesa ver resultados… y si en algún momento cuenta con garantía en caso de no ver ningún cambio?" (#12 — ya se había hecho láser antes sin resultado)
- "Aproximadamente con cuantas sesiones desaparece el bello" (#18)

Lo que respondió Marina (técnico, 15+ años):
- No existe garantía en ninguna depilación láser; ninguna máquina elimina el 100% del vello, normalmente **75–80%**.
- Promedio **6 a 12 sesiones**; varía por cuestión hormonal, vello muy abundante o muy claro, o si toma algún tratamiento.
- Normalmente **un retoque al año**, que se paga como sesión suelta; hay personas que no lo requieren.
- Lo que sí garantizan: el acompañamiento entre sesiones y que siempre la atiende la misma técnico.

Para cerrar: pasar esto a `offering` como respuesta lista (sin prometer resultados — ya es la línea de Marina). Es fillable hoy.

## 6. Aclaramiento / blanqueamiento de axilas o bikini  ☑/☐

5 hilos, uno sin respuesta. Como lo preguntan: "Manejan blanqueamiento del área del bikini" (bdf9cac5, **sin respuesta**),
"Ese tratamiento también blanquearla mi axilas?" (#10), "el área esta un poco obscura para eso es otro tratamiento??" (#17),
"ocupo desmanchar área axila" (#19), "Es aclaramiento y eliminación de bello?" (#28).

Lo que respondió MADI: la depilación láser **suele aclarar un poco el área** (por el láser y por dejar el rastrillo), pero
**no es un tratamiento específico** para eso; recomiendan empezar por la depilación y, si no basta, "podemos recomendarle otros tratamientos".

Pregunta para MADI: ¿existe un tratamiento de aclaramiento como tal (axilas, bikini)? Si sí, nombre y precio. Si no, la línea de arriba basta.

## 7. Edad mínima / menores de edad  ☑

- "Se puede realizar la depilación en una menor de edad" (#13) → handoff; Marina preguntó "¿Cuántos años tiene la menor? ¿Ya menstrúa regularmente?" y el hilo murió ahí.
- "¿Desde qué edad se puede hacer?" (6612fc6d, 3 veces, **sin respuesta**; la lead siguió y pidió un paquete de $4,200).

Respuesta de MADI (Leo, 2026-08-26): **sí se puede en menores de edad; el único requisito es ir acompañados de un adulto.** Cargada en `faq` (entrada 10). No se cargó edad mínima ni el criterio de menstruación que Marina preguntó una vez — MADI no lo fijó como regla, así que el bot no lo menciona. El disparador fue el hilo c8b37f38 (hija de 17, 08-26), donde el equipo lo contestó a mano.

## 8. Equipo, certificación y quién aplica  ☑

"Cuál es la marca y el modelo exacto del equipo… ¿Es un láser médico certificado? ¿Quién realiza las sesiones (médico, enfermera o técnico)?" (#5) · "qué tipo de láser se aplica" (#12).

Lo que respondió MADI: "láser **Triodo Diamond**", máquinas "debidamente certificadas y calibradas", indicado para todo tipo de piel,
parámetros ajustados a color de piel y grosor de vello. Aplica **Marina, técnico en depilación láser con más de 15 años de experiencia**.

Cerrado 2026-08-25 con la descripción de Marina, tal cual: `offering`, la FAQ "¿Qué tipo de láser usan?" y el nombre del servicio dicen ahora **láser Triodo Diamond**, equipos certificados y calibrados, apto para todo tipo de piel, parámetros según piel y vello. No se cita ninguna certificación por nombre porque no la tenemos.

## 9. Qué incluye "cuerpo completo"  ☑

3 hilos (#5, #20, bdc2c3e3). El bot da "$1,900 por sesión" y la lead de #20 contestó "no sé qué es lo que ustedes incluyen".
MADI: "cuerpo completo se refiere a **axilas, bikini y piernas completas**" → o sea el paquete de $3,800 que ya está en la config.

Para cerrar: definir en `offering` que "cuerpo completo" = ese combo y darlo como paquete de 6 ($3,800), con el por-sesión ($1,900) solo si lo piden.

## 10. Bikini vs brasileño  ☑

La config dice: bikini, bikini completo y brasileño son **la misma zona y el mismo precio**. En #29 el equipo dijo:
- **Bikini** = ingles y un poco arriba del pubis. **Brasileño** = retiro integral de toda la zona.
- Por sesión: bikini **$500**, brasileño **$600**. Por paquete: mismo precio ($2,400).

Cerrado 2026-08-25 con la regla del equipo: dos versiones de la zona, **mismo precio de paquete** ($2,400 — el bot lo cotiza sin preguntar cuál), y por sesión **$500 normal / $600 brasileño**. La diferencia se explica solo si la preguntan o si va a pagar por sesión.

## 11. Cómo llegar dentro del edificio  ☑

El equipo lo manda a mano el día de la cita (#8, #19, #22): "**Es el edificio donde dice Notaría 5, último piso, puerta blanca con listón rojo**".
Fillable hoy: añadirlo a la respuesta de ubicación (FAQ + `offering`).

## 12. Frecuencia entre sesiones  ☑

Ya está en config ("una cada mes"). Matiz del equipo (#3): "normalmente son cada mes, en casos particulares cada 15 o 20 días".
También #22: "rasúrate **un día antes**" (config: "llega rasurada"). Dos retoques de una línea.

## 13. Recuperación / cuidados posteriores  ☑/☐

"El procedimiento lleva tiempo en recuperación?" (#28) → "No se requiere recuperación". Fillable.
Los **cuidados posteriores** siguen sin confirmar (la config lo marca así). Pregunta para MADI: qué evitar después (sol, desodorante, ejercicio, cuánto tiempo).

## 14. Sucursales / otros estados / La Paz  ☑

bdc2c3e3 preguntó 3 veces (otras sucursales, otros estados, La Paz) y el bot dijo "lo confirmo con el equipo" las 3; **nadie contestó** y se dio de baja.
Cerrado 2026-08-25: solo Tijuana (`faq`).

## 15. Vacantes / empleo  ☑

"¿Cuentan con alguna vacante para el área de recepción?" (#25) → "por el momento no tenemos vacantes".
Cerrado 2026-08-25: "por el momento no tenemos vacantes abiertas" (`faq`). Decisión de Leo: no se da correo ni se recibe CV.

## 16. SOP / temas hormonales  ☐

"Sufro de sop" (#11) → handoff correcto. Sigue siendo handoff, pero una línea de MADI ("con SOP sí se puede; suele requerir más sesiones y lo valora la técnico") evitaría el silencio hasta que entra alguien.

## 17. Duración de sesión de cuerpo completo  ☐

bdc2c3e3, sin respuesta. La config tiene minutos por zona, no por combos ni cuerpo completo. Pregunta para MADI: duración de cada combo (o regla: suma de zonas).

## 18. Cancelación, reagenda, "solo con cita previa"  ☐ (Leo investiga)

Nadie lo preguntó aún; el equipo lo dice al agendar (#8: "las sesiones son solo con cita previa, si necesita hacer algún cambio nos lo hace saber por este medio"). Marcado como no confirmado en la config. Baja prioridad.

---

## Después de la primera corrida automática (2026-08-25)

El reporte del runner encontró un tema nuevo y confirmó cuatro abiertos. Respuestas de Leo el mismo día:

| Tema | Estado |
|---|---|
| Anticipo para apartar un paquete (nuevo) | ☑ No hay anticipos: el precio se asegura pagando completo en la primera sesión. Cargado en `offering`. |
| Blanqueamiento de bikini como servicio | ☑ Cubierto por la FAQ de aclaramiento (axilas o bikini). |
| Edad mínima (#7) | ☑ Cerrado 2026-08-26: menores sí, acompañados de un adulto. En `faq`. |
| Duración de sesión de combos / cuerpo completo (#17) | ☐ Leo lo investiga con MADI. |

Tres temas se cerraron como ruido de la primera corrida (piernas + bikini a $3,500 — anterior al cambio a $3,800; precio de la valoración; lista de zonas): ya estaban en config.

## Hilos sin respuesta (pending_info que nadie atendió)

| Hilo | Fecha | Duda | Estado hoy |
|---|---|---|---|
| bdf9cac5 | 08-03 | Blanqueamiento de bikini | awaiting_human, "me queda muy lejos" — perdida |
| aeea9f9f | 08-17 | Costo axilas + piernas completas | awaiting_human — el precio ($3,400) el equipo lo sabía |
| 6612fc6d | 08-19 | Edad mínima (×3) | awaiting_human — quería el paquete de $4,200 |
| bdc2c3e3 | 08-22 | Sucursales / La Paz / duración | opted_out |

El tag `dato-pendiente` se está poniendo, pero estos cuatro no entraron a la cola de nadie. Vale la pena que MADI revise ese tag en GHL, no solo `esperando-agenda`.

## Observaciones que no son huecos de info

- **El bot re-entra mientras el humano atiende**: 5 disculpas del equipo por "respuestas automáticas" (#6, #21, #26 ×2, #29). Es la pausa de 5 min; `human_pause_minutes = 30` (0052) ya está en la config y en el árbol de trabajo sin commitear.
- **El equipo siempre pide nombre y apellido para la cita** (#7, #8, #22, #24, #28). El bot tiene `confirmContactName: false`; podría capturarlo al pedir la preferencia de horario y ahorrarle un turno al equipo.
- En #6 el bot dijo "no tengo precio por sesión para bikini completo" cuando sí lo tiene ($500) — la regla de nombres del bikini ya está en la config; verificar que sigue sin pasar.
