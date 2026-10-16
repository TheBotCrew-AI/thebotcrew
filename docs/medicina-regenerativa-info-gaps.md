# Medicina Regenerativa — huecos de información del bot

> Corte: 2026-10-16. Tenant `65abb7c6-b41a-4e2d-a0f3-444849363c4e` (location `nmf4Fx6cBL1WMsAGn8jI`).
> Fuente: la prueba de Rafael (hilo `062d6e26-a5ef-4ab2-a515-8c004742de07`, Facebook, 2026-10-12,
> tres eventos `pending_info`) + lo que debe tener cualquier clínica (doctor, pagos, políticas, COFEPRIS).
> Las respuestas las pasó Leo en sesión, de lo que le dijo Rafael.
>
> Estado: ☐ pendiente · ◐ decisión tomada, falta el dato · ☑ en config de prod.
>
> Dónde vive cada cosa: `prompt_overrides.offering` (siempre en el prompt: doctor, dirección,
> sección `# Valoración`, los 7 tratamientos), `prompt_overrides.houseRules` (reglas que ganan
> sobre el flujo: sin precios de tratamientos, anticipo → equipo), `faq` (19 respuestas,
> se consultan con `lookupFaq`), `services` (nombres para el clasificador), `calendars` (los 7
> tratamientos + Valoración → el calendario `qBOgVhcb5nNt410h0dVo`).

## Pendiente — lo pide Leo a Rafael

| # | Hueco | Estado | Notas |
|---|-------|--------|-------|
| 1 | COFEPRIS | ☐ | Pedir: nº de licencia sanitaria o aviso de funcionamiento; si tiene **licencia para células troncales** (la Ley General de Salud la exige para establecimientos que las usan); si placenta, carzilasa, factor de transferencia y NAD+ tienen **registro sanitario**. Confirmar con su gestor; no es asesoría legal. Sirve para el bot ("¿están certificados?") y para los anuncios. |
| 2 | ¿Atiende él todas las valoraciones o hay otros médicos? | ☐ | Hoy el prompt dice "a cargo del Dr. Rafael Ruiz Castillo". |
| 3 | Placenta: ¿dónde se aplica? | ☐ | El bot dice "inyección, unos 10 minutos" (Leo). El sitio, con datos de los trípticos, dice implante subdérmico **alrededor del ombligo**. Si Rafael lo confirma, agregarlo a la sección de Placenta en `offering`. |
| 4 | Testimonios o casos | ☐ | Nada cargado. Ojo con COFEPRIS: un testimonio con resultado es publicidad sanitaria. |
| 5 | Datos para el anticipo (CLABE / liga) | ◐ | Decisión de Leo: **por ahora no**. El bot NO da datos de pago; agenda y pasa al equipo con `flagAwaitingHuman` → tag `esperando-equipo`. Si algún día los dan: houseRule "Anticipo" + FAQ de anticipo + línea "Pago" de `# Valoración`. |
| 6 | Paquetes / combinaciones | ◐ | Decisión de Leo: no ponerlo por ahora. |

## Pendiente — de nuestro lado

| # | Tarea | Notas |
|---|-------|-------|
| 7 | Probar el flujo del anticipo antes de abrir | Paciente de primera vez: pregunta precio → recibe "se define en valoración, $100 USD" → agenda → confirmación dice que el equipo le escribe para el anticipo → `flagAwaitingHuman` con el tag `esperando-equipo`. Nunca se ha corrido. Desde el hilo de Leo con `TEST`, o en la batería (no hay escenarios para este tenant todavía). |
| 8 | Quitar la keyword `TEST` | `trigger_keywords = NULL` cuando Rafael dé el visto bueno. `enabled_channels` ya es `{whatsapp,facebook,instagram}` y `test_contact_ids` es NULL, así que quitar `TEST` = abrir a todos. Hoy un paciente real sin la palabra no recibe respuesta (pasó el 2026-10-14: "Saludos y bendiciones Doc. Rafael"). |
| 9 | Limpiar el hilo de prueba de Rafael | `062d6e26…` sigue en `awaiting_human` con el tag `dato-pendiente` en GHL. Sus tres preguntas ya tienen respuesta en config. |
| 10 | Tipo de cambio | Está fijo en **$17** en una entrada del FAQ ("¿Aceptan dólares?"). Leo lo mantiene a mano. Sólo afecta a la valoración ($100 USD): ya no hay precios de tratamientos. |
| 11 | Sitio web (`sites/medicina-regenerativa`) | Prender `SHOW_TEAM` con las cédulas (ya las tenemos, abajo) y quitar `infusion` (sueroterapia: Rafael la eliminó) de `_src/build.mjs` y `api/contact.mjs`. Siguen pendientes: aviso de privacidad, logo, fotos. |
| 12 | CAPI | Sin configurar. Seguir [`capi-setup-sop.md`](capi-setup-sop.md). |

## Cerrado (2026-10-16)

| Tema | Qué quedó en config |
|------|---------------------|
| Carzilasa (la pregunta de Rafael) | 7.º tratamiento: sección en `offering` desde la infografía de Rafael, `services`, `calendars`. "Previene amputaciones" / "acelera" bajados a "se usa para"; sin promesas. Sesiones: las define el doctor. |
| Diabetes | Se resuelve con carzilasa + NAD+ (ambos mencionan pacientes diabéticos). |
| Costo de la valoración (la pregunta de Rafael) | `# Valoración`: $100 USD o equivalente; expediente + historial + signos vitales + consulta; protocolo según laboratorio; 30 min, presencial (no hay en línea). |
| Precios de tratamientos | **Ninguno por mensaje** (como Heriberto): quitados de `offering` y `services`; houseRule manda a valoración, o a llamar al 664 728 7260 si quiere una idea antes. |
| NAD+ | Reescrito desde la infografía de Rafael: "participa en", nunca "mejora"; se conserva la advertencia de que la evidencia está en evolución; sin la sección de suplementos. IV, 1.5 h, cada 3–4 meses. |
| Aplicación por tratamiento | Proloterapia inyecciones 30 min; quelación IV 3–4 h; placenta y factor de transferencia inyección ~10 min; NAD+ IV 1.5 h. |
| Doctor | Dr. Rafael Ruiz Castillo, médico general (cédula 8233197), maestría en medicina regenerativa, antienvejecimiento y estética (cédula 13176879). Es **maestría, no especialidad**: el prompt fija la frase para que nunca diga "especialista". |
| Clínica | Plaza Thamarc, Local 1, Diego Rivera 2563, Zona Río, Tijuana; hay estacionamiento; tel. 664 728 7260; L–S 9–18. |
| Pagos | Efectivo, tarjeta, transferencia; pesos o dólares (TC 17); factura sí; sin promo de meses sin intereses; se paga al llegar. |
| Anticipo | Primera vez: 50% de la valoración ($50 USD); el equipo manda los datos (ver #5). `awaiting_human_tag = esperando-equipo`. |
| Cancelación | Sin reembolso al cancelar o reagendar; para reagendar se deja un anticipo nuevo. |
| Laboratorio | Si tiene resultados recientes los trae; si no, se hacen en consulta y se pagan directo en el laboratorio. |
| Pacientes | Mayores de 18; embarazadas sí (el doctor valora si es candidata); contraindicaciones las define el doctor; pacientes de EE. UU. igual que todos. |
| Sueroterapia | Eliminada (nunca estuvo en el bot; queda en el sitio, ver #11). |
