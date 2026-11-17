/* package-guidance site. Vanilla, no dependencies. */
(function () {
  'use strict';
  var d = document, root = d.documentElement;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var $ = function (s, c) { return (c || d).querySelector(s); };
  var $$ = function (s, c) { return Array.prototype.slice.call((c || d).querySelectorAll(s)); };

  /* ---------- theme ---------- */
  var mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function effective() { return root.dataset.theme || (mq && mq.matches ? 'dark' : 'light'); }
  function paint() {
    var dark = effective() === 'dark';
    if (dark) root.setAttribute('data-dark', ''); else root.removeAttribute('data-dark');
    var btn = $('[data-theme-toggle]');
    if (btn) btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    var meta = $$('meta[name="theme-color"]');
    meta.forEach(function (m) { m.setAttribute('content', dark ? '#090C14' : '#EEF0F2'); });
  }
  function snap(fn) {
    root.classList.add('no-trans'); fn(); void root.offsetHeight;
    requestAnimationFrame(function () { requestAnimationFrame(function () { root.classList.remove('no-trans'); }); });
  }
  paint();
  if (mq && mq.addEventListener) mq.addEventListener('change', function () { snap(paint); });
  var tbtn = $('[data-theme-toggle]');
  if (tbtn) tbtn.addEventListener('click', function () {
    var next = effective() === 'dark' ? 'light' : 'dark';
    snap(function () { root.dataset.theme = next; paint(); });
    try { localStorage.setItem('pg-theme', next); } catch (e) {}
  });

  /* ---------- sticky nav hairline ---------- */
  var nav = $('.nav');
  if (nav && 'IntersectionObserver' in window) {
    var sentinel = d.createElement('div');
    sentinel.style.cssText = 'position:absolute;top:0;height:1px;width:1px';
    d.body.prepend(sentinel);
    new IntersectionObserver(function (e) { nav.classList.toggle('is-stuck', !e[0].isIntersecting); }).observe(sentinel);
  }

  /* ---------- copy ---------- */
  function copyText(text, btn) {
    var done = function () {
      btn.classList.add('is-done');
      var label = btn.getAttribute('aria-label');
      btn.setAttribute('aria-label', 'Copied');
      clearTimeout(btn._t);
      btn._t = setTimeout(function () { btn.classList.remove('is-done'); btn.setAttribute('aria-label', label); }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text); done(); });
    } else { fallback(text); done(); }
  }
  function fallback(text) {
    var ta = d.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0'; d.body.appendChild(ta); ta.select();
    try { d.execCommand('copy'); } catch (e) {} d.body.removeChild(ta);
  }
  $$('.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var text = btn.getAttribute('data-copy');
      if (!text) { var code = btn.parentNode.querySelector('code'); text = code ? code.textContent : ''; }
      copyText(text.replace(/^[›$] /gm, ''), btn);
    });
  });

  /* ---------- tabs ---------- */
  $$('[data-tabs]').forEach(function (wrap) {
    var tabs = $$('[role="tab"]', wrap);
    function select(t, focus) {
      tabs.forEach(function (x) {
        var on = x === t;
        x.setAttribute('aria-selected', on ? 'true' : 'false');
        x.tabIndex = on ? 0 : -1;
        var p = d.getElementById(x.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      if (focus) t.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t); });
      t.addEventListener('keydown', function (e) {
        var k = e.key, j = -1;
        if (k === 'ArrowRight') j = (i + 1) % tabs.length;
        else if (k === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
        else if (k === 'Home') j = 0; else if (k === 'End') j = tabs.length - 1;
        if (j > -1) { e.preventDefault(); select(tabs[j], true); }
      });
    });
  });

  /* ---------- board: dot-matrix resolve (the one load moment) ---------- */
  if (!reduce) {
    var cells = $$('.board [data-flip]');
    var glyphs = '0123456789ABCDEFHKLMNPRSTUVXZ.-';
    cells.forEach(function (el, i) {
      var final = el.textContent, start = null, dur = 260 + (i % 4) * 60, delay = 120 + Math.floor(i / 4) * 45 + (i % 4) * 20;
      el.classList.add('flip-scramble');
      el.setAttribute('aria-hidden', 'true');
      var live = d.createElement('span'); live.className = 'vh'; live.textContent = final; el.after(live);
      function frame(ts) {
        if (start === null) start = ts + delay;
        var t = ts - start;
        if (t < 0) { requestAnimationFrame(frame); return; }
        var k = Math.min(1, t / dur), n = Math.floor(final.length * k), out = final.slice(0, n);
        for (var c = n; c < final.length; c++) out += final[c] === ' ' ? ' ' : glyphs[(Math.random() * glyphs.length) | 0];
        el.textContent = out;
        if (k < 1) requestAnimationFrame(frame);
        else { el.textContent = final; el.classList.remove('flip-scramble'); el.removeAttribute('aria-hidden'); live.remove(); }
      }
      requestAnimationFrame(frame);
    });
  }

  /* ---------- terminals: type once on view ---------- */
  var duo = $('[data-typer]');
  if (duo && !reduce && 'IntersectionObserver' in window) {
    var ctl = $('.typer-ctl'), skip = $('[data-typer-skip]'), replay = $('[data-typer-replay]');
    var bodies = $$('.term-body', duo);
    var runs = [];
    bodies.forEach(function (pre) {
      var parts = pre.innerHTML.split('\n');
      pre.innerHTML = parts.map(function (h) { return '<span class="ln">' + h + '</span>'; }).join('\n');
    });
    function lines(pre) { return $$('.ln', pre); }
    function hideAll() { bodies.forEach(function (p) { lines(p).forEach(function (l) { l.classList.add('ln-hide'); l.classList.remove('caret'); }); }); }
    function showAll() {
      runs.forEach(function (r) { r.dead = true; });
      bodies.forEach(function (p) { lines(p).forEach(function (l) { l.classList.remove('ln-hide', 'caret'); if (l._full != null) { l.innerHTML = l._full; l._full = null; } }); });
      skip.hidden = true; replay.hidden = false;
    }
    function play() {
      runs.forEach(function (r) { r.dead = true; }); runs = [];
      hideAll(); skip.hidden = false; replay.hidden = true;
      var pending = bodies.length;
      bodies.forEach(function (pre) {
        var run = { dead: false }; runs.push(run);
        var ls = lines(pre), i = 0;
        function next() {
          if (run.dead) return;
          if (i >= ls.length) { if (--pending === 0) { skip.hidden = true; replay.hidden = false; } return; }
          var l = ls[i++], isCmd = !!l.querySelector('.t-cmd'), isSay = !!l.querySelector('.t-say');
          l.classList.remove('ln-hide');
          if (isCmd) {
            var cmd = l.querySelector('.t-cmd'), full = cmd.innerHTML, prompt = '<span class="t-p">$</span> ';
            var text = cmd.textContent.replace(/^\$ /, ''), k = 0;
            l._full = l.innerHTML; l.classList.add('caret');
            (function type() {
              if (run.dead) return;
              cmd.innerHTML = prompt + text.slice(0, k).replace(/&/g, '&amp;').replace(/</g, '&lt;');
              if (k++ < text.length) setTimeout(type, 16 + Math.random() * 22);
              else { cmd.innerHTML = full; l._full = null; l.classList.remove('caret'); setTimeout(next, 380); }
            })();
          } else {
            setTimeout(next, isSay ? 420 : (l.textContent.trim() === '' ? 60 : 55));
          }
        }
        setTimeout(next, 200);
      });
    }
    ctl.hidden = false;
    skip.addEventListener('click', showAll);
    replay.addEventListener('click', play);
    duo.addEventListener('keydown', function (e) { if (!skip.hidden && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); showAll(); } });
    var seen = false;
    var io = new IntersectionObserver(function (e) {
      if (e[0].isIntersecting && !seen) { seen = true; io.disconnect(); play(); }
    }, { threshold: 0.35 });
    // hide before it scrolls into view so it doesn't flash complete then restart
    var rect = duo.getBoundingClientRect();
    if (rect.top > window.innerHeight * 0.65) hideAll();
    io.observe(duo);
  }

  /* ---------- ruler scrub ---------- */
  var ruler = $('[data-ruler]'), scrub = $('#scrub'), out = $('#scrub-out'), flag = $('[data-scrub-flag]');
  if (ruler && scrub && out) {
    var ages = $$('.dot', ruler).map(function (el) { return parseFloat(el.style.getPropertyValue('--x')) * 10; });
    var roAge = $('.ro-age', out), roMsg = $('.ro-msg', out);
    function label(h) {
      if (h < 24) return h + 'h';
      var dd = Math.floor(h / 24), hh = h % 24;
      return hh ? dd + 'd ' + hh + 'h' : dd + 'd';
    }
    function words(h) {
      if (h < 24) return h + (h === 1 ? ' hour' : ' hours') + ' after publish';
      var dd = Math.floor(h / 24), hh = h % 24;
      return dd + (dd === 1 ? ' day' : ' days') + (hh ? ' ' + hh + (hh === 1 ? ' hour' : ' hours') : '') + ' after publish';
    }
    function update() {
      var h = parseInt(scrub.value, 10), p = h / 240;
      ruler.style.setProperty('--p', p);
      flag.textContent = label(h);
      scrub.setAttribute('aria-valuetext', words(h));
      var younger = ages.filter(function (a) { return a * 24 < h; }).length;
      roAge.textContent = 'Installing at ' + label(h);
      var st, msg;
      if (h < 2) {
        st = '<b class="ro-st st-worm">compromised</b>';
        msg = 'Inside the chalk/debug window. An agent installing <code>@latest</code> now gets the malware.';
      } else if (h < 168) {
        st = '<b class="ro-st st-hold">held</b>';
        msg = 'Past the known ≈2h window but inside the cooldown, so package-guidance pins the previous settled release.' +
          (younger ? ' ' + younger + ' of the 39 fresh versions the plain agent installed were younger than this.' : '');
      } else {
        st = '<b class="ro-st st-ok">settled</b>';
        msg = 'Past the cooldown. This is the version package-guidance pins, unless a newer release fixes an advisory.';
      }
      roMsg.innerHTML = st + msg;
    }
    scrub.addEventListener('input', update);
    update();

    // beeswarm: stack dots that would touch at the current track width
    var swarm = $('.swarm', ruler), dots = $$('.dot', ruler);
    function layout() {
      var W = swarm.clientWidth, gap = 10.5, placed = [], top = 0;
      dots.forEach(function (el) {
        var px = parseFloat(el.style.getPropertyValue('--x')) * W, k = 0;
        while (placed.some(function (p) { return p[1] === k && Math.abs(p[0] - px) < gap; })) k++;
        placed.push([px, k]); el.style.setProperty('--y', k); top = Math.max(top, k);
      });
      swarm.style.minHeight = (34 + (top + 1) * 11) + 'px';
    }
    if (swarm) {
      layout();
      if ('ResizeObserver' in window) new ResizeObserver(layout).observe(swarm);
    }
  }
})();
