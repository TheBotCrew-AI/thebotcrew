/* Medicina Regenerativa — menú móvil, FAQ y formulario de contacto (ES/EN). */
(function () {
  'use strict';

  var lang = document.documentElement.lang === 'en' ? 'en' : 'es';

  /* ─── Menú móvil ─── */
  var toggle = document.querySelector('.menu-toggle');
  var menu = document.getElementById('mobile-menu');
  if (toggle && menu) {
    var setOpen = function (open) {
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? toggle.dataset.labelClose : toggle.dataset.labelOpen);
      menu.hidden = !open;
      document.body.classList.toggle('menu-open', open);
    };
    toggle.addEventListener('click', function () {
      setOpen(toggle.getAttribute('aria-expanded') !== 'true');
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') {
        setOpen(false);
        toggle.focus();
      }
    });
    menu.addEventListener('click', function (e) {
      if (e.target.closest('a')) setOpen(false);
    });
    window.addEventListener('resize', function () {
      if (window.innerWidth > 1240 && toggle.getAttribute('aria-expanded') === 'true') setOpen(false);
    });
  }

  /* ─── FAQ ─── */
  document.querySelectorAll('.faq__btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!open));
      document.getElementById(btn.getAttribute('aria-controls')).hidden = open;
    });
  });

  /* ─── Formulario ─── */
  var form = document.getElementById('contact-form');
  if (!form) return;

  var T = {
    es: {
      required: 'Completa este campo.',
      phone: 'Revisa el número e incluye el código de país.',
      email: 'Ingresa un correo electrónico válido.',
      consent: 'Revisa el aviso y marca la casilla para enviar tu solicitud.',
      tooLong: 'Usa un máximo de 500 caracteres.',
      general: 'No pudimos enviar tu solicitud. Intenta nuevamente o contáctanos por teléfono o WhatsApp.',
      sending: 'Enviando…'
    },
    en: {
      required: 'Please complete this field.',
      phone: 'Check the number and include the country code.',
      email: 'Enter a valid email address.',
      consent: 'Review the notice and check the box to submit your request.',
      tooLong: 'Please use no more than 500 characters.',
      general: "We couldn't send your request. Please try again or contact us by phone or WhatsApp.",
      sending: 'Sending…'
    }
  }[lang];

  var MAX_MSG = 500;
  var el = function (name) { return form.elements[name]; };
  var status = document.getElementById('form-status');
  var submit = form.querySelector('[type="submit"]');
  var submitLabel = submit.textContent;
  var sending = false;

  // Tratamiento preseleccionado desde una ficha: /contacto?t=<código>
  var pre = new URLSearchParams(window.location.search).get('t');
  if (pre) {
    var sel = el('treatment_interest');
    if (Array.prototype.some.call(sel.options, function (o) { return o.value === pre; })) sel.value = pre;
  }

  // Contador del mensaje
  var msg = el('contact_message');
  var counter = document.getElementById('msg-counter');
  var updateCounter = function () {
    var n = msg.value.length;
    counter.textContent = n + ' / ' + MAX_MSG;
    counter.classList.toggle('is-over', n > MAX_MSG);
  };
  msg.addEventListener('input', updateCounter);
  updateCounter();

  var phoneDigits = function (v) { return v.replace(/\D/g, ''); };
  var validators = {
    full_name: function (v) { return v.trim().length >= 2 ? '' : T.required; },
    phone: function (v) {
      if (!v.trim()) return T.required;
      if (/[^\d\s()+.\-]/.test(v)) return T.phone;
      var d = phoneDigits(v).length;
      return d >= 11 && d <= 15 ? '' : T.phone;
    },
    email: function (v) {
      if (!v.trim()) return '';
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? '' : T.email;
    },
    treatment_interest: function (v) { return v ? '' : T.required; },
    preferred_language: function (v) { return v ? '' : T.required; },
    contact_message: function (v) { return v.length > MAX_MSG ? T.tooLong : ''; },
    contact_consent: function (_, input) { return input.checked ? '' : T.consent; }
  };

  var setError = function (name, message) {
    var box = document.getElementById('err-' + name);
    var input = el(name);
    var targets = input instanceof RadioNodeList ? Array.prototype.slice.call(input) : [input];
    targets.forEach(function (t) {
      if (message) t.setAttribute('aria-invalid', 'true');
      else t.removeAttribute('aria-invalid');
    });
    if (box) box.textContent = message;
  };

  var check = function (name) {
    var input = el(name);
    var value = input instanceof RadioNodeList ? input.value : input.value;
    var message = validators[name](value, input);
    setError(name, message);
    return message;
  };

  Object.keys(validators).forEach(function (name) {
    var input = el(name);
    var targets = input instanceof RadioNodeList ? Array.prototype.slice.call(input) : [input];
    targets.forEach(function (t) {
      // Revalida al corregir un campo que ya mostró error; no antes, para no regañar mientras se escribe.
      t.addEventListener(t.type === 'checkbox' || t.type === 'radio' || t.tagName === 'SELECT' ? 'change' : 'input', function () {
        if (document.getElementById('err-' + name).textContent) check(name);
      });
      t.addEventListener('blur', function () {
        if (t.value && t.type !== 'checkbox' && t.type !== 'radio') check(name);
      });
    });
  });

  // Volver con "Atrás" desde Gracias restaura la página congelada: rehabilita el botón.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) { sending = false; submit.disabled = false; submit.textContent = submitLabel; }
  });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (sending) return;
    status.textContent = '';

    var firstInvalid = null;
    Object.keys(validators).forEach(function (name) {
      if (check(name) && !firstInvalid) {
        var input = el(name);
        firstInvalid = input instanceof RadioNodeList ? input[0] : input;
      }
    });
    if (firstInvalid) { firstInvalid.focus(); return; }

    var payload = {
      full_name: el('full_name').value.trim(),
      phone: el('phone').value.trim(),
      email: el('email').value.trim(),
      treatment_interest: el('treatment_interest').value,
      preferred_language: el('preferred_language').value,
      contact_message: msg.value.trim(),
      contact_consent: el('contact_consent').checked,
      page_language: lang,
      source_page: window.location.pathname,
      company: el('company').value
    };

    sending = true;
    submit.disabled = true;
    submit.textContent = T.sending;

    fetch('/api/contact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          if (!res.ok || !body.ok) throw new Error('not_ok');
          window.location.assign(form.dataset.thanks);
        });
      })
      .catch(function () {
        sending = false;
        submit.disabled = false;
        submit.textContent = submitLabel;
        status.textContent = T.general;
      });
  });
})();
