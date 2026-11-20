(function () {
  'use strict';

  var APP_VERSION = '4';
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
    owners: {},
    alerts: {},
    lastInvite: null,
    codes: [],
    editing: null,
    delVenue: false,
    recovery: /type=recovery/.test(location.hash),
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
  function myId() { return S.session && S.session.user ? S.session.user.id : null; }
  function isReadOnly() {
    var v = currentVenue();
    return !!(v && myId() && v.owner_id !== myId());
  }
  function roBanner() {
    var v = currentVenue();
    if (!isReadOnly()) return '';
    var who = S.owners[v.owner_id];
    return '<div class="msg info">Stai guardando il locale di un cliente' + (who ? ' (' + esc(who) + ')' : '') + ', in sola lettura.</div>';
  }
  function adminQBanner() {
    var v = currentVenue();
    var who = v && S.owners[v.owner_id];
    return '<div class="msg info">Stai modificando le domande del locale di un cliente' + (who ? ' (' + esc(who) + ')' : '') + '. Le modifiche valgono subito per i suoi clienti.</div>';
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
      if (!S.isAdmin) return null;
      return sb.rpc('admin_owner_emails').then(function (o) {
        S.owners = {};
        (o.data || []).forEach(function (x) { S.owners[x.user_id] = x.email; });
      });
    }).then(function () {
      var saved = lsGet('nfcrev_venue');
      if (!currentVenue()) {
        var found = null;
        for (var i = 0; i < S.venues.length; i++) if (S.venues[i].id === saved) found = S.venues[i];
        S.venueId = found ? found.id : (S.venues[0] ? S.venues[0].id : null);
      }
      return loadAlerts().then(function () { return S.venueId ? loadVenueData() : null; });
    });
  }
  // pareri negativi (1-2 stelle) ancora "nuovi", per locale
  function loadAlerts() {
    return sb.from('responses').select('venue_id').eq('status', 'new').lte('rating', 2).limit(1000).then(function (r) {
      if (r.error) return;
      var a = {};
      (r.data || []).forEach(function (x) { a[x.venue_id] = (a[x.venue_id] || 0) + 1; });
      S.alerts = a;
    }, function () { /* ignora */ });
  }
  function syncAlert() {
    if (!S.venueId) return;
    S.alerts[S.venueId] = S.responses.filter(function (r) { return r.status === 'new' && r.rating && r.rating <= 2; }).length;
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
    if (S.recovery && S.session) { renderRecovery(); return; }
    if (!S.session) { renderAuth(); return; }
    renderApp();
  }

  function renderAuth() {
    if (S.authMode === 'forgot') { renderForgot(); return; }
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
        '<p class="muted" style="margin-top:6px">Usa la stessa email che hai dato a NFC REV. Il codice ti viene consegnato insieme al supporto.</p>' : '') +
      '<div style="margin-top:16px"><button class="btn gold block" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (reg ? 'Registrati' : 'Entra') + '</button></div>' +
      '</form>' +
      '<p style="text-align:center"><button class="chip" id="switchAuth">' + (reg ? 'Ho già un account: accedi' : 'Ho un codice invito: registrati') + '</button></p>' +
      (reg ? '' : '<p style="text-align:center"><button class="chip" id="forgotLink">Password dimenticata?</button></p>') +
      '</div>';
    eyeify();
    var ver = document.createElement('p'); ver.className = 'muted'; ver.style.cssText = 'text-align:center;font-size:12px'; ver.textContent = 'Versione ' + APP_VERSION;
    $app.firstChild.appendChild(ver);
    var fl = document.getElementById('forgotLink');
    if (fl) fl.onclick = function () { S.authMode = 'forgot'; S.authMsg = null; render(); };
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
              throw new Error('Codice non valido, già usato, oppure email diversa da quella che hai dato a NFC REV.');
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
          S.session = r.data.session; S.recovery = false;
          return loadAll();
        });
      }
      p.catch(function (e) { S.authMsg = { kind: 'err', text: errText(e) }; })
        .then(function () { S.busy = false; render(); });
    };
  }

  // aggiunge l'occhio "mostra/nascondi" a ogni campo password della schermata
  var EYE_ON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.06-5.94"/><path d="M9.9 4.24A10.9 10.9 0 0 1 12 4c7 0 11 7 11 7a19.9 19.9 0 0 1-3.17 4.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/></svg>';
  function eyeify() {
    Array.prototype.forEach.call($app.querySelectorAll('input[type="password"]'), function (inp) {
      var wrap = document.createElement('div');
      wrap.className = 'pwwrap';
      inp.parentNode.insertBefore(wrap, inp);
      wrap.appendChild(inp);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'eye';
      btn.setAttribute('aria-label', 'Mostra password');
      btn.innerHTML = EYE_ON;
      btn.onclick = function () {
        var show = inp.type === 'password';
        inp.type = show ? 'text' : 'password';
        btn.innerHTML = show ? EYE_OFF : EYE_ON;
        btn.setAttribute('aria-label', show ? 'Nascondi password' : 'Mostra password');
        inp.focus();
      };
      wrap.appendChild(btn);
    });
  }

  function renderForgot() {
    var msg = S.authMsg ? '<div class="msg ' + S.authMsg.kind + '">' + esc(S.authMsg.text) + '</div>' : '';
    $app.innerHTML =
      '<div class="wrap" style="padding-top:40px">' +
      '<div style="text-align:center;margin-bottom:18px"><div class="brand" style="color:var(--ink);font-size:20px">NFC <b>REV</b></div></div>' +
      '<form class="card" id="forgotForm"><h2>Recupera la password</h2>' +
      '<p class="muted" style="margin-top:6px">Scrivi l\'email del tuo account: ti mandiamo un link per scegliere una nuova password.</p>' + msg +
      '<label for="fEmail">Email</label><input id="fEmail" type="email" required autocomplete="email" inputmode="email">' +
      '<div style="margin-top:16px"><button class="btn gold block" type="submit"' + (S.busy ? ' disabled' : '') + '>Invia il link</button></div></form>' +
      '<p style="text-align:center"><button class="chip" id="backLogin">Torna all\'accesso</button></p></div>';
    document.getElementById('backLogin').onclick = function () { S.authMode = 'login'; S.authMsg = null; render(); };
    document.getElementById('forgotForm').onsubmit = function (ev) {
      ev.preventDefault();
      var email = document.getElementById('fEmail').value.trim();
      S.busy = true; S.authMsg = null; render();
      sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }).then(function (r) {
        if (r.error) throw r.error;
        S.authMsg = { kind: 'ok', text: 'Se l\'email è registrata, ti abbiamo mandato un link. Controlla anche lo spam.' };
      }).catch(function (e) {
        S.authMsg = { kind: 'err', text: /rate limit|seconds/i.test(e.message || '') ? 'Hai chiesto troppi link. Riprova tra qualche minuto.' : errText(e) };
      }).then(function () { S.busy = false; render(); });
    };
  }

  function renderRecovery() {
    var msg = S.authMsg ? '<div class="msg ' + S.authMsg.kind + '">' + esc(S.authMsg.text) + '</div>' : '';
    $app.innerHTML =
      '<div class="wrap" style="padding-top:40px">' +
      '<div style="text-align:center;margin-bottom:18px"><div class="brand" style="color:var(--ink);font-size:20px">NFC <b>REV</b></div></div>' +
      '<form class="card" id="recForm"><h2>Scegli una nuova password</h2>' + msg +
      '<label for="np1">Nuova password (almeno 8 caratteri)</label><input id="np1" type="password" required minlength="8" autocomplete="new-password">' +
      '<label for="np2">Ripetila</label><input id="np2" type="password" required minlength="8" autocomplete="new-password">' +
      '<div style="margin-top:16px"><button class="btn gold block" type="submit"' + (S.busy ? ' disabled' : '') + '>Salva la password</button></div></form></div>';
    eyeify();
    document.getElementById('recForm').onsubmit = function (ev) {
      ev.preventDefault();
      var a = document.getElementById('np1').value, b = document.getElementById('np2').value;
      if (a !== b) { S.authMsg = { kind: 'err', text: 'Le due password non coincidono.' }; render(); return; }
      S.busy = true; S.authMsg = null; render();
      sb.auth.updateUser({ password: a }).then(function (r) {
        if (r.error) throw r.error;
        S.recovery = false;
        try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
        return loadAll();
      }).then(function () { S.authMsg = null; toast('Password cambiata'); })
        .catch(function (e) { S.authMsg = { kind: 'err', text: errText(e) }; })
        .then(function () { S.busy = false; render(); });
    };
  }

  function header() {
    var mine = [], others = [];
    S.venues.forEach(function (v) { (v.owner_id === myId() ? mine : others).push(v); });
    function opt(v, withOwner) {
      var who = withOwner && S.owners[v.owner_id] ? ' — ' + S.owners[v.owner_id] : '';
      var n = S.alerts[v.id] ? '  ⚠ ' + S.alerts[v.id] : '';
      return '<option value="' + esc(v.id) + '"' + (v.id === S.venueId ? ' selected' : '') + '>' + esc(v.name + who + n) + '</option>';
    }
    var opts = others.length
      ? (mine.length ? '<optgroup label="I miei locali">' + mine.map(function (v) { return opt(v, false); }).join('') + '</optgroup>' : '') +
        '<optgroup label="Locali dei clienti">' + others.map(function (v) { return opt(v, true); }).join('') + '</optgroup>'
      : mine.map(function (v) { return opt(v, false); }).join('');
    return '<div class="top"><div class="top-in"><span class="brand">NFC <b>REV</b></span>' +
      (S.venues.length ? '<select id="venueSel" aria-label="Locale">' + opts + '</select>' : '<span class="grow"></span>') +
      '<button class="logout" id="logout">Esci</button></div></div>';
  }
  function tabsBar() {
    var items = [['answers', '★', 'Risposte'], ['questions', '☰', 'Domande'], ['venue', '⚙', 'Locale']];
    if (S.isAdmin) items.push(['admin', '🔑', 'Admin']);
    return '<nav class="tabs">' + items.map(function (t) {
      var n = t[0] === 'answers' ? (S.alerts[S.venueId] || 0) : 0;
      var badge = n > 0 ? '<span class="badge">' + (n > 9 ? '9+' : n) + '</span>' : '';
      return '<button data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '"><span class="ic">' + t[1] + badge + '</span>' + t[2] + '</button>';
    }).join('') + '</nav>';
  }

  function renderApp() {
    var body;
    if (!S.venues.length && S.tab !== 'admin') body = viewNoVenue();
    else if (S.tab === 'answers') body = viewAnswers();
    else if (S.tab === 'questions') body = viewQuestions();
    else if (S.tab === 'venue') body = viewVenue();
    else if (S.tab === 'admin' && S.isAdmin) body = viewAdmin();
    else body = viewAnswers();
    $app.innerHTML = header() + '<div class="wrap">' + body + '</div>' + tabsBar() + (S.editing ? modalQuestion() : '') + (S.delVenue ? modalDelete() : '');
    bind();
  }

  // ---------- viste ----------
  function viewNoVenue() {
    if (S.isAdmin) {
      return '<div class="card"><h2>Nessun locale</h2><p class="muted">Crea un locale dalla scheda <b>Admin</b> (sezione "Aggiungi un locale").</p></div>';
    }
    return '<div class="card"><h2>Il tuo locale non è ancora attivo</h2><p class="muted">Contatta NFC REV: ti attiviamo noi il locale e poi trovi qui domande, risposte e il QR code.</p></div>';
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

    var ro = isReadOnly();
    var nAlert = S.alerts[S.venueId] || 0;
    var alertBox = nAlert > 0
      ? '<div class="msg err"><div class="spread"><b>⚠ ' + nAlert + (nAlert === 1 ? ' parere negativo da leggere' : ' pareri negativi da leggere') + '</b>' +
        '<button class="btn small" id="showNeg">Mostra</button></div></div>'
      : '';
    var h = roBanner() + alertBox + (ro ? '' : installCard());
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
      if (!ro) h += '<div class="row wrap-r" style="margin-top:12px">' +
        (r.status !== 'read' && r.status !== 'resolved' ? '<button class="btn line small" data-st="read">Segna letta</button>' : '') +
        (r.status !== 'resolved' ? '<button class="btn line small" data-st="resolved">Risolta</button>' : '<button class="btn line small" data-st="new">Riapri</button>') +
        '<button class="btn danger small" data-del="1">Elimina</button></div>';
      h += '</div>';
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
    var ro = isReadOnly() && !S.isAdmin;
    var h = (isReadOnly() ? (S.isAdmin ? adminQBanner() : roBanner()) : '') + '<div class="spread" style="margin-bottom:10px"><div><h2>Domande</h2><p class="muted" style="margin:0">' + (ro ? 'Domande attuali del questionario.' : 'Le modifiche valgono subito per i nuovi clienti.') + '</p></div>' +
      (ro ? '' : '<button class="btn gold small" id="addQ">+ Nuova</button>') + '</div>';
    if (v) h += '<p><a href="' + esc(formUrl(v.slug)) + '" target="_blank" rel="noopener">Vedi come lo vede il cliente</a></p>';
    if (!S.questions.length) h += '<div class="empty">' + (ro ? 'Nessuna domanda.' : 'Nessuna domanda. Aggiungine una.') + '</div>';
    S.questions.forEach(function (q, i) {
      h += '<div class="card" data-qid="' + esc(q.id) + '"><div class="spread"><div class="grow"><b>' + esc(q.text) + '</b>' +
        '<div class="muted">' + esc(TYPES[q.type] || q.type) + (q.required ? ' · obbligatoria' : '') +
        (q.options && q.options.length ? ' · ' + q.options.length + ' opzioni' : '') + '</div></div>' +
        (q.active ? '' : '<span class="pill off">Spenta</span>') + '</div>' +
        (ro ? '' : '<div class="row wrap-r" style="margin-top:10px">' +
        '<button class="btn line small" data-mv="-1"' + (i === 0 ? ' disabled' : '') + ' aria-label="Su">↑</button>' +
        '<button class="btn line small" data-mv="1"' + (i === S.questions.length - 1 ? ' disabled' : '') + ' aria-label="Giù">↓</button>' +
        '<button class="btn line small" data-edit="1">Modifica</button>' +
        '<button class="btn line small" data-toggle="1">' + (q.active ? 'Spegni' : 'Accendi') + '</button>' +
        '<button class="btn danger small" data-qdel="1">Elimina</button></div>') + '</div>';
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

  function modalDelete() {
    var v = currentVenue();
    if (!v) return '';
    return '<div class="modal-bg" id="dbg"><div class="modal" role="dialog" aria-modal="true">' +
      '<h2>Eliminare il locale?</h2>' +
      '<p class="muted" style="margin-top:8px">Stai per cancellare definitivamente <b>' + esc(v.name) + '</b> con tutte le sue domande e risposte. Il suo QR code smetterà di funzionare. Non si può annullare.</p>' +
      '<label for="dName">Per confermare scrivi: <b>' + esc(v.name) + '</b></label>' +
      '<input id="dName" type="text" autocomplete="off" autocapitalize="off">' +
      '<div id="dErr"></div>' +
      '<div class="row" style="margin-top:14px"><button class="btn line grow" id="dCancel">Annulla</button>' +
      '<button class="btn danger grow" id="dGo" disabled>Elimina definitivamente</button></div></div></div>';
  }

  function viewVenue() {
    var v = currentVenue();
    if (!v) return viewNoVenue();
    var url = formUrl(v.slug);
    var ro = isReadOnly();
    return roBanner() + '<div class="card"><h2>Link e QR code del questionario</h2>' +
      '<p class="muted">Programma questo link sul chip NFC e stampa il QR code per il supporto.</p>' +
      '<div class="linkbox"><input type="text" readonly id="linkOut" value="' + esc(url) + '"><button class="btn small" id="copyLink">Copia</button></div>' +
      '<div class="qa"><div id="qrBox"></div><div class="row wrap-r" style="justify-content:center">' +
      '<button class="btn line small" id="dlQr">Scarica QR (PNG)</button>' +
      '<a class="btn line small" href="' + esc(url) + '" target="_blank" rel="noopener">Apri</a></div></div></div>' +
      (ro ? '<div class="card"><h2>' + esc(v.name) + '</h2><p class="muted">Link recensione Google: ' + esc(v.google_review_url || 'non impostato') + '</p></div>' : '') +
      (ro ? '' : '<div class="card"><h2>Impostazioni del locale</h2>' +
      '<label for="vName">Nome del locale</label><input id="vName" type="text" maxlength="80" value="' + esc(v.name) + '">' +
      '<label for="vGoogle">Link recensione Google (facoltativo)</label>' +
      '<input id="vGoogle" type="url" placeholder="https://search.google.com/local/writereview?placeid=…" value="' + esc(v.google_review_url || '') + '">' +
      '<p class="muted" style="margin-top:4px">Ai clienti che danno 4 o 5 stelle viene proposto di lasciare anche una recensione su Google.</p>' +
      '<label for="vThanks">Messaggio di ringraziamento (facoltativo)</label>' +
      '<input id="vThanks" type="text" maxlength="300" placeholder="Grazie, il tuo parere ci aiuta a migliorare!" value="' + esc(v.thanks_text || '') + '">' +
      '<div id="vMsg"></div><div style="margin-top:14px"><button class="btn gold block" id="vSave">Salva</button></div></div>') +
      (S.isAdmin ? '<div class="card"><h3>Zona pericolosa</h3><p class="muted">Cancella definitivamente questo locale dal database, con tutte le sue domande e risposte. Il proprietario non lo vedrà più e il suo QR smetterà di funzionare.</p>' +
      '<button class="btn danger small" id="vDelete">Elimina locale</button></div>' : '');
  }

  function viewAdmin() {
    var myEmail = (S.session && S.session.user && S.session.user.email) || '';
    var li = S.lastInvite;
    var h = '';
    if (li) {
      h += '<div class="card" style="border-color:var(--gold)"><h2>Pronto per ' + esc(li.name) + '</h2>' +
        '<p class="muted" style="margin-top:6px">Il locale è già nel tuo account: prendi link e QR, poi consegna il codice al cliente.</p>' +
        '<label>Codice invito</label><div class="linkbox"><input type="text" readonly value="' + esc(li.code) + '" class="code"><button class="btn small" id="liCopy">Copia</button></div>' +
        '<p class="muted" style="margin-top:8px">Il cliente deve registrarsi con questa email: <b>' + esc(li.email) + '</b></p>' +
        '<div class="row wrap-r" style="margin-top:10px"><button class="btn gold small" id="liGo">Apri il locale (link e QR)</button>' +
        '<button class="btn line small" id="liClose">Chiudi</button></div></div>';
    }
    h += '<div class="card"><h2>Nuovo cliente</h2><p class="muted">Crei il locale e il codice. Il locale resta nel tuo account finché il cliente non si registra con la sua email e il codice.</p>' +
      '<label for="cVenue">Nome del locale</label><input id="cVenue" type="text" maxlength="80" placeholder="Es. Bar Centrale">' +
      '<label for="cEmail">Email del cliente</label><input id="cEmail" type="email" placeholder="nome@esempio.it" autocapitalize="off" inputmode="email">' +
      '<div id="cMsg"></div>' +
      '<div style="margin-top:12px"><button class="btn gold block" id="cGen">Crea locale e codice</button></div></div>' +
      '<div class="card"><h2>Aggiungi un locale a un account</h2><p class="muted">Per un cliente che ha già un account (anche il tuo) e vuole un altro locale.</p>' +
      '<label for="aEmail">Email dell\'account</label><input id="aEmail" type="email" value="' + esc(myEmail) + '">' +
      '<label for="aName">Nome del nuovo locale</label><input id="aName" type="text" maxlength="80">' +
      '<div id="aMsg"></div><div style="margin-top:12px"><button class="btn line block" id="aAdd">Aggiungi locale</button></div></div>';
    if (!S.codes.length) h += '<div class="empty">Nessun codice.</div>';
    S.codes.forEach(function (c) {
      var st = c.used_by || c.used_at ? '<span class="pill resolved">Usato</span>' : (c.revoked ? '<span class="pill off">Annullato</span>' : '<span class="pill new">Libero</span>');
      h += '<div class="card" data-code="' + esc(c.code) + '"><div class="spread"><span class="code">' + esc(c.code) + '</span>' + st + '</div>' +
        (c.venue_name ? '<div><b>' + esc(c.venue_name) + '</b></div>' : '') +
        (c.email ? '<div class="muted">Per: ' + esc(c.email) + '</div>' : '') +
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
    var sel = document.getElementById('venueSel');
    if (sel) sel.onchange = function () {
      S.venueId = sel.value; lsSet('nfcrev_venue', S.venueId);
      guard(loadVenueData().then(render));
    };
    Array.prototype.forEach.call(document.querySelectorAll('.tabs [data-tab]'), function (b) {
      b.onclick = function () {
        S.tab = b.getAttribute('data-tab');
        if (S.tab === 'admin') guard(loadCodes().then(render)); else render();
        window.scrollTo(0, 0);
      };
    });
    if ((el = document.getElementById('doInstall'))) el.onclick = function () {
      if (!deferredInstall) return;
      deferredInstall.prompt();
      deferredInstall.userChoice.then(function () { deferredInstall = null; render(); });
    };
    if ((el = document.getElementById('hideInstall'))) el.onclick = function () {
      lsSet('nfcrev_install_hide', '1'); S.installDismissed = true; render();
    };

    // risposte
    if ((el = document.getElementById('showNeg'))) el.onclick = function () { S.filter = 'neg'; render(); };
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
            syncAlert();
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
          syncAlert();
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
      S.delVenue = true; render();
      var inp = document.getElementById('dName'); if (inp) inp.focus();
    };
    if (S.delVenue) bindDelete();

    // admin
    if ((el = document.getElementById('cGen'))) el.onclick = genCodes;
    if ((el = document.getElementById('liCopy'))) el.onclick = function () { copyText(S.lastInvite.code); };
    if ((el = document.getElementById('liClose'))) el.onclick = function () { S.lastInvite = null; render(); };
    if ((el = document.getElementById('liGo'))) el.onclick = function () {
      S.venueId = S.lastInvite.venue_id; lsSet('nfcrev_venue', S.venueId); S.tab = 'venue';
      guard(loadVenueData().then(function () { render(); window.scrollTo(0, 0); }));
    };
    var addBtn = document.getElementById('aAdd');
    if (addBtn) addBtn.onclick = function () {
      var email = document.getElementById('aEmail').value.trim();
      var name = document.getElementById('aName').value.trim();
      var out = document.getElementById('aMsg');
      if (!email || !name) { out.innerHTML = '<div class="msg err">Compila email e nome del locale.</div>'; return; }
      addBtn.disabled = true;
      sb.rpc('admin_add_venue', { p_email: email, p_name: name }).then(function (r) {
        if (r.error) throw r.error;
        return loadAll();
      }).then(function () { render(); toast('Locale aggiunto'); })
        .catch(function (e) {
          addBtn.disabled = false;
          out.innerHTML = '<div class="msg err">' + esc(/USER_NOT_FOUND/.test(e.message) ? 'Nessun account con questa email.' : errText(e)) + '</div>';
        });
    };
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

  function bindDelete() {
    var v = currentVenue();
    var close = function () { S.delVenue = false; render(); };
    document.getElementById('dCancel').onclick = close;
    document.getElementById('dbg').onclick = function (e) { if (e.target.id === 'dbg') close(); };
    var inp = document.getElementById('dName'), go = document.getElementById('dGo');
    inp.oninput = function () {
      go.disabled = !v || inp.value.trim().toLowerCase() !== v.name.trim().toLowerCase();
    };
    go.onclick = function () {
      if (!v || go.disabled) return;
      go.disabled = true;
      sb.from('venues').delete().eq('id', v.id).select('id').then(function (r) {
        if (r.error) throw r.error;
        if (!r.data || !r.data.length) throw new Error('Eliminazione non riuscita: mancano i permessi. Hai eseguito il file SQL?');
        S.venues = S.venues.filter(function (x) { return x.id !== v.id; });
        S.venueId = S.venues[0] ? S.venues[0].id : null; S.questions = []; S.responses = [];
        S.delVenue = false;
        return S.venueId ? loadVenueData() : null;
      }).then(function () { S.tab = 'answers'; render(); toast('Locale eliminato'); })
        .catch(function (e) {
          go.disabled = false;
          document.getElementById('dErr').innerHTML = '<div class="msg err">' + esc(errText(e)) + '</div>';
        });
    };
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
        p = sb.from('questions').update(row).eq('id', e.id).select('id');
      } else {
        var maxPos = S.questions.reduce(function (m, q) { return Math.max(m, q.position); }, -1);
        row.venue_id = S.venueId; row.position = maxPos + 1;
        p = sb.from('questions').insert(row);
      }
      p.then(function (r) {
        if (r.error) throw r.error;
        if (e.id && (!r.data || !r.data.length)) throw new Error('Modifica non riuscita: mancano i permessi. Hai eseguito il file SQL?');
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
    var name = document.getElementById('cVenue').value.trim();
    var email = document.getElementById('cEmail').value.trim();
    var out = document.getElementById('cMsg');
    if (!name || !email) { out.innerHTML = '<div class="msg err">Scrivi il nome del locale e l\'email del cliente.</div>'; return; }
    var btn = document.getElementById('cGen'); btn.disabled = true;
    sb.rpc('admin_create_invite', { p_email: email, p_venue_name: name }).then(function (r) {
      if (r.error) throw r.error;
      S.lastInvite = { code: r.data.code, venue_id: r.data.venue_id, email: email.toLowerCase(), name: name };
      return loadAll();
    }).then(function () { return loadCodes(); })
      .then(function () { render(); toast('Locale e codice creati'); })
      .catch(function (e) {
        btn.disabled = false;
        var m = (e && e.message) || '';
        var t = /EMAIL_ALREADY_REGISTERED/.test(m) ? 'Questa email ha già un account: usa "Aggiungi un locale a un account".'
          : /EMAIL_INVALID/.test(m) ? 'L\'email non sembra valida.'
          : /function .*admin_create_invite|schema cache/i.test(m) ? 'Manca l\'aggiornamento del database: esegui il file codice-con-email.sql.'
          : errText(e);
        out.innerHTML = '<div class="msg err">' + esc(t) + '</div>';
      });
  }

  // ---------- aggiornamento automatico ----------
  function paintBadge() {
    var ic = document.querySelector('.tabs [data-tab="answers"] .ic');
    if (!ic) return;
    var old = ic.querySelector('.badge'); if (old) old.remove();
    var n = S.alerts[S.venueId] || 0;
    if (n > 0) { var b = document.createElement('span'); b.className = 'badge'; b.textContent = n > 9 ? '9+' : n; ic.appendChild(b); }
  }
  function refresh() {
    if (!S.session || S.recovery || S.editing || S.delVenue || !S.venueId) return;
    var onAnswers = S.tab === 'answers';
    Promise.all([loadAlerts(), onAnswers ? loadVenueData() : null]).then(function () {
      if (S.editing || S.delVenue) return;
      if (onAnswers && S.tab === 'answers') render(); else paintBadge();
    });
  }
  setInterval(function () { if (!document.hidden) refresh(); }, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });

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
    if (/error_code=otp_expired|error=access_denied/.test(location.hash)) {
      S.authMsg = { kind: 'err', text: 'Il link è scaduto o già usato. Richiedine uno nuovo da "Password dimenticata?".' };
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
    S.ready = true; render();
    sb.auth.onAuthStateChange(function (ev, sess) {
      if (ev === 'PASSWORD_RECOVERY') { S.recovery = true; S.session = sess || S.session; render(); }
      if (ev === 'SIGNED_OUT' && S.session) { S.session = null; render(); }
    });
  });
})();
