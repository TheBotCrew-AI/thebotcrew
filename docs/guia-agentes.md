# Guía para Agentes: Cómo trabajar junto al Asistente Virtual

Esta guía explica cómo funciona el bot, cuándo responde, cuándo se pausa, y qué debes
esperar cuando estás atendiendo una conversación en GoHighLevel.

---

## ¿Qué hace el bot?

El asistente virtual atiende conversaciones de WhatsApp e Instagram en nombre del negocio.
Su trabajo es:

- **Dar la bienvenida** y presentar el negocio al lead.
- **Calificar** al prospecto: entender qué busca, cuándo puede, y si tiene intención real.
- **Responder preguntas frecuentes** sobre servicios, precios, horarios y ubicación.
- **Revisar disponibilidad** en el calendario y ofrecer horarios para agendar.
- **Agendar citas** directamente desde la conversación.
- **Hacer seguimiento** si el lead deja de responder (recordatorios automáticos).

El bot trabaja las 24 horas. Si llega un mensaje a las 3am, responde igual que durante
el horario laboral.

---

## ¿Cuándo responde el bot?

El bot responde **cada vez que el lead manda un mensaje**, siempre que no esté pausado
(ver sección siguiente). Antes de responder espera unos segundos por si el lead manda
varios mensajes seguidos — así los toma todos en cuenta y da una sola respuesta coherente.

---

## ¿Cuándo se pausa el bot?

El bot se pausa automáticamente **en el momento en que tú mandas un mensaje** en la
conversación desde GoHighLevel. No tienes que hacer nada especial: solo escribe tu
respuesta y el bot se queda quieto.

**Cómo funciona el temporizador:**

- Cada mensaje que tú mandas activa una pausa de **5 minutos**.
- Si mandas otro mensaje dentro de esos 5 minutos, el temporizador se reinicia.
- Mientras el temporizador esté activo, el bot no responde aunque el lead escriba.

Esto te da espacio para tomar el control de la conversación sin que el bot te interrumpa.

**Ejemplo:**

| Hora  | Quién escribe | Qué pasa |
|-------|--------------|----------|
| 10:00 | Lead: "¿Tienen citas para hoy?" | Bot responde |
| 10:02 | Tú: "Sí, déjame revisar" | Bot se pausa hasta las 10:07 |
| 10:03 | Lead: "¿A qué hora?" | Bot no responde (tú estás atendiendo) |
| 10:04 | Tú: "Tenemos a las 11am o 3pm" | Temporizador se reinicia hasta las 10:09 |
| 10:09 | *(sin mensajes tuyos)* | Temporizador vence |
| 10:10 | Lead: "Perfecto, las 11am" | Bot retoma y responde |

---

## ¿Cuándo se reactiva el bot?

El bot se reactiva **automáticamente** cuando el temporizador de 5 minutos vence sin que
hayas mandado otro mensaje. No necesitas activarlo manualmente.

Esto significa que si atiendes una conversación, la resuelves, y el lead vuelve a
escribir más tarde (cuando tú ya no estás disponible), el bot retoma sin problema.

---

## Recordatorios automáticos (follow-ups)

Cuando el bot manda un mensaje y el lead no responde, el sistema envía recordatorios
automáticos en intervalos programados para no perder el contacto:

| Recordatorio | Cuándo se manda |
|---|---|
| 1° | 15 minutos sin respuesta |
| 2° | 3 horas sin respuesta |
| 3° | 6 horas sin respuesta |
| 4° | 12 horas sin respuesta |

Cada recordatorio tiene un mensaje distinto para no parecer repetitivo.

**Importante:** los recordatorios se cancelan automáticamente en cuanto el lead responde.
También se cancelan si tú mandas un mensaje en esa conversación.

Si el lead no responde después del último recordatorio, la conversación entra en modo
**espera** y el bot deja de insistir. Si el lead escribe en cualquier momento posterior,
el bot retoma la conversación normalmente.

---

## Cosas que debes saber al tomar una conversación

**El bot ya hizo trabajo previo.** Antes de que tú intervengas, el bot puede haber
calificado al lead, respondido preguntas y hasta intentado agendar. Lee el historial
antes de escribir para no repetir lo que ya se dijo.

**El bot ve todo el historial.** Cuando el bot retoma la conversación después de que tú
intervienes, tiene acceso a todo lo que se habló — incluyendo lo que tú dijiste. No
pierde el hilo.

**No tienes que avisar que eres humano.** El sistema sabe automáticamente que eres tú
quien escribió y pausa al bot. No necesitas usar ningún comando ni etiqueta especial.

**Si quieres que el bot no vuelva a tomar la conversación**, puedes marcarla como
"atendida por humano" (handoff) en GoHighLevel. En ese caso, el bot no regresa aunque
pase el tiempo. Para reactivarlo tendrías que quitar ese estado manualmente.

---

## Resumen rápido

| Situación | ¿Qué hace el bot? |
|---|---|
| Lead manda un mensaje | Responde (si no está pausado) |
| Tú mandas un mensaje | Se pausa 5 minutos |
| Mandas otro mensaje antes de que venzan los 5 min | Se reinician los 5 minutos |
| Pasan 5 min sin que tú escribas | Se reactiva solo |
| Lead no responde al bot | Manda recordatorios en 15 min, 3h, 6h, 12h |
| Lead responde un recordatorio | Cancela los recordatorios pendientes y retoma |
| Conversación marcada como "handoff" | Bot no responde hasta que se desactive manualmente |

---

## Preguntas frecuentes

**¿Puedo escribir en medio de una conversación sin que el bot me interrumpa?**
Sí. En cuanto mandas tu primer mensaje, el bot se queda quieto por 5 minutos.

**¿Qué pasa si el lead escribe mientras estoy atendiendo?**
El mensaje queda registrado y tú lo ves en GHL. El bot no lo contesta mientras el
temporizador esté activo.

**¿El bot puede equivocarse?**
Sí. El bot responde basándose en la información del negocio que tiene configurada, pero
puede no entender mensajes muy específicos o fuera de lo común. Si ves una respuesta
incorrecta, toma la conversación y corrígela directamente.

**¿El lead sabe que está hablando con un bot?**
Eso depende de cómo esté configurado el negocio. En general, el bot habla de forma
natural y no se presenta como bot a menos que se le pregunte directamente.

**¿Puedo confiar en que el bot agenda citas correctamente?**
Sí. El bot revisa disponibilidad en tiempo real en el calendario y solo ofrece horarios
disponibles. Si agenda una cita, ya quedó registrada en el sistema.
