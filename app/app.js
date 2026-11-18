(function () {
  'use strict';

  var cfg = window.NFCREV_CONFIG;
  var sb = window.supabase.createClient(cfg.url, cfg.key);
  var $app = document.getElementById('app');

  var BASE = location.origin + location.pathname.replace(/app\/(index\.html)?$/, '');
  function formUrl(slug) { return BASE + 'q/?l=' + encodeURIComponent(slug); }

  var TYPES = {
    stars: 'Stelle (1-5)',
    yesno: 'Sì / No',
    single: 'Scelta singola',
    multi: 'Scelta multipla',
    text: 'Testo libero'
  };
  var DEFAULTS = [
    { text: 'Come valuti la tua esperienza in generale?', type: 'stars', required: true },
    { text: 'Come valuti la pulizia?', type: 'stars' },
    { text: 'Come valuti il servizio?', type: 'stars' },
    { text: 'I prezzi ti sembrano adeguati?', type: 'yesno' },
    { text: 'Cosa potremmo migliorare?', type: 'text' }
  ];

  var S = {
    ready: false,
    session: null,
    authMode: 'login',
    authMsg: null,
    venues: [],
    venueId: null,
    tab: 'answers',
    questions: [],
    responses: [],
    filter: 'all',
    isAdmin: false,
    codes: [],
    editing: null,
    busy: false,
    installDismissed: false
  };
  var deferredInstall = null;

  // ---------- util ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function fmtDate(d) {
    try {
      return new Date(d).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' });
    } catch (e) { return String(d); }
  }
  function starsStr(n) {
    n = Math.max(0, Math.min(5, Math.round(n)));
    return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
  }
  function toast(msg) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 2400);
  }
  function currentVenue() {
    for (var i = 0; i < S.venues.length; i++) if (S.venues[i].id === S.venueId) return S.venues[i];
    return null;
  }
  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { toast('Copiato'); }, function () { toast('Copia non riuscita'); });
    }
    var ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('Copiato'); } catch (e) { toast('Copia non riuscita'); }
    ta.remove();
    return Promise.resolve();
  }
  function errText(e) {
    var m = (e && e.message) || String(e);
    if (/Failed to fetch|NetworkError/i.test(m)) return 'Nessuna connessione. Riprova.';
    return m;
  }

  // ---------- dati ----------
  function loadAll() {
    return Promise.all([
      sb.from('venues').select('*').order('created_at'),
      sb.from('admins').select('user_id')
    ]).then(function (r) {
      S.venues = (r[0].data) || [];
      S.isAdmin = !!(r[1].data && r[1].data.length);
      var saved = lsGet('nfcrev_venue');
      if (!currentVenue()) {
        var found = null;
        for (var i = 0; i < S.venues.length; i++) if (S.venues[i].id === saved) found = S.venues[i];
        S.venueId = found ? found.id : (S.venues[0] ? S.venues[0].id : null);
      }
      return S.venueId ? loadVenueData() : null;
    });
  }
  function loadVenueData() {
    if (!S.venueId) return Promise.resolve();
    return Promise.all([
      sb.from('questions').select('*').eq('venue_id', S.venueId).order('position').order('created_at'),
      sb.from('responses').select('*').eq('venue_id', S.venueId).order('created_at', { ascending: false }).limit(500)
    ]).then(function (r) {
      S.questions = r[0].data || [];
      S.responses = r[1].data || [];
    });
  }
  function loadCodes() {
    return sb.from('invite_codes').select('*').order('created_at', { ascending: false }).limit(200).then(function (r) {
      S.codes = r.data || [];
    });
  }

  // ---------- render ----------
  function render() {
    if (!S.ready) { $app.innerHTML = '<div class="wrap"><p class="muted">Caricamento…</p></div>'; return; }
    if (!S.session) { renderAuth(); return; }
    renderApp();
  }

  function renderAuth() {
    var reg = S.authMode === 'register';
    var msg = S.authMsg ? '<div class="msg ' + S.authMsg.kind + '">' + esc(S.authMsg.text) + '</div>' : '';
    $app.innerHTML =
      '<div class="wrap" style="padding-top:40px">' +
      '<div style="text-align:center;margin-bottom:18px"><div class="brand" style="color:var(--ink);font-size:20px">NFC <b>REV</b></div>' +
      '<p class="muted">Feedback dei tuoi clienti, semplice.</p></div>' +
      '<form class="card" id="authForm" autocomplete="on">' +
      '<h2>' + (reg ? 'Crea il tuo account' : 'Accedi') + '</h2>' + msg +
      '<label for="email">Email</label><input id="email" type="email" required autocomplete="email" inputmode="email">' +
      '<label for="pw">Password' + (reg ? ' (almeno 8 caratteri)' : '') + '</label>' +
      '<input id="pw" type="password" required minlength="' + (reg ? 8 : 1) + '" autocomplete="' + (reg ? 'new-password' : 'current-password') + '">' +
      (reg ? '<label for="code">Codice invito</label><input id="code" type="text" required autocapitalize="characters" autocomplete="off" placeholder="NFC-XXXX-XXXX">' +
        '<p class="muted" style="margin-top:6px">Il codice ti viene dato insieme al supporto NFC REV.</p>' : '') +
      '<div style="margin-top:16px"><button class="btn gold block" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (reg ? 'Registrati' : 'Entra') + '</button></div>' +
      '</form>' +
      '<p style="text-align:center"><button class="chip" id="switchAuth">' + (reg ? 'Ho già un account: accedi' : 'Ho un codice invito: registrati') + '</button></p>' +
      '</div>';
    document.getElementById('switchAuth').onclick = function () {
      S.authMode = reg ? 'login' : 'register'; S.authMsg = null; render();
    };
    document.getElementById('authForm').onsubmit = function (ev) {
      ev.preventDefault();
      var email = document.getElementById('email').value.trim();
      var pw = document.getElementById('pw').value;
      var codeEl = document.getElementById('code');
      var code = codeEl ? codeEl.value.trim().toUpperCase() : '';
      S.busy = true; S.authMsg = null; render();
      var p;
      if (reg) {
        p = sb.auth.signUp({ email: email, password: pw, options: { data: { invite_code: code } } }).then(function (r) {
          if (r.error) {
            if (/database error|invite|saving new user/i.test(r.error.message)) {
              throw new Error('Codice invito non valido o già usato.');
            }
            throw r.error;
          }
          if (!r.data.session) {
            S.authMode = 'login';
            S.authMsg = { kind: 'ok', text: 'Account creato. Controlla la tua email per confermarlo, poi accedi.' };
            return null;
          }
          S.session = r.data.session;
          return loadAll();
        });
      } else {
        p = sb.auth.signInWithPassword({ email: email, password: pw }).then(function (r) {
          if (r.error) {
            if (/invalid login/i.test(r.error.message)) throw new Error('Email o password non corrette.');
            if (/not confirmed/i.test(r.error.message)) throw new Error('Devi prima confermare l\'email: controlla la posta.');
            throw r.error;
          }
          S.session = r.data.session;
          return loadAll();
        });
      }
      p.catch(function (e) { S.authMsg = { kind: 'err', text: errText(e) }; })
        .then(function () { S.busy = false; render(); });
    };
  }

  function header() {
    var opts = S.venues.map(function (v) {
      return '<option value="' + esc(v.id) + '"' + (v.id === S.venueId ? ' selected' : '') + '>' + esc(v.name) + '</option>';
    }).join('');
    return '<div class="top"><div class="top-in"><span class="brand">NFC <b>REV</b></span>' +
      (S.venues.length ? '<select id="venueSel" aria-label="Locale">' + opts + '</select>' : '<span class="grow"></span>') +
      '<button class="logout" id="logout">Esci</button></div></div>';
  }
  function tabsBar() {
    var items = [['answers', '★', 'Risposte'], ['questions', '☰', 'Domande'], ['venue', '⚙', 'Locale']];
    if (S.isAdmin) items.push(['admin', '🔑', 'Admin']);
    return '<nav class="tabs">' + items.map(function (t) {
      return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '"><span class="ic">' + t[1] + '</span>' + t[2] + '</button>';
    }).join('') + '</nav>';
  }

  function renderApp() {
    var body;
    if (!S.venues.length && S.tab !== 'admin') body = viewNewVenueFirst();
    else if (S.tab === 'answers') body = viewAnswers();
    else if (S.tab === 'questions') body = viewQuestions();
    else if (S.tab === 'venue') body = viewVenue();
    else if (S.tab === 'admin' && S.isAdmin) body = viewAdmin();
    else body = viewAnswers();
    $app.innerHTML = header() + '<div class="wrap">' + body + '</div>' + tabsBar() + (S.editing ? modalQuestion() : '');
    bind();
  }

  // ---------- viste ----------
  function viewNewVenueFirst() {
    return '<div class="card"><h2>Benvenuto!</h2><p class="muted">Crea il tuo primo locale per ottenere il link e il QR code del questionario.</p>' +
      '<label for="nvName">Nome del locale</label><input id="nvName" type="text" maxlength="80" placeholder="Es. Bar Centrale">' +
      '<div style="margin-top:14px"><button class="btn gold block" id="nvCreate">Crea locale</button></div></div>';
  }

  function installCard() {
    if (isStandalone() || S.installDismissed || lsGet('nfcrev_install_hide') === '1') return '';
    var ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var inner = deferredInstall
      ? '<p>Aggiungi l\'app alla schermata Home per aprirla al volo.</p><button class="btn gold small" id="doInstall">Installa l\'app</button> '
      : (ios
        ? '<p>Per avere l\'app sulla Home: tocca <b>Condividi</b> (il quadrato con la freccia) e poi <b>Aggiungi alla schermata Home</b>.</p>'
        : '<p>Per avere l\'app sulla Home: apri il menu del browser (⋮) e scegli <b>Installa app</b> o <b>Aggiungi a schermata Home</b>.</p>');
    return '<div class="card">' + inner + '<button class="btn line small" id="hideInstall">Non mostrare più</button></div>';
  }

  function viewAnswers() {
    var rs = S.responses;
    var rated = rs.filter(function (r) { return r.rating; });
    var avg = rated.length ? rated.reduce(function (a, r) { return a + r.rating; }, 0) / rated.length : null;
    var news = rs.filter(function (r) { return r.status === 'new'; }).length;
    var dist = [0, 0, 0, 0, 0, 0];
    rated.forEach(function (r) { dist[r.rating]++; });
    var maxD = Math.max.apply(null, dist.slice(1).concat([1]));

    var filtered = rs.filter(function (r) {
      if (S.filter === 'new') return r.status === 'new';
      if (S.filter === 'open') return r.status !== 'resolved';
      if (S.filter === 'neg') return r.rating && r.rating <= 2;
      return true;
    });

    var h = installCard();
    h += '<div class="stat-grid" style="margin-bottom:12px">' +
      '<div class="stat"><b>' + rs.length + '</b><span>risposte</span></div>' +
      '<div class="stat"><b>' + (avg == null ? '–' : avg.toFixed(1).replace('.', ',')) + '</b><span>voto medio</span></div>' +
      '<div class="stat"><b>' + news + '</b><span>da leggere</span></div></div>';

    if (rated.length) {
      h += '<div class="card"><h3 style="margin-bottom:6px">Come ti hanno votato</h3>';
      for (var s = 5; s >= 1; s--) {
        h += '<div class="bar-row"><span class="lbl">' + s + '★</span><div class="bar"><i style="width:' + Math.round(dist[s] / maxD * 100) + '%"></i></div><span class="n">' + dist[s] + '</span></div>';
      }
      h += '</div>';
    }

    var chips = [['all', 'Tutte'], ['new', 'Nuove'], ['open', 'Non risolte'], ['neg', 'Negative']];
    h += '<div class="chips">' + chips.map(function (c) {
      return '<button class="chip' + (S.filter === c[0] ? ' on' : '') + '" data-filter="' + c[0] + '">' + c[1] + '</button>';
    }).join('') + '</div>';

    if (!filtered.length) {
      h += '<div class="empty">' + (rs.length ? 'Nessuna risposta con questo filtro.' : 'Ancora nessuna risposta.<br>Condividi il link o il QR del questionario dalla sezione <b>Locale</b>.') + '</div>';
    }
    filtered.forEach(function (r) {
      h += '<div class="card" data-rid="' + esc(r.id) + '">' +
        '<div class="spread"><div class="row wrap-r">' + (r.rating ? '<span class="stars">' + starsStr(r.rating) + '</span>' : '') +
        '<span class="muted">' + esc(fmtDate(r.created_at)) + '</span></div>' +
        '<span class="pill ' + esc(r.status) + '">' + ({ 'new': 'Nuova', read: 'Letta', resolved: 'Risolta' }[r.status] || '') + '</span></div>';
      (r.answers || []).forEach(function (a) {
        h += '<div class="ans"><div class="q">' + esc(a.text) + '</div><div class="v">' + esc(fmtAnswer(a)) + '</div></div>';
      });
      h += '<div class="row wrap-r" style="margin-top:12px">' +
        (r.status !== 'read' && r.status !== 'resolved' ? '<button class="btn line small" data-st="read">Segna letta</button>' : '') +
        (r.status !== 'resolved' ? '<button class="btn line small" data-st="resolved">Risolta</button>' : '<button class="btn line small" data-st="new">Riapri</button>') +
        '<button class="btn danger small" data-del="1">Elimina</button></div></div>';
    });
    return h;
  }
  function fmtAnswer(a) {
    var v = a.value;
    if (a.type === 'stars') return starsStr(Number(v)) + '  (' + v + '/5)';
    if (a.type === 'yesno') return v === 'si' ? 'Sì' : 'No';
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }

  function viewQuestions() {
    var v = currentVenue();
    var h = '<div class="spread" style="margin-bottom:10px"><div><h2>Domande</h2><p class="muted" style="margin:0">Le modifiche valgono subito per i nuovi clienti.</p></div>' +
      '<button class="btn gold small" id="addQ">+ Nuova</button></div>';
    if (v) h += '<p><a href="' + esc(formUrl(v.slug)) + '" target="_blank" rel="noopener">Vedi come lo vede il cliente</a></p>';
    if (!S.questions.length) h += '<div class="empty">Nessuna domanda. Aggiungine una.</div>';
    S.questions.forEach(function (q, i) {
      h += '<div class="card" data-qid="' + esc(q.id) + '"><div class="spread"><div class="grow"><b>' + esc(q.text) + '</b>' +
        '<div class="muted">' + esc(TYPES[q.type] || q.type) + (q.required ? ' · obbligatoria' : '') +
        (q.options && q.options.length ? ' · ' + q.options.length + ' opzioni' : '') + '</div></div>' +
        (q.active ? '' : '<span class="pill off">Spenta</span>') + '</div>' +
        '<div class="row wrap-r" style="margin-top:10px">' +
        '<button class="btn line small" data-mv="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="Su">↑</button>' +
        '<button class="btn line small" data-mv="1"' + (i === S.questions.length - 1 ? ' disabled' : '') + ' aria-label="Giù">↓</button>' +
        '<button class="btn line small" data-edit="1">Modifica</button>' +
        '<button class="btn line small" data-toggle="1">' + (q.active ? 'Spegni' : 'Accendi') + '</button>' +
        '<button class="btn danger small" data-qdel="1">Elimina</button></div></div>';
    });
    return h;
  }

  function modalQuestion() {
    var q = S.editing;
    var needsOpts = q.type === 'single' || q.type === 'multi';
    return '<div class="modal-bg" id="mbg"><div class="modal" role="dialog" aria-modal="true">' +
      '<div class="spread"><h2>' + (q.id ? 'Modifica domanda' : 'Nuova domanda') + '</h2><button class="chip" id="mclose">Chiudi</button></div>' +
      '<label for="qText">Testo della domanda</label><textarea id="qText" maxlength="200" style="min-height:70px">' + esc(q.text) + '</textarea>' +
      '<label for="qType">Tipo di risposta</label><select id="qType">' +
      Object.keys(TYPES).map(function (k) { return '<option value="' + k + '"' + (q.type === k ? ' selected' : '') + '>' + TYPES[k] + '</option>'; }).join('') + '</select>' +
      '<div id="optsBox"' + (needsOpts ? '' : ' class="hidden"') + '><label for="qOpts">Opzioni (una per riga)</label>' +
      '<textarea id="qOpts" placeholder="Es.&#10;Ottimo&#10;Buono&#10;Da migliorare">' + esc((q.options || []).join('\n')) + '</textarea></div>' +
      '<label class="check"><input type="checkbox" id="qReq"' + (q.required ? ' checked' : '') + '> Risposta obbligatoria</label>' +
      '<div id="mErr"></div>' +
      '<div style="margin-top:16px"><button class="btn gold block" id="qSave">Salva</button></div></div></div>';
  }

  function viewVenue() {
    var v = currentVenue();
    if (!v) return viewNewVenueFirst();
    var url = formUrl(v.slug);
    return '<div class="card"><h2>Link e QR code del questionario</h2>' +
      '<p class="muted">Programma questo link sul chip NFC e stampa il QR code per il supporto.</p>' +
      '<div class="linkbox"><input type="text" readonly id="linkOut" value="' + esc(url) + '"><button class="btn small" id="copyLink">Copia</button></div>' +
      '<div class="qa"><div id="qrBox"></div><div class="row wrap-r" style="justify-content:center">' +
      '<button class="btn line small" id="dlQr">Scarica QR (PNG)</button>' +
      '<a class="btn line small" href="' + esc(url) + '" target="_blank" rel="noopener">Apri</a></div></div></div>' +
      '<div class="card"><h2>Impostazioni del locale</h2>' +
      '<label for="vName">Nome del locale</label><input id="vName" type="text" maxlength="80" value="' + esc(v.name) + '">' +
      '<label for="vGoogle">Link recensione Google (facoltativo)</label>' +
      '<input id="vGoogle" type="url" placeholder="https://search.google.com/local/writereview?placeid=…" value="' + esc(v.google_review_url || '') + '">' +
      '<p class="muted" style="margin-top:4px">Ai clienti che danno 4 o 5 stelle viene proposto di lasciare anche una recensione su Google.</p>' +
      '<label for="vThanks">Messaggio di ringraziamento (facoltativo)</label>' +
      '<input id="vThanks" type="text" maxlength="300" placeholder="Grazie, il tuo parere ci aiuta a migliorare!" value="' + esc(v.thanks_text || '') + '">' +
      '<div id="vMsg"></div><div style="margin-top:14px"><button class="btn gold block" id="vSave">Salva</button></div></div>' +
      '<div class="card"><h2>Altri locali</h2><p class="muted">Aggiungi un altro locale: avrà il suo link, le sue domande e le sue risposte.</p>' +
      '<label for="nvName">Nome del nuovo locale</label><input id="nvName" type="text" maxlength="80">' +
      '<div style="margin-top:12px"><button class="btn line block" id="nvCreate">Aggiungi locale</button></div></div>' +
      '<div class="card"><h3>Zona pericolosa</h3><p class="muted">Elimina questo locale con tutte le sue domande e risposte.</p>' +
      '<button class="btn danger small" id="vDelete">Elimina locale</button></div>';
  }

  function viewAdmin() {
    var h = '<div class="card"><h2>Codici invito</h2><p class="muted">Un codice vale per un solo account. Consegnalo insieme al supporto.</p>' +
      '<label for="cQty">Quanti ne vuoi creare?</label><select id="cQty"><option>1</option><option>5</option><option>10</option><option>20</option></select>' +
      '<label for="cNote">Nota (facoltativa, es. nome del cliente)</label><input id="cNote" type="text" maxlength="80">' +
      '<div style="margin-top:12px"><button class="btn gold block" id="cGen">Genera</button></div></div>';
    if (!S.codes.length) h += '<div class="empty">Nessun codice.</div>';
    S.codes.forEach(function (c) {
      var st = c.used_by || c.used_at ? '<span class="pill resolved">Usato</span>' : (c.revoked ? '<span class="pill off">Annullato</span>' : '<span class="pill new">Libero</span>');
      h += '<div class="card" data-code="' + esc(c.code) + '"><div class="spread"><span class="code">' + esc(c.code) + '</span>' + st + '</div>' +
        (c.note ? '<div class="muted">' + esc(c.note) + '</div>' : '') +
        (c.used_email ? '<div class="muted">Usato da ' + esc(c.used_email) + ' · ' + esc(fmtDate(c.used_at)) + '</div>' : '') +
        '<div class="row" style="margin-top:8px"><button class="btn line small" data-ccopy="1">Copia</button>' +
        (!c.used_at && !c.revoked ? '<button class="btn danger small" data-crev="1">Annulla</button>' : '') + '</div></div>';
    });
    return h;
  }

  // ---------- eventi ----------
  function guard(p) {
    return p.catch(function (e) { toast(errText(e)); });
  }
  function bind() {
    var el;
    if ((el = document.getElementById('logout'))) el.onclick = function () {
      sb.auth.signOut().then(function () {
        S.session = null; S.venues = []; S.venueId = null; S.questions = []; S.responses = []; S.isAdmin = false; S.tab = 'answers';
        render();
      });
    };
    if ((el = document.getElementById('venueSel'))) el.onchange = function () {
      S.venueId = el.value; lsSet('nfcrev_venue', S.venueId);
      guard(loadVenueData().then(render));
    };
    Array.prototype.forEach.call(document.querySelectorAll('.tabs [data-tab]'), function (b) {
      b.onclick = function () {
        S.tab = b.getAttribute('data-tab');
        if (S.tab === 'admin') guard(loadCodes().then(render)); else render();
        window.scrollTo(0, 0);
      };
    });
    if ((el = document.getElementById('nvCreate'))) el.onclick = function () {
      var name = document.getElementById('nvName').value.trim();
      if (!name) { toast('Scrivi il nome del locale'); return; }
      el.disabled = true;
      guard(createVenue(name).then(function (v) {
        S.venues.push(v); S.venueId = v.id; lsSet('nfcrev_venue', v.id);
        return loadVenueData().then(function () { S.tab = 'questions'; render(); toast('Locale creato'); });
      })).then(function () { el.disabled = false; });
    };
    if ((el = document.getElementById('doInstall'))) el.onclick = function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; render(); });
    };
    if ((el = document.getElementById('hideInstall'))) el.onclick = function () {
      lsSet('nfcrev_install_hide', '1'); S.installDismissed = true; render();
    };

    // risposte
    Array.prototype.forEach.call(document.querySelectorAll('[data-filter]'), function (b) {
      b.onclick = function () { S.filter = b.getAttribute('data-filter'); render(); };
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-rid]'), function (card) {
      var id = card.getAttribute('data-rid');
      Array.prototype.forEach.call(card.querySelectorAll('[data-st]'), function (b) {
        b.onclick = function () {
          var st = b.getAttribute('data-st');
          guard(sb.from('responses').update({ status: st }).eq('id', id).then(function (r) {
            if (r.error) throw r.error;
            S.responses.forEach(function (x) { if (x.id === id) x.status = st; });
            render();
          }));
        };
      });
      var d = card.querySelector('[data-del]');
      if (d) d.onclick = function () {
        if (!confirm('Eliminare questa risposta?')) return;
        guard(sb.from('responses').delete().eq('id', id).then(function (r) {
          if (r.error) throw r.error;
          S.responses = S.responses.filter(function (x) { return x.id !== id; });
          render();
        }));
      };
    });

    // domande
    if ((el = document.getElementById('addQ'))) el.onclick = function () {
      S.editing = { id: null, text: '', type: 'stars', options: [], required: false }; render();
    };
    Array.prototype.forEach.call(document.querySelectorAll('[data-qid]'), function (card) {
      var id = card.getAttribute('data-qid');
      var q = S.questions.filter(function (x) { return x.id === id; })[0];
      var b;
      if ((b = card.querySelector('[data-edit]'))) b.onclick = function () {
        S.editing = { id: q.id, text: q.text, type: q.type, options: (q.options || []).slice(), required: q.required }; render();
      };
      if ((b = card.querySelector('[data-toggle]'))) b.onclick = function () {
        guard(sb.from('questions').update({ active: !q.active }).eq('id', id).then(function (r) {
          if (r.error) throw r.error; q.active = !q.active; render();
        }));
      };
      if ((b = card.querySelector('[data-qdel]'))) b.onclick = function () {
        if (!confirm('Eliminare questa domanda? Le risposte già ricevute restano.')) return;
        guard(sb.from('questions').delete().eq('id', id).then(function (r) {
          if (r.error) throw r.error;
          S.questions = S.questions.filter(function (x) { return x.id !== id; }); render();
        }));
      };
      Array.prototype.forEach.call(card.querySelectorAll('[data-mv]'), function (m) {
        m.onclick = function () { moveQuestion(id, parseInt(m.getAttribute('data-mv'), 10)); };
      });
    });
    if (S.editing) bindModal();

    // locale
    if ((el = document.getElementById('copyLink'))) el.onclick = function () { copyText(document.getElementById('linkOut').value); };
    if (document.getElementById('qrBox')) drawQr();
    if ((el = document.getElementById('dlQr'))) el.onclick = downloadQr;
    if ((el = document.getElementById('vSave'))) el.onclick = saveVenue;
    if ((el = document.getElementById('vDelete'))) el.onclick = function () {
      var v = currentVenue();
      if (!v || !confirm('Eliminare "' + v.name + '" con tutte le domande e le risposte? Non si può annullare.')) return;
      guard(sb.from('venues').delete().eq('id', v.id).then(function (r) {
        if (r.error) throw r.error;
        S.venues = S.venues.filter(function (x) { return x.id !== v.id; });
        S.venueId = S.venues[0] ? S.venues[0].id : null; S.questions = []; S.responses = [];
        return S.venueId ? loadVenueData() : null;
      }).then(function () { S.tab = 'answers'; render(); }));
    };

    // admin
    if ((el = document.getElementById('cGen'))) el.onclick = genCodes;
    Array.prototype.forEach.call(document.querySelectorAll('[data-code]'), function (card) {
      var code = card.getAttribute('data-code');
      var c = card.querySelector('[data-ccopy]');
      if (c) c.onclick = function () { copyText(code); };
      var r = card.querySelector('[data-crev]');
      if (r) r.onclick = function () {
        if (!confirm('Annullare il codice ' + code + '?')) return;
        guard(sb.from('invite_codes').update({ revoked: true }).eq('code', code).then(function (x) {
          if (x.error) throw x.error; return loadCodes();
        }).then(render));
      };
    });
  }

  function bindModal() {
    var close = function () { S.editing = null; render(); };
    document.getElementById('mclose').onclick = close;
    document.getElementById('mbg').onclick = function (e) { if (e.target.id === 'mbg') close(); };
    var typeSel = document.getElementById('qType');
    typeSel.onchange = function () {
      var box = document.getElementById('optsBox');
      if (typeSel.value === 'single' || typeSel.value === 'multi') box.classList.remove('hidden'); else box.classList.add('hidden');
    };
    document.getElementById('qSave').onclick = function () {
      var e = S.editing;
      var text = document.getElementById('qText').value.trim();
      var type = typeSel.value;
      var opts = document.getElementById('qOpts').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      var seen = {}; opts = opts.filter(function (o) { if (seen[o]) return false; seen[o] = 1; return true; }).map(function (o) { return o.slice(0, 80); });
      var req = document.getElementById('qReq').checked;
      var err = document.getElementById('mErr');
      if (!text) { err.innerHTML = '<div class="msg err">Scrivi il testo della domanda.</div>'; return; }
      if ((type === 'single' || type === 'multi') && opts.length < 2) { err.innerHTML = '<div class="msg err">Servono almeno 2 opzioni.</div>'; return; }
      if (type !== 'single' && type !== 'multi') opts = [];
      var row = { text: text, type: type, options: opts, required: req };
      var btn = document.getElementById('qSave'); btn.disabled = true;
      var p;
      if (e.id) {
        p = sb.from('questions').update(row).eq('id', e.id);
      } else {
        var maxPos = S.questions.reduce(function (m, q) { return Math.max(m, q.position); }, -1);
        row.venue_id = S.venueId; row.position = maxPos + 1;
        p = sb.from('questions').insert(row);
      }
      p.then(function (r) {
        if (r.error) throw r.error;
        S.editing = null;
        return loadVenueData();
      }).then(function () { render(); toast('Salvato'); })
        .catch(function (x) { btn.disabled = false; err.innerHTML = '<div class="msg err">' + esc(errText(x)) + '</div>'; });
    };
  }

  function moveQuestion(id, dir) {
    var list = S.questions.slice();
    var i = -1;
    for (var k = 0; k < list.length; k++) if (list[k].id === id) i = k;
    var j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    var jobs = [];
    list.forEach(function (q, idx) {
      if (q.position !== idx) {
        q.position = idx;
        jobs.push(sb.from('questions').update({ position: idx }).eq('id', q.id));
      }
    });
    S.questions = list;
    render();
    guard(Promise.all(jobs).then(function (rs) {
      rs.forEach(function (r) { if (r.error) throw r.error; });
    }));
  }

  function createVenue(name) {
    var base = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'locale';
    function attempt(n) {
      var slug = base + '-' + Math.random().toString(36).slice(2, 6);
      return sb.from('venues').insert({ name: name, slug: slug }).select().single().then(function (r) {
        if (r.error) {
          if (n < 4 && /duplicate|unique/i.test(r.error.message)) return attempt(n + 1);
          throw r.error;
        }
        var venue = r.data;
        var rows = DEFAULTS.map(function (d, i) {
          return { venue_id: venue.id, position: i, text: d.text, type: d.type, options: [], required: !!d.required };
        });
        return sb.from('questions').insert(rows).then(function (q) {
          if (q.error) throw q.error;
          return venue;
        });
      });
    }
    return attempt(0);
  }

  function saveVenue() {
    var v = currentVenue(); if (!v) return;
    var name = document.getElementById('vName').value.trim();
    var g = document.getElementById('vGoogle').value.trim();
    var th = document.getElementById('vThanks').value.trim();
    var out = document.getElementById('vMsg');
    if (!name) { out.innerHTML = '<div class="msg err">Il nome non può essere vuoto.</div>'; return; }
    if (g && !/^https:\/\//i.test(g)) { out.innerHTML = '<div class="msg err">Il link Google deve iniziare con https://</div>'; return; }
    var btn = document.getElementById('vSave'); btn.disabled = true;
    sb.from('venues').update({ name: name, google_review_url: g || null, thanks_text: th || null }).eq('id', v.id).then(function (r) {
      if (r.error) throw r.error;
      v.name = name; v.google_review_url = g || null; v.thanks_text = th || null;
      render(); toast('Salvato');
    }).catch(function (e) { btn.disabled = false; out.innerHTML = '<div class="msg err">' + esc(errText(e)) + '</div>'; });
  }

  function drawQr(size, into) {
    var v = currentVenue(); if (!v) return null;
    var box = into || document.getElementById('qrBox');
    box.innerHTML = '';
    if (!window.QRCode) { box.textContent = 'QR non disponibile offline.'; return null; }
    return new window.QRCode(box, { text: formUrl(v.slug), width: size || 220, height: size || 220, correctLevel: window.QRCode.CorrectLevel.M });
  }
  function downloadQr() {
    var v = currentVenue(); if (!v || !window.QRCode) return;
    var tmp = document.createElement('div');
    tmp.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(tmp);
    drawQr(768, tmp);
    setTimeout(function () {
      var cv = tmp.querySelector('canvas');
      if (cv) {
        // bordo bianco attorno al QR (zona di quiete)
        var pad = 64, out = document.createElement('canvas');
        out.width = cv.width + pad * 2; out.height = cv.height + pad * 2;
        var ctx = out.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, out.width, out.height);
        ctx.drawImage(cv, pad, pad);
        var a = document.createElement('a');
        a.href = out.toDataURL('image/png');
        a.download = 'qr-' + v.slug + '.png';
        document.body.appendChild(a); a.click(); a.remove();
      }
      tmp.remove();
    }, 60);
  }

  function genCodes() {
    var qty = parseInt(document.getElementById('cQty').value, 10) || 1;
    var note = document.getElementById('cNote').value.trim() || null;
    var alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    function part() {
      var arr = new Uint32Array(4); crypto.getRandomValues(arr);
      return Array.prototype.map.call(arr, function (n) { return alpha[n % alpha.length]; }).join('');
    }
    var rows = [];
    for (var i = 0; i < qty; i++) rows.push({ code: 'NFC-' + part() + '-' + part(), note: note });
    var btn = document.getElementById('cGen'); btn.disabled = true;
    guard(sb.from('invite_codes').insert(rows).then(function (r) {
      if (r.error) throw r.error; return loadCodes();
    }).then(function () { render(); toast(qty === 1 ? 'Codice creato' : qty + ' codici creati'); })).then(function () { btn.disabled = false; });
  }

  // ---------- avvio ----------
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); deferredInstall = e; if (S.session) render();
  });
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* ignore */ }); });
  }

  sb.auth.getSession().then(function (r) {
    S.session = r.data && r.data.session;
    return S.session ? loadAll() : null;
  }).catch(function () { /* mostra login */ }).then(function () {
    S.ready = true; render();
    sb.auth.onAuthStateChange(function (ev) {
      if (ev === 'SIGNED_OUT' && S.session) { S.session = null; render(); }
    });
  });
})();
