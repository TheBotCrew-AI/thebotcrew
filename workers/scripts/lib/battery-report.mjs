/**
 * The client's report: one page, one conversation at a time.
 *
 * Built for a phone. Each conversation is a full-size WhatsApp screen (no scaled-down
 * frame — the text has to be readable) that REPLAYS when it comes into view: the lead's
 * messages drop in, the header says "escribiendo…", the assistant answers. Swipe (or use
 * the arrows) to move to the next one. Above each chat: the situation in one line and what
 * it ended in (a chip: appointment booked, question sent to the team, just information).
 *
 * Nothing technical shows here — tool calls, models and config sources live in the gallery
 * (index.html) that is for Leo. Self-contained: open from disk, send by WhatsApp, or drop
 * on a static host.
 */

import { esc, wa, timeLabel, initials, ICON, css } from './whatsapp-ui.mjs';

const W = 390;
const H = 844;

/** "martes, 1 de septiembre, 4:45 p.m." — the label the bot itself uses. */
function apptLabel(iso, tz) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(d);
  return `${day}, ${timeLabel(iso, tz)}`;
}

/** What the conversation ended in, in the client's words. */
function outcomeChips(t) {
  const tz = t.tenant.timezone;
  const called = (name) => t.toolCalls.some((c) => c.name === name);
  const confirmed = t.ghl.appointments.filter((a) => a.status === 'confirmed');
  const chips = [];
  if (called('rescheduleAppointment') && confirmed[0]) chips.push({ icon: '🔁', text: `Cita cambiada · ${apptLabel(confirmed[0].startTime, tz)}` });
  else if (called('bookAppointment') && confirmed[0]) chips.push({ icon: '✅', text: `Consulta agendada · ${apptLabel(confirmed[confirmed.length - 1].startTime, tz)}` });
  else if (called('cancelAppointment')) chips.push({ icon: '❌', text: 'Cita cancelada' });
  if (called('flagPendingInfo')) chips.push({ icon: '📋', text: chips.length ? 'Una duda quedó con el equipo' : 'Duda enviada al equipo' });
  if (called('flagAwaitingHuman')) chips.push({ icon: '🙋', text: 'Pasó con el equipo' });
  if (!chips.length) chips.push({ icon: '💬', text: 'Solo pidió información' });
  return chips;
}

function reportCss() {
  return `
  ${css(W, H)}
  html, body { height: 100%; background: #e9edef; overscroll-behavior: none; }
  body { display: flex; flex-direction: column; color: #111b21; }
  .bar { flex: 0 0 auto; height: 52px; display: flex; align-items: center; justify-content: space-between; padding: 0 14px; background: #075e54; color: #fff; }
  .bar .brand { font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar .brand small { display: block; font-weight: 400; font-size: 11.5px; opacity: .8; }
  .bar .count { font-variant-numeric: tabular-nums; font-size: 13px; opacity: .9; background: rgba(255,255,255,.15); padding: 4px 10px; border-radius: 12px; }
  .deck { flex: 1 1 auto; min-height: 0; display: flex; overflow-x: auto; overflow-y: hidden; scroll-snap-type: x mandatory; scrollbar-width: none; }
  .deck::-webkit-scrollbar { display: none; }
  .card { flex: 0 0 100%; scroll-snap-align: start; scroll-snap-stop: always; display: flex; flex-direction: column; min-height: 0; }
  .inner { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; width: 100%; max-width: 430px; margin: 0 auto; background: #fff; }
  @media (min-width: 700px) { .inner { margin: 16px auto; border-radius: 22px; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,.18); max-height: ${H}px; } }
  .head { flex: 0 0 auto; padding: 12px 16px 10px; border-bottom: 1px solid #e2e6e8; }
  .head .kicker { font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; color: #667781; }
  .head h2 { margin: 2px 0 4px; font-size: 17px; line-height: 1.25; }
  .head p { margin: 0 0 8px; font-size: 13.5px; line-height: 1.4; color: #3b4a54; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 12.5px; padding: 4px 9px; border-radius: 14px; background: #e7f8ef; color: #0b6b3a; font-weight: 500; }
  .chip.grey { background: #eef1f3; color: #3b4a54; }
  .chip.amber { background: #fff3d6; color: #7a5200; }
  .screen { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .screen .top { flex: 0 0 auto; }
  .screen .statusbar { display: none; }
  .screen .header { height: 52px; }
  .screen .who .sub.typing { color: #1daa61; }
  .screen .chat { overflow-y: auto; overscroll-behavior: contain; scroll-behavior: smooth; padding-bottom: 14px; }
  .screen .composer { display: none; }
  .msg { animation: pop .22s ease-out; }
  @keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
  .tools { flex: 0 0 auto; display: flex; gap: 8px; justify-content: space-between; align-items: center; padding: 8px 12px 10px; background: #fff; border-top: 1px solid #e2e6e8; }
  .tools button { font: inherit; font-size: 13px; white-space: nowrap; padding: 8px 11px; border-radius: 18px; border: 1px solid #cfd6da; background: #fff; color: #075e54; cursor: pointer; }
  .tools button.primary { background: #075e54; border-color: #075e54; color: #fff; font-weight: 600; }
  .tools button:disabled { opacity: .45; cursor: default; }
  .tools .mid { flex: 1 1 auto; display: flex; gap: 8px; justify-content: center; }
  .intro .inner, .outro .inner { justify-content: center; align-items: center; text-align: center; padding: 32px 28px; background: #fff; }
  .intro .avatar { width: 84px; height: 84px; font-size: 30px; margin: 0 0 18px; }
  .intro h1 { font-size: 24px; margin: 0 0 6px; }
  .intro .lead { font-size: 15.5px; color: #3b4a54; line-height: 1.5; max-width: 320px; margin: 0 0 22px; }
  .intro .fine { font-size: 12.5px; color: #667781; line-height: 1.45; max-width: 320px; margin: 18px 0 0; }
  .intro .start { margin-top: 6px; }
  .dots { flex: 0 0 auto; display: flex; justify-content: center; gap: 5px; padding: 8px 0 10px; background: #e9edef; }
  .dots i { width: 6px; height: 6px; border-radius: 50%; background: #b8c2c8; transition: transform .2s, background .2s; }
  .dots i.on { background: #075e54; transform: scale(1.35); }
  `;
}

function screenHtml(t, avatar) {
  const name = t.tenant.businessName;
  const avatarInner = avatar ? '' : esc(initials(name));
  return `<div class="screen">
    <div class="top"><div class="header">
      <div class="back">${ICON.back}<span class="unread">3</span></div>
      <div class="avatar${avatar ? ' logo' : ''}">${avatarInner}</div>
      <div class="who"><div class="name"><span>${esc(name)}</span>${ICON.verified}</div><div class="sub">Cuenta de empresa</div></div>
      <div class="actions">${ICON.video}${ICON.phone}</div>
    </div></div>
    <div class="chat"><div class="pill">Hoy</div><div class="pill notice">🔒 Esta empresa utiliza un servicio seguro de Meta para gestionar este chat. Toca para más información.</div></div>
  </div>`;
}

function cardHtml(t, i, n, avatar) {
  const chips = outcomeChips(t)
    .map((c) => `<span class="chip${c.icon === '📋' ? ' amber' : c.icon === '💬' ? ' grey' : ''}">${c.icon} ${esc(c.text)}</span>`)
    .join('');
  return `<section class="card" data-i="${i}">
  <div class="inner">
    <div class="head">
      <div class="kicker">Conversación ${i + 1} de ${n}</div>
      <h2>${esc(t.scenario.title)}</h2>
      <p>${esc(t.scenario.shows)}</p>
      <div class="chips">${chips}</div>
    </div>
    ${screenHtml(t, avatar)}
    <div class="tools">
      <button class="prev" aria-label="Anterior">‹</button>
      <div class="mid"><button class="replay">↻ Repetir</button><button class="skip">⏭ Completa</button></div>
      <button class="next primary" aria-label="Siguiente">Siguiente ›</button>
    </div>
  </div>
</section>`;
}

export function reportHtml(transcripts, { avatar, assistantName } = {}) {
  const first = transcripts[0];
  const business = first.tenant.businessName;
  const assistant = assistantName ?? first.tenant.assistantName ?? 'tu asistente';
  const n = transcripts.length;
  const data = transcripts.map((t) => ({
    id: t.scenario.id,
    messages: t.messages.map((m) => ({ from: m.from, html: wa(m.text), time: timeLabel(m.at, t.tenant.timezone) })),
  }));
  const generated = new Intl.DateTimeFormat('es-MX', { day: 'numeric', month: 'long', year: 'numeric', timeZone: first.tenant.timezone }).format(new Date(first.generatedAt));
  const avatarInner = avatar ? '' : esc(initials(business));
  // The profile photo is embedded once, as a CSS rule, not once per card.
  const avatarCss = avatar ? `.avatar.logo { background: url("${avatar}") center / cover no-repeat; }` : '';

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><title>${esc(assistant)} · ${esc(business)}</title><style>${reportCss()}${avatarCss}</style></head>
<body>
<div class="bar"><div class="brand">${esc(assistant)} · ${esc(business)}<small>Así atiende por WhatsApp</small></div><div class="count" id="count">${n} conversaciones</div></div>
<div class="deck" id="deck">
  <section class="card intro"><div class="inner">
    <div class="avatar${avatar ? ' logo' : ''}">${avatarInner}</div>
    <h1>${esc(assistant)}</h1>
    <p class="lead">${n} conversaciones de ejemplo, tal como las vería un paciente en su WhatsApp: personas que llegan del anuncio, que solo preguntan, que tienen dudas o que quieren cambiar su cita.</p>
    <button class="start" id="start" style="font:inherit;font-size:15px;padding:12px 22px;border-radius:24px;border:0;background:#075e54;color:#fff;font-weight:600;cursor:pointer">Ver la primera ›</button>
    <p class="fine">Cada conversación se reproduce sola. Desliza hacia el lado para pasar a la siguiente.<br>Los pacientes son simulados; las respuestas de ${esc(assistant)} son reales, con la información actual del consultorio. Las citas de estos ejemplos no son de verdad.</p>
    <p class="fine">${esc(generated)}</p>
  </div></section>
${transcripts.map((t, i) => cardHtml(t, i, n, avatar)).join('\n')}
</div>
<div class="dots" id="dots"></div>
<script id="data" type="application/json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('data').textContent);
  var deck = document.getElementById('deck');
  var cards = Array.prototype.slice.call(deck.querySelectorAll('.card'));
  var dots = document.getElementById('dots');
  var count = document.getElementById('count');
  var TICKS = ${JSON.stringify(ICON.ticks)};
  var players = {};

  cards.forEach(function (c, i) { var d = document.createElement('i'); if (i === 0) d.className = 'on'; dots.appendChild(d); });

  function goTo(i) {
    i = Math.max(0, Math.min(cards.length - 1, i));
    deck.scrollTo({ left: cards[i].offsetLeft, behavior: 'smooth' });
  }
  document.getElementById('start').addEventListener('click', function () { goTo(1); });
  cards.forEach(function (card, i) {
    var prev = card.querySelector('.prev'), next = card.querySelector('.next');
    if (prev) prev.addEventListener('click', function () { goTo(i - 1); });
    if (next) { next.addEventListener('click', function () { goTo(i + 1); }); if (i === cards.length - 1) { next.textContent = 'Fin'; next.disabled = true; } }
  });

  function bubble(m, first) {
    var el = document.createElement('div');
    el.className = 'msg ' + (m.from === 'lead' ? 'out' : 'in') + (first ? ' first' : '');
    el.innerHTML = m.html + '<span class="spacer"></span><span class="meta">' + m.time + (m.from === 'lead' ? TICKS : '') + '</span>';
    return el;
  }

  function player(card, idx) {
    var d = data[idx];
    var chat = card.querySelector('.chat');
    var sub = card.querySelector('.sub');
    var replay = card.querySelector('.replay'), skip = card.querySelector('.skip');
    var run = 0, played = false;
    function clear() { Array.prototype.slice.call(chat.querySelectorAll('.msg')).forEach(function (el) { el.remove(); }); sub.textContent = 'Cuenta de empresa'; sub.classList.remove('typing'); }
    function scroll() { chat.scrollTop = chat.scrollHeight; }
    function showAll() {
      run++; clear();
      var prev = null;
      d.messages.forEach(function (m) { chat.appendChild(bubble(m, prev !== m.from)); prev = m.from; });
      scroll(); played = true; skip.disabled = true;
    }
    function play() {
      var mine = ++run; clear(); skip.disabled = false; played = true;
      var prev = null, i = 0;
      function step() {
        if (mine !== run) return;
        if (i >= d.messages.length) { skip.disabled = true; return; }
        var m = d.messages[i++];
        var len = m.html.length;
        if (m.from === 'bot') {
          sub.textContent = 'escribiendo…'; sub.classList.add('typing');
          setTimeout(function () {
            if (mine !== run) return;
            sub.textContent = 'Cuenta de empresa'; sub.classList.remove('typing');
            chat.appendChild(bubble(m, prev !== m.from)); prev = m.from; scroll();
            setTimeout(step, 700);
          }, Math.min(2600, 900 + len * 14));
        } else {
          setTimeout(function () {
            if (mine !== run) return;
            chat.appendChild(bubble(m, prev !== m.from)); prev = m.from; scroll();
            setTimeout(step, 900);
          }, i === 1 ? 500 : Math.min(1800, 600 + len * 12));
        }
      }
      step();
    }
    replay.addEventListener('click', play);
    skip.addEventListener('click', showAll);
    return { play: play, stop: function () { run++; }, get played() { return played; } };
  }

  cards.forEach(function (card, i) { if (card.dataset.i !== undefined) players[i] = player(card, Number(card.dataset.i)); });

  var current = 0;
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      var i = cards.indexOf(e.target);
      if (!e.isIntersecting) { if (players[i]) players[i].stop(); return; }
      current = i;
      Array.prototype.forEach.call(dots.children, function (d, k) { d.className = k === i ? 'on' : ''; });
      count.textContent = i === 0 ? cards.length - 1 + ' conversaciones' : i + ' / ' + (cards.length - 1);
      if (players[i] && !players[i].played) players[i].play();
    });
  }, { root: deck, threshold: 0.6 });
  cards.forEach(function (c) { io.observe(c); });

  // reporte.html#3 opens on conversation 3 (share a specific one).
  var hash = parseInt(location.hash.slice(1), 10);
  if (hash >= 1 && hash < cards.length) deck.scrollTo({ left: cards[hash].offsetLeft, behavior: 'auto' });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') goTo(current + 1);
    if (e.key === 'ArrowLeft') goTo(current - 1);
  });
})();
</script>
</body></html>
`;
}
