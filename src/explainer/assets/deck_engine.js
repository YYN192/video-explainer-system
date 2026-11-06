/* Explainer System — deterministic deck engine (Phase 1).
   Builds slide DOM from window.DECK once, then renderAt(t) sets the full visual
   state for any time t. Driven by window.TIMELINE (slide windows + word timestamps)
   injected by the renderer. No wall-clock, no CSS animation -> same input, same frames. */
(function () {
  // seeded PRNG so anything stochastic is deterministic across captures
  var _s = 42; Math.random = function () { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };

  var DECK = window.DECK || { slides: [] };
  var stage = document.getElementById('stage');
  var captionEl = document.getElementById('caption');
  var ambient = document.getElementById('ambient');
  if (ambient && DECK.ambient === false) { ambient.style.display = 'none'; ambient = null; }

  // persistent brand watermark on every slide, in a bottom corner within the safe zone
  if (DECK.watermark) {
    var wm = document.createElement('img');
    wm.id = 'watermark'; wm.src = DECK.watermark;
    var wmSize = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.085);
    wm.style.width = wm.style.height = wmSize + 'px';
    wm.style.bottom = Math.round(window.innerHeight * ((DECK.safe_bottom || 0.14) * 0.5 + 0.03)) + 'px';
    var inset = Math.round(window.innerWidth * 0.045) + 'px';
    if ((DECK.watermark_corner || 'bl') === 'br') wm.style.right = inset; else wm.style.left = inset;
    document.body.appendChild(wm);
  }

  function easeOut(x) { x = Math.min(1, Math.max(0, x)); return 1 - Math.pow(1 - x, 3); }

  // --- stat count-up: parse "$2.5M" / "90%" / "10,000" / "3x" and animate 0 -> value ---
  function splitNum(s) {
    var m = String(s).match(/^(\D*)([\d,]*\.?\d+)(.*)$/);
    if (!m) return null;
    var raw = m[2].replace(/,/g, '');
    return { pre: m[1], num: parseFloat(raw), suf: m[3],
             dec: (raw.split('.')[1] || '').length, comma: m[2].indexOf(',') >= 0 };
  }
  function fmtStat(v, info) {
    var s = info.dec > 0 ? v.toFixed(info.dec) : String(Math.round(v));
    if (info.comma) s = Number(s).toLocaleString('en-US');
    return info.pre + s + info.suf;
  }
  function countUp(eln, g) {
    if (!eln) return;
    if (eln.__info === undefined) eln.__info = splitNum(eln.dataset.val);
    var info = eln.__info; if (!info) return;  // non-numeric -> leave the literal text
    eln.textContent = fmtStat(info.num * Math.max(0, Math.min(1, g)), info);
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function backOut(x) { x = clamp01(x); var c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); }
  // deterministic per-frame noise (glitch jitter) — a hash of the frame index, never wall-clock
  function hashNoise(n) { var x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

  // intro transition styles (theme motion personality + per-slide override, PRD §8.4).
  // p = eased progress 0..1, raw = linear progress, t = absolute time (for glitch jitter).
  function introTransform(style, p, raw, t) {
    var vw = window.innerWidth, vh = window.innerHeight;
    switch (style) {
      case 'fade':  return 'translateY(0)';
      case 'pop':   return 'scale(' + (0.92 + 0.08 * p) + ')';
      case 'slide': return 'translateX(' + ((1 - p) * -70) + 'px)';
      // --- energetic set (BRAINROT profile) ---
      case 'zoom':  return 'scale(' + (1.55 - 0.55 * backOut(raw)).toFixed(4) + ')';
      case 'spin':  return 'rotate(' + ((1 - p) * -28).toFixed(2) + 'deg) scale(' + (0.6 + 0.4 * backOut(raw)).toFixed(4) + ')';
      case 'whip':  return 'translateX(' + ((1 - p) * vw * 1.1).toFixed(1) + 'px) skewX(' + ((1 - p) * -18).toFixed(2) + 'deg)';
      case 'drop':  return 'translateY(' + ((1 - backOut(raw)) * -vh * 0.55).toFixed(1) + 'px)';
      case 'glitch':
        if (raw >= 1) return 'translate(0,0)';
        var n = Math.floor(t * 30), a = (1 - raw) * 34;
        return 'translate(' + ((hashNoise(n) - 0.5) * a).toFixed(1) + 'px,' + ((hashNoise(n + 7) - 0.5) * a * 0.5).toFixed(1) +
          'px) skewX(' + ((hashNoise(n + 3) - 0.5) * (1 - raw) * 16).toFixed(2) + 'deg)';
      case 'wipe':  return 'translateY(0)';  // the wipe itself is a clip-path, set in renderAt
      case 'rise':
      default:      return 'translateY(' + ((1 - p) * 40) + 'px)';
    }
  }

  // --- math (EDUCATIONAL + any deck with equations): LaTeX placeholders typeset by the
  // vendored MathJax 3 (SVG output, no fonts, no network) once at load — before
  // __deckReady — so every captured frame shows finished SVG. Never typeset per frame.
  var TEX = [];
  function texSpan(tex, display) {
    TEX.push({ tex: String(tex || ''), display: !!display });
    return '<span class="tex" data-ti="' + (TEX.length - 1) + '"></span>';
  }
  function attrEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function cueAttr(cue) { return cue ? ' data-cue="' + attrEsc(cue) + '"' : ''; }

  // --- scene2d: a small declarative SVG vocabulary (lines, arrows, circles, paths, labels,
  // math labels, travelling waves, moving wavefronts). Authored as JSON data, drawn on /
  // animated by renderAt(t). Coordinates are in the slide's viewBox units (default 1600x900).
  var SCENES = {};
  function colorOf(c) {
    return { fg: 'var(--fg)', accent: 'var(--accent)', accent2: 'var(--accent2)', muted: 'rgba(150,160,175,.55)' }[c] || c || 'var(--fg)';
  }
  function buildScene(s) {
    var vb = s.viewbox || [1600, 900], defs = '', body = '';
    SCENES[s.id] = (s.shapes || []);
    (s.shapes || []).forEach(function (sh, i) {
      var col = colorOf(sh.color), sw = sh.width || 4, k = sh.kind;
      var clip = '';
      if (sh.clip) {
        defs += '<clipPath id="clip_' + s.id + '_' + i + '"><rect x="' + sh.clip[0] + '" y="' + sh.clip[1] +
          '" width="' + sh.clip[2] + '" height="' + sh.clip[3] + '"></rect></clipPath>';
        clip = ' clip-path="url(#clip_' + s.id + '_' + i + ')"';
      }
      var common = ' data-si="' + i + '" stroke="' + col + '" stroke-width="' + sw + '" stroke-linecap="round" stroke-linejoin="round"' +
        (sh.dash ? ' stroke-dasharray="' + sh.dash + '"' : '') + clip;
      var fill = sh.fill ? colorOf(sh.fill === true ? sh.color : sh.fill) : 'none';
      if (k === 'line' || k === 'arrow') {
        body += '<line class="sh draw"' + common + ' x1="' + sh.x1 + '" y1="' + sh.y1 + '" x2="' + sh.x2 + '" y2="' + sh.y2 + '" pathLength="1"></line>';
        if (k === 'arrow' || sh.arrow) {
          var dx = sh.x2 - sh.x1, dy = sh.y2 - sh.y1, L = Math.sqrt(dx * dx + dy * dy) || 1, hl = sh.head || 26;
          dx /= L; dy /= L;
          var bx = sh.x2 - hl * dx, by = sh.y2 - hl * dy, nx = -dy * hl * 0.55, ny = dx * hl * 0.55;
          body += '<polygon class="sh-head" data-hi="' + i + '" fill="' + col + '"' + clip + ' points="' + sh.x2 + ',' + sh.y2 + ' ' +
            (bx + nx).toFixed(1) + ',' + (by + ny).toFixed(1) + ' ' + (bx - nx).toFixed(1) + ',' + (by - ny).toFixed(1) + '"></polygon>';
        }
      } else if (k === 'path') {
        body += '<path class="sh draw"' + common + ' fill="' + fill + '" d="' + attrEsc(sh.d || '') + '" pathLength="1"></path>';
      } else if (k === 'polyline') {
        body += '<polyline class="sh draw"' + common + ' fill="none" points="' + (sh.points || []).map(function (p) { return p[0] + ',' + p[1]; }).join(' ') + '" pathLength="1"></polyline>';
      } else if (k === 'circle') {
        body += '<circle class="sh draw"' + common + ' fill="' + fill + '" cx="' + sh.cx + '" cy="' + sh.cy + '" r="' + sh.r + '" pathLength="1"></circle>';
      } else if (k === 'rect') {
        body += '<rect class="sh fadein"' + common + ' fill="' + fill + '" x="' + sh.x + '" y="' + sh.y + '" width="' + sh.w + '" height="' + sh.h + '" rx="' + (sh.rx || 0) + '"></rect>';
      } else if (k === 'text') {
        body += '<text class="sh fadein scene-text" data-si="' + i + '" x="' + sh.x + '" y="' + sh.y + '" fill="' + col + '" font-size="' + (sh.size || 40) +
          '" text-anchor="' + (sh.anchor || 'middle') + '" dominant-baseline="middle"' + clip + '>' + (sh.text || '') + '</text>';
      } else if (k === 'math') {
        var mw = sh.w || 420, mh = sh.h || 140;
        body += '<foreignObject class="sh fadein" data-si="' + i + '" x="' + (sh.x - mw / 2) + '" y="' + (sh.y - mh / 2) + '" width="' + mw + '" height="' + mh + '">' +
          '<div xmlns="http://www.w3.org/1999/xhtml" class="scene-math" style="font-size:' + (sh.size || 40) + 'px;color:' + col + '">' +
          texSpan(sh.latex, false) + '</div></foreignObject>';
      } else if (k === 'wave') {
        body += '<polyline class="sh wave"' + common + ' fill="none" points=""></polyline>';
      } else if (k === 'wavefronts') {
        var range = sh.mode === 'circle' ? (sh.r_max || 400) : Math.abs((sh.x_end || 0) - (sh.x || 0));
        var cnt = Math.ceil(range / (sh.spacing || 60)) + 1, paths = '';
        for (var c = 0; c < cnt; c++) paths += '<path fill="none" d=""></path>';
        body += '<g class="sh wf"' + common + '>' + paths + '</g>';
      }
    });
    return '<svg class="scene" viewBox="0 0 ' + vb[0] + ' ' + vb[1] + '" preserveAspectRatio="xMidYMid meet">' +
      (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';
  }

  // word-cue timing: the start time of the first narration word (in this slide) that begins
  // with `cue`'s first word — so a reveal lands exactly when the narrator says it.
  var _wordsBySlide = {};
  function slideWords(id) {
    if (!_wordsBySlide[id]) {
      var tl = window.TIMELINE || { words: [] };
      _wordsBySlide[id] = tl.words.filter(function (w) { return w.slide === id; });
    }
    return _wordsBySlide[id];
  }
  function cueKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  // Exact word matches win over prefix matches ("wave" must not fire on an earlier "wavefronts");
  // `after` restricts the search to words spoken at/after that time (sequential reveals).
  function cueTime(id, cue, fallback, after) {
    if (!cue) return fallback;
    var want = cueKey(String(cue).split(/\s+/)[0]);
    if (!want) return fallback;
    var ws = slideWords(id), from = after || -1, i;
    for (i = 0; i < ws.length; i++) { if (ws[i].start >= from && cueKey(ws[i].word) === want) return ws[i].start; }
    for (i = 0; i < ws.length; i++) { if (ws[i].start >= from && cueKey(ws[i].word).indexOf(want) === 0) return ws[i].start; }
    return Math.max(fallback, from);
  }

  function renderScene(el, win, t) {
    var shapes = SCENES[win.id] || [];
    if (!el.__sh) {  // resolve nodes + start times once (cue lookups need TIMELINE, so lazily)
      el.__sh = shapes.map(function (sh, i) {
        var at = sh.at !== undefined ? win.start + Number(sh.at)
          : (sh.step !== undefined ? win.start + 0.3 + Number(sh.step) * (sh.step_s || 0.8) : win.start + 0.15);
        return { sh: sh, t0: cueTime(win.id, sh.cue, at), node: el.querySelector('[data-si="' + i + '"]'),
                 head: el.querySelector('[data-hi="' + i + '"]') };
      });
    }
    el.__sh.forEach(function (o) {
      var sh = o.sh, n = o.node; if (!n) return;
      var tt = t - o.t0, dur = sh.dur || 0.8, k = sh.kind;
      if (n.classList.contains('draw') && sh.dash) {
        n.style.opacity = clamp01(tt / 0.4).toFixed(3);
        if (o.head) o.head.style.opacity = n.style.opacity;
      } else if (n.classList.contains('draw')) {
        var dp = clamp01(tt / dur), ep = easeOut(dp);
        n.style.strokeDasharray = '1 1'; n.style.strokeDashoffset = (1 - ep).toFixed(4);
        n.style.opacity = tt >= 0 ? 1 : 0;
        if (n.getAttribute('fill') !== 'none') n.style.fillOpacity = clamp01((tt - dur * 0.6) / 0.4).toFixed(3);
        if (o.head) o.head.style.opacity = dp > 0.9 ? 1 : 0;
      } else if (n.classList.contains('fadein')) {
        n.style.opacity = clamp01(tt / 0.4).toFixed(3);
      } else if (k === 'wave') {
        n.style.opacity = clamp01(tt / 0.4).toFixed(3);
        var dx = sh.x2 - sh.x1, dy = sh.y2 - sh.y1, L = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / L, uy = dy / L;
        var lam = sh.wavelength || 200, amp = sh.amp || 40, ph = 2 * Math.PI * ((sh.speed || 0) * Math.max(0, tt)) / lam + (sh.phase || 0);
        var pts = [], N = 140;
        for (var q = 0; q <= N; q++) {
          var s0 = L * q / N, off = amp * Math.sin(2 * Math.PI * s0 / lam - ph);
          pts.push((sh.x1 + ux * s0 - uy * off).toFixed(1) + ',' + (sh.y1 + uy * s0 + ux * off).toFixed(1));
        }
        n.setAttribute('points', pts.join(' '));
      } else if (k === 'wavefronts') {
        n.style.opacity = tt >= 0 ? 1 : 0;
        var sp = sh.spacing || 60, v = sh.speed || 60, adv = v * Math.max(0, tt), paths = n.children;
        for (var c = 0; c < paths.length; c++) {
          var d = '', op = 1;
          if (sh.mode === 'circle') {
            var r = (adv % sp) + (paths.length - 1 - c) * sp, rmax = sh.r_max || 400;
            if (r > 2 && r <= rmax && r <= adv) {
              var a0 = (sh.a0 !== undefined ? sh.a0 : -90) * Math.PI / 180, a1 = (sh.a1 !== undefined ? sh.a1 : 90) * Math.PI / 180;
              var large = (a1 - a0) > Math.PI ? 1 : 0;
              d = 'M' + (sh.cx + r * Math.cos(a0)).toFixed(1) + ',' + (sh.cy + r * Math.sin(a0)).toFixed(1) +
                ' A' + r.toFixed(1) + ',' + r.toFixed(1) + ' 0 ' + large + ' 1 ' + (sh.cx + r * Math.cos(a1)).toFixed(1) + ',' + (sh.cy + r * Math.sin(a1)).toFixed(1);
              op = 1 - 0.7 * (r / rmax);
            }
          } else {  // plane wavefronts moving +x from x to x_end
            var x = sh.x + (adv % sp) + c * sp;
            if (x <= sh.x_end) d = 'M' + x.toFixed(1) + ',' + sh.y1 + ' L' + x.toFixed(1) + ',' + sh.y2;
          }
          paths[c].setAttribute('d', d);
          paths[c].style.opacity = op.toFixed(3);
        }
      }
    });
  }

  // wrap any word in `accent`/`accent2` lists with a highlight span
  function headlineHTML(text, accent, accent2) {
    accent = accent || []; accent2 = accent2 || [];
    var aset = {}, a2set = {};
    var key0 = function (w) { return w.toLowerCase().replace(/[^a-z0-9']/g, ''); };
    accent.forEach(function (w) { aset[key0(w)] = 1; });
    accent2.forEach(function (w) { a2set[key0(w)] = 1; });
    return text.split(/(\s+)/).map(function (tok) {
      var key = tok.toLowerCase().replace(/[^a-z0-9']/g, '');
      if (aset[key]) return '<span class="accent">' + tok + '</span>';
      if (a2set[key]) return '<span class="accent2">' + tok + '</span>';
      return tok;
    }).join('');
  }

  // build one .slide element per deck slide, structured by type
  DECK.slides.forEach(function (s) {
    var el = document.createElement('section');
    el.className = 'slide'; el.dataset.id = s.id; el.dataset.type = s.type;
    var html = '';
    if (s.kicker) html += '<div class="kicker">' + s.kicker + '</div>';
    // McKinsey action/"so-what" title pinned at top (the message; the visual below proves it).
    // Accent words use the same accent/accent2 lists, so the insight word reads in indigo.
    if (s.title) html += '<div class="slidetitle' + (s.title.length > 48 ? ' sm' : '') + '">' +
      headlineHTML(s.title, s.accent, s.accent2) + '</div>';
    if (s.type === 'diagram') {
      html += '<div class="bars">' + (s.bars || []).map(function (b) {
        var bk = b.kind === 'muted' ? 'muted' : (b.kind === 'bad' ? 'bad' : '');
        return '<div class="barcol"><div class="bar ' + bk +
          '" data-val="' + (b.value || 0) + '"></div><div class="barlabel">' + (b.label || '') + '</div></div>';
      }).join('') + '</div>';
    } else if (s.type === 'stat') {
      html += '<div class="statnum" data-val="' + (s.value || '') + '">' + (s.value || '') + '</div>';
      if (s.label) html += '<div class="statlabel">' + s.label + '</div>';
    } else if (s.type === 'statgrid') {
      html += '<div class="statgrid">' + (s.stats || []).map(function (st) {
        return '<div class="statcell"><div class="statnum" data-val="' + (st.value || '') + '">' +
          (st.value || '') + '</div><div class="statlabel">' + (st.label || '') + '</div></div>';
      }).join('') + '</div>';
    } else if (s.type === 'progress') {
      html += '<div class="progresspct">0%</div>' +
        '<div class="progresstrack"><div class="progressfill" data-val="' + (s.value || 0) + '"></div></div>';
      if (s.label) html += '<div class="statlabel">' + s.label + '</div>';
    } else if (s.type === 'compare') {
      var L = s.left || {}, R = s.right || {};
      html += '<div class="compare">' +
        '<div class="cmpcard ' + (L.kind === 'bad' ? 'bad' : 'good') + '"><div class="cmptitle">' +
          (L.title || '') + '</div><div class="cmpval">' + (L.value || '') + '</div></div>' +
        '<div class="cmpvs">vs</div>' +
        '<div class="cmpcard ' + (R.kind === 'bad' ? 'bad' : 'good') + '"><div class="cmptitle">' +
          (R.title || '') + '</div><div class="cmpval">' + (R.value || '') + '</div></div>' +
        '</div>';
    } else if (s.type === 'steps') {
      html += '<div class="steps">' + (s.steps || []).map(function (st, i) {
        var title = (typeof st === 'string') ? st : (st.title || '');
        var text = (typeof st === 'string') ? '' : (st.text || '');
        return '<div class="step"><div class="stepnum">' + (i + 1) + '</div><div class="stepbody">' +
          '<div class="steptitle">' + title + '</div>' +
          (text ? '<div class="steptext">' + text + '</div>' : '') + '</div></div>';
      }).join('') + '</div>';
    } else if (s.type === 'pictograph') {
      var pf = Math.max(0, parseInt(s.filled, 10) || 0);
      var ptot = Math.max(pf, parseInt(s.total, 10) || pf);
      var pk = s.kind === 'bad' ? 'bad' : 'good';
      var pcells = '';
      for (var pi = 0; pi < ptot; pi++) pcells += '<div class="picto-cell ' + (pi < pf ? 'on ' + pk : '') + '"></div>';
      // columns from the total so small/odd counts aren't ragged in a fixed 5-col grid
      var pcols = ptot <= 5 ? ptot : (ptot % 5 === 0 ? 5 : (ptot % 4 === 0 ? 4 : (ptot % 3 === 0 ? 3 : 5)));
      html += '<div class="pictograph" style="grid-template-columns:repeat(' + pcols + ',1fr)">' + pcells + '</div>';
      if (s.label) html += '<div class="statlabel">' + s.label + '</div>';
    } else if (s.type === 'trend') {
      var tk = s.kind === 'bad' ? 'bad' : 'good';
      el.dataset.points = JSON.stringify(s.points || []);
      html += '<div class="trendwrap"><svg class="trend ' + tk + '" viewBox="0 0 100 60" preserveAspectRatio="none">' +
        '<polyline class="trend-line" points=""></polyline></svg>' +
        '<div class="trend-dot"></div><div class="trend-end">' + (s.end_label || '') + '</div></div>';
      if (s.label) html += '<div class="statlabel">' + s.label + '</div>';
    } else if (s.type === 'ring') {
      var rk = s.kind === 'bad' ? 'bad' : 'good';
      html += '<div class="ringwrap"><svg class="ring ' + rk + '" viewBox="0 0 100 100">' +
        '<circle class="ring-track" cx="50" cy="50" r="42"></circle>' +
        '<circle class="ring-fill" cx="50" cy="50" r="42" data-val="' + (s.value || 0) + '"></circle>' +
        '</svg><div class="ring-pct">0%</div></div>';
      if (s.label) html += '<div class="statlabel">' + s.label + '</div>';
    } else if (s.type === 'ranked') {
      html += '<div class="ranked">' + (s.bars || []).map(function (b) {
        var rbk = b.kind === 'muted' ? 'muted' : (b.kind === 'bad' ? 'bad' : '');
        return '<div class="rankrow' + (b.kind === 'muted' ? ' muted' : '') + '"><div class="ranktop">' +
          '<span class="ranklabel">' + (b.label || '') + '</span>' +
          (b.display ? '<span class="rankval">' + b.display + '</span>' : '') + '</div>' +
          '<div class="ranktrack"><div class="rankbar ' + rbk +
          '" data-val="' + (b.value || 0) + '"></div></div></div>';
      }).join('') + '</div>';
    } else if (s.type === 'delta') {
      var dk = s.kind === 'bad' ? 'bad' : 'good';
      html += '<div class="delta">' +
        '<div class="delta-cell"><div class="delta-val" data-val="' + (s.from || '') + '">' + (s.from || '') + '</div>' +
        (s.from_label ? '<div class="delta-lab">' + s.from_label + '</div>' : '') + '</div>' +
        '<div class="delta-arrow">&rarr;</div>' +
        '<div class="delta-cell"><div class="delta-val ' + dk + '" data-val="' + (s.to || '') + '">' + (s.to || '') + '</div>' +
        (s.to_label ? '<div class="delta-lab">' + s.to_label + '</div>' : '') + '</div></div>';
      if (s.change) html += '<div class="delta-badge ' + dk + '">' + s.change + '</div>';
    } else if (s.type === 'timeline') {
      var evs = s.events || [];
      html += '<div class="timeline"><div class="tl-track"><div class="tl-line"></div>' + evs.map(function (e, i) {
        var left = evs.length > 1 ? (i / (evs.length - 1) * 100) : 50;
        return '<div class="tl-event" style="left:' + left.toFixed(2) + '%"><div class="tl-dot"></div>' +
          '<div class="tl-date">' + (e.date || '') + '</div><div class="tl-evlabel">' + (e.label || '') + '</div></div>';
      }).join('') + '</div></div>';
    } else if (s.type === 'waterfall') {
      var wfStart = s.start || {}, wfEnd = s.end || {}, wfSteps = s.steps || [];
      var run = Number(wfStart.value) || 0, maxTop = Math.max(0, run), wcols = [];
      wcols.push({ label: wfStart.label || '', floor: 0, val: run, cls: 'tot' });
      wfSteps.forEach(function (st) {
        var v = Number(st.value) || 0, floor = v >= 0 ? run : run + v;
        wcols.push({ label: st.label || '', floor: floor, val: Math.abs(v), cls: (st.kind === 'bad' || v < 0) ? 'bad' : 'good' });
        run += v; if (run > maxTop) maxTop = run;
      });
      var endVal = (wfEnd.value === undefined || wfEnd.value === null) ? run : Number(wfEnd.value);
      wcols.push({ label: wfEnd.label || '', floor: 0, val: endVal, cls: 'tot' });
      if (endVal > maxTop) maxTop = endVal;
      el.dataset.wfmax = String(maxTop || 1);
      html += '<div class="waterfall">' + wcols.map(function (c) {
        return '<div class="wf-col"><div class="wf-barwrap"><div class="wf-bar ' + c.cls +
          '" data-floor="' + c.floor + '" data-val="' + c.val + '"></div></div>' +
          '<div class="wf-label">' + c.label + '</div></div>';
      }).join('') + '</div>';
    } else if (s.type === 'matrix') {
      var xa = s.x_axis || ['', ''], ya = s.y_axis || ['', ''];
      html += '<div class="matrix"><div class="mx-plot"><div class="mx-axisx"></div><div class="mx-axisy"></div>' +
        (s.points || []).map(function (p) {
          return '<div class="mx-pt ' + (p.kind === 'bad' ? 'bad' : 'good') + '" style="left:' +
            (Number(p.x) * 100).toFixed(1) + '%;bottom:' + (Number(p.y) * 100).toFixed(1) + '%">' +
            '<span class="mx-ptlab">' + (p.label || '') + '</span></div>';
        }).join('') + '</div>' +
        '<div class="mx-xlo">' + (xa[0] || '') + '</div><div class="mx-xhi">' + (xa[1] || '') + '</div>' +
        '<div class="mx-ylo">' + (ya[0] || '') + '</div><div class="mx-yhi">' + (ya[1] || '') + '</div></div>';
    } else if (s.type === 'reframe') {
      var rtot = ((s.before || '') + (s.strike || '') + (s.after || '')).length;
      html += '<div class="reframe headline sm' + (rtot > 38 ? ' xs' : '') + '">' +
        '<span class="rf-before">' + (s.before || '') + ' </span>' +
        '<span class="rf-strike"><span class="rf-line"></span>' + (s.strike || '') + '</span>' +
        '<span class="rf-arrow"> &rarr; </span>' +
        '<span class="rf-after accent">' + (s.after || '') + '</span></div>';
    } else if (s.type === 'highlight') {
      var mset = {};
      (s.mark || []).forEach(function (w) { mset[w.toLowerCase().replace(/[^a-z0-9']/g, '')] = 1; });
      var hcls = (s.headline && s.headline.length > 60) ? 'headline sm' : 'headline';
      html += '<div class="' + hcls + '">' + (s.headline || '').split(/(\s+)/).map(function (tok) {
        if (mset[tok.toLowerCase().replace(/[^a-z0-9']/g, '')]) return '<span class="hl"><span class="hl-bg"></span>' + tok + '</span>';
        return tok;
      }).join('') + '</div>';
    } else if (s.type === 'build') {
      var bacc = {}, bacc2 = {};
      (s.accent || []).forEach(function (w) { bacc[w.toLowerCase().replace(/[^a-z0-9']/g, '')] = 1; });
      (s.accent2 || []).forEach(function (w) { bacc2[w.toLowerCase().replace(/[^a-z0-9']/g, '')] = 1; });
      var bcls = (s.headline && s.headline.length > 60) ? 'headline sm' : 'headline';
      html += '<div class="' + bcls + ' buildline">' + (s.headline || '').split(/\s+/).filter(Boolean).map(function (w) {
        var k = w.toLowerCase().replace(/[^a-z0-9']/g, '');
        return '<span class="bw' + (bacc[k] ? ' accent' : (bacc2[k] ? ' accent2' : '')) + '">' + w + '</span>';
      }).join(' ') + '</div>';
    } else if (s.type === 'punch') {
      var pcls = s.kind === 'bad' ? ' accent2' : (s.kind === 'good' ? ' accent' : '');
      var pword = s.word || s.headline || '';
      var psz = pword.length <= 5 ? '' : (pword.length <= 8 ? ' md' : ' sm');  // shrink so long words don't clip
      html += '<div class="punch' + psz + pcls + '">' + pword + '</div>';
    } else if (s.type === 'list') {
      html += '<div class="list">' + (s.items || []).map(function (it, i) {
        return '<div class="li-row"><span class="li-num">' + (i + 1) + '</span><span class="li-text">' + it + '</span></div>';
      }).join('') + '</div>';
    } else if (s.type === 'define') {
      var dtcls = (s.term || '').length > 16 ? ' sm' : '';  // long terms drop a size
      html += '<div class="define"><div class="def-term' + dtcls + '">' + (s.term || '') + '</div>' +
        '<div class="def-body">' + (s.definition || '') + '</div></div>';
    } else if (s.type === 'quote') {
      html += '<div class="quoteblock"><div class="quotemark">“</div><div class="quotetext">' +
        (s.quote || s.headline || '') + '</div>' +
        (s.attribution ? '<div class="quoteattr">— ' + s.attribution + '</div>' : '') + '</div>';
    } else if (s.type === 'figure') {
      html += '<div class="figframe"><img src="' + s.image + '" alt=""></div>';
      if (s.caption) html += '<div class="figcaption">' + s.caption + '</div>';
    } else if (s.type === 'equation') {
      // one display equation (verbatim from the source) + a legend that explains each symbol
      html += '<div class="eqmain">' + texSpan(s.latex, true) + '</div>';
      if (s.label) html += '<div class="eqlabel">' + s.label + '</div>';
      if ((s.symbols || []).length) html += '<div class="eqlegend">' + s.symbols.map(function (sy) {
        return '<div class="eqrow"' + cueAttr(sy.cue) + '><span class="eqsym">' + texSpan(sy.tex || sy.symbol || '', false) +
          '</span><span class="eqmean">' + (sy.meaning || '') +
          (sy.unit ? ' <span class="equnit">(' + sy.unit + ')</span>' : '') + '</span></div>';
      }).join('') + '</div>';
    } else if (s.type === 'derivation') {
      // a step-by-step sequence of lines — ONLY steps that appear in the source (see check.py)
      html += '<div class="deriv">' + (s.steps || []).map(function (st) {
        return '<div class="drow"' + cueAttr(st.cue) + '><div class="dmath">' + texSpan(st.latex, true) + '</div>' +
          (st.note ? '<div class="dnote">' + st.note + '</div>' : '') + '</div>';
      }).join('') + '</div>';
    } else if (s.type === 'scene2d') {
      html += buildScene(s);
      if (s.caption) html += '<div class="figcaption">' + s.caption + '</div>';
    } else if (s.type === 'meme') {
      // original meme-format card (setup / reaction emoji / punchline) — no third-party images
      html += '<div class="meme"><div class="meme-setup">' + (s.setup || '') + '</div>' +
        (s.emoji ? '<div class="meme-emoji">' + s.emoji + '</div>' : '') +
        '<div class="meme-punch">' + headlineHTML(s.punch || '', s.accent, s.accent2) + '</div></div>';
    } else if (s.type === 'cta') {
      var b = DECK.brand || {}, c = b.cta || {};
      if (b.product) html += '<div class="figframe cta-product"><img src="' + b.product + '" alt=""></div>';
      if (b.logo) html += '<img class="cta-logo" src="' + b.logo + '" alt="">';
      if (c.headline) html += '<div class="headline sm cta-head">' + c.headline + '</div>';
      if (c.subkicker) html += '<div class="subkicker">' + c.subkicker + '</div>';
      if (c.url) html += '<div class="cta-url">' + c.url + '</div>';
    } else {
      var cls = (s.headline && s.headline.length > 60) ? 'headline sm' : 'headline';
      html += '<div class="' + cls + '">' + headlineHTML(s.headline || '', s.accent, s.accent2) + '</div>';
    }
    if (s.subkicker) html += '<div class="subkicker">' + s.subkicker + '</div>';
    // sourced data-viz: a small citation pinned bottom-left (no chart-junk, just provenance).
    if (s.source) html += '<div class="srcline">Source: ' + s.source + '</div>';
    // PDF provenance badge: distinguishes the source's own claims from supplementary ones
    if (s.claim || s.page) {
      var bt = s.claim === 'supplement' ? 'Supplementary' : 'From the text';
      if (s.page && s.claim !== 'supplement') bt += ' · p. ' + s.page;
      html += '<div class="pgbadge ' + (s.claim === 'supplement' ? 'supp' : 'src') + '">' + bt + '</div>';
    }
    el.innerHTML = html;
    stage.appendChild(el);
  });

  // procedural animated background (BRAINROT default when no licensed footage is supplied):
  // original geometry only — scrolling stripes + seeded floating shapes, transform-driven.
  var fx = null, fxShapes = [];
  if (DECK.bg_fx === 'procedural') {
    fx = document.createElement('div'); fx.id = 'fx';
    fx.innerHTML = '<div class="fx-stripes"></div>';
    var glyphs = ['●', '▲', '■', '✚', '◆', '★', '~', '◯'];
    for (var fi = 0; fi < 16; fi++) {
      var g = document.createElement('div'); g.className = 'fx-shape ' + (fi % 3 === 0 ? 'a2' : (fi % 3 === 1 ? 'a1' : 'fg'));
      g.textContent = glyphs[fi % glyphs.length];
      var spec = { x: Math.random(), y: Math.random(), s: 0.5 + Math.random() * 1.3, vx: (Math.random() - 0.5) * 0.05,
                   vy: -0.02 - Math.random() * 0.05, rot: (Math.random() - 0.5) * 90, ph: Math.random() * 6.28 };
      g.style.fontSize = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.07 * spec.s) + 'px';
      fx.appendChild(g); fxShapes.push({ el: g, sp: spec });
    }
    document.body.insertBefore(fx, document.body.firstChild);
  }
  // licensed background footage is composited UNDER the deck by ffmpeg (render.py): the page
  // renders with a transparent background plus a dark scrim so content stays legible.
  if (DECK.bg_video) {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    var scrim = document.createElement('div'); scrim.id = 'scrim';
    document.body.insertBefore(scrim, document.body.firstChild);
  }
  var flash = null;
  if (DECK.flash) { flash = document.createElement('div'); flash.id = 'flash'; document.body.appendChild(flash); }
  if (DECK.caption_style) captionEl.classList.add('cap-' + DECK.caption_style);

  var slideEls = {};
  Array.prototype.forEach.call(stage.children, function (el) { slideEls[el.dataset.id] = el; });
  var DECK_MOTION = DECK.motion || 'rise';
  var styleById = {}, typeById = {};
  DECK.slides.forEach(function (s) {
    styleById[s.id] = s.transition || (s.type === 'punch' ? 'pop' : DECK_MOTION); typeById[s.id] = s.type;
  });
  // reserve the bottom caption zone so centered content never collides with captions
  // (critical for short aspects like 1:1 / 16:9 which have far less vertical room than 9:16)
  var _reserve = Math.round(window.innerHeight * ((DECK.safe_bottom || 0.14) + 0.12));
  Array.prototype.forEach.call(stage.children, function (el) { el.style.paddingBottom = _reserve + 'px'; });

  // Aspect-aware fit for the dense devices (waterfall columns, matrix labels): scale geometry
  // to the actual viewport + element count so any count reads on any aspect. Computed once —
  // the renderer fixes the viewport before load, so window dims are final here. We scale to fit,
  // never drop data: silently truncating a waterfall would break its running total (PRD §8.6).
  (function fitDenseDevices() {
    var vw = window.innerWidth, vh = window.innerHeight, avail = Math.max(200, vw - 180);  // 90px slide pad each side
    Array.prototype.forEach.call(stage.querySelectorAll('.waterfall'), function (wf) {
      var cols = wf.querySelectorAll('.wf-col'), n = cols.length; if (!n) return;
      var gap = Math.max(12, Math.min(26, avail * 0.03));
      var colW = Math.max(40, Math.min(150, (avail - (n - 1) * gap) / n));
      // size labels to the LONGEST word (labels wrap on spaces, so a single long word is the
      // binding constraint) so dense charts don't let neighbouring labels collide.
      var lw = 1;
      Array.prototype.forEach.call(cols, function (c) {
        var lb = c.querySelector('.wf-label');
        if (lb) (lb.textContent || '').split(/\s+/).forEach(function (w) { lw = Math.max(lw, w.length); });
      });
      // bias toward larger labels for mobile legibility (a touch of overlap is fine — motion graphics)
      var labFs = Math.max(20, Math.min(38, Math.min(colW * 0.40, colW / (lw * 0.52))));
      wf.style.gap = gap.toFixed(1) + 'px';
      Array.prototype.forEach.call(cols, function (c) {
        var bw = c.querySelector('.wf-barwrap'); if (bw) bw.style.width = colW.toFixed(1) + 'px';
        var lb = c.querySelector('.wf-label');
        if (lb) { lb.style.fontSize = labFs.toFixed(1) + 'px'; lb.style.maxWidth = (colW + 14).toFixed(1) + 'px'; }
      });
    });
    Array.prototype.forEach.call(stage.querySelectorAll('.matrix'), function (mx) {
      var plotW = mx.getBoundingClientRect().width || Math.min(vh * 0.58, avail * 0.78);
      var fs = Math.max(24, Math.min(40, plotW * 0.062));  // larger for mobile legibility
      Array.prototype.forEach.call(mx.querySelectorAll('.mx-ptlab'), function (lb) {
        lb.style.fontSize = fs.toFixed(1) + 'px'; lb.style.whiteSpace = 'normal';
        lb.style.maxWidth = (plotW * 0.42).toFixed(0) + 'px'; lb.style.textAlign = 'center';
      });
      Array.prototype.forEach.call(mx.querySelectorAll('.mx-xlo, .mx-xhi, .mx-ylo, .mx-yhi'), function (lb) {
        lb.style.fontSize = fs.toFixed(1) + 'px';
      });
    });
  })();

  window.renderAt = function (t) {
    var tl = window.TIMELINE; if (!tl) return;
    if (ambient) {  // continuous breathing glow + drift — GPU-composited (cheap, no repaint).
      // Opacity breathes; position drifts on two coprime-ish frequencies so the motion never
      // stalls simultaneously on both axes (a single sine stalls at its extremes → frozen frames).
      ambient.style.opacity = (0.08 + 0.10 * (0.5 + 0.5 * Math.sin(t * 0.8))).toFixed(4);
      ambient.style.transform = 'translate(' + (3.2 * Math.sin(t * 0.37)).toFixed(2) + '%,'
        + (2.6 * Math.cos(t * 0.29)).toFixed(2) + '%)';
    }
    if (fx) {  // procedural background: stripes scroll, shapes drift/rotate/bob (all f(t))
      var vw0 = window.innerWidth, vh0 = window.innerHeight;
      fx.firstChild.style.transform = 'translate(' + (-((t * 90) % 120)).toFixed(1) + 'px,0) rotate(-12deg)';
      fxShapes.forEach(function (f) {
        var sp = f.sp, x = ((sp.x + sp.vx * t) % 1 + 1) % 1, y = ((sp.y + sp.vy * t) % 1 + 1) % 1;
        f.el.style.transform = 'translate(' + (x * vw0).toFixed(1) + 'px,' + ((y * 1.2 - 0.1) * vh0 + Math.sin(t * 2.1 + sp.ph) * 14).toFixed(1) +
          'px) rotate(' + (sp.rot * t).toFixed(1) + 'deg)';
      });
    }
    var active = tl.slides[0];
    tl.slides.forEach(function (s) { if (t >= s.start) active = s; });
    if (flash) { var fdt = t - active.start; flash.style.opacity = (fdt >= 0 && fdt < 0.12 && active !== tl.slides[0]) ? (0.55 * (1 - fdt / 0.12)).toFixed(3) : 0; }
    var introS = DECK.intro_s || 0.6;

    tl.slides.forEach(function (win) {
      var el = slideEls[win.id]; if (!el) return;
      if (t < win.start || t >= win.end) { el.style.opacity = 0; el.style.transform = 'translateY(40px)'; return; }
      var span = win.end - win.start;
      var raw = clamp01((t - win.start) / Math.min(introS, span));
      var p = easeOut(raw);
      var style = styleById[win.id] || DECK_MOTION;
      el.style.opacity = (style === 'wipe' || style === 'zoom' || style === 'whip' || style === 'drop' || style === 'glitch') ? Math.min(1, raw * 3) : p;
      var tr = introTransform(style, p, raw, t);
      // slow push-in after the intro so a held shot never reads as a frozen frame (BRAINROT)
      if (DECK.kenburns) tr += ' scale(' + (1 + 0.035 * Math.min(span, Math.max(0, t - win.start))).toFixed(4) + ')';
      el.style.transform = tr;
      el.style.clipPath = (style === 'wipe' && raw < 1) ? 'inset(0 ' + ((1 - p) * 100).toFixed(2) + '% 0 0)' : '';
      var rt = el.dataset.type;
      if (rt === 'diagram') {
        var g = easeOut((t - win.start) / Math.min(1.0, span));
        var barMax = window.innerHeight * 0.28;  // scale bars to viewport height
        Array.prototype.forEach.call(el.querySelectorAll('.bar'), function (bar) {
          bar.style.height = (g * parseFloat(bar.dataset.val) * barMax) + 'px';
        });
      } else if (rt === 'stat') {
        countUp(el.querySelector('.statnum'), easeOut((t - win.start) / Math.min(1.0, span)));
      } else if (rt === 'progress') {
        var pg = easeOut((t - win.start) / Math.min(1.0, span));
        var fill = el.querySelector('.progressfill'), pe = el.querySelector('.progresspct');
        var pv = parseFloat(fill.dataset.val); pv = pv > 1 ? pv / 100 : pv;  // accept 0.73 or 73 or "73%"
        fill.style.width = (pg * pv * 100).toFixed(1) + '%';
        if (pe) pe.textContent = Math.round(pg * pv * 100) + '%';
      } else if (rt === 'statgrid') {
        Array.prototype.forEach.call(el.querySelectorAll('.statcell'), function (c, idx) {
          var cg = easeOut((t - win.start - idx * 0.14) / Math.min(0.8, span));  // staggered
          c.style.opacity = Math.max(0, cg);
          countUp(c.querySelector('.statnum'), cg);
        });
      } else if (rt === 'steps') {
        Array.prototype.forEach.call(el.querySelectorAll('.step'), function (st, idx) {
          var sg = easeOut((t - win.start - idx * 0.16) / Math.min(0.7, span));  // sequential reveal
          st.style.opacity = Math.max(0, sg);
          st.style.transform = 'translateX(' + ((1 - Math.max(0, sg)) * -28).toFixed(1) + 'px)';
        });
      } else if (rt === 'pictograph') {
        var pcg = easeOut((t - win.start) / Math.min(1.0, span));
        var onCells = el.querySelectorAll('.picto-cell.on');
        var lit = Math.round(pcg * onCells.length);
        Array.prototype.forEach.call(onCells, function (c, idx) { c.style.opacity = idx < lit ? 1 : 0.16; });
      } else if (rt === 'trend') {
        var tg = easeOut((t - win.start) / Math.min(1.3, span));
        if (el.__pts === undefined) {  // parse + measure once — reading clientHeight per frame forces a reflow
          var raw = JSON.parse(el.dataset.points || '[]').map(Number);
          if (raw.length) {
            var mn = Math.min.apply(null, raw), mx = Math.max.apply(null, raw), rng = (mx - mn) || 1;
            el.__pts = raw.map(function (v, i) {
              return { x: raw.length > 1 ? i / (raw.length - 1) * 100 : 50, y: 54 - ((v - mn) / rng) * 48 };
            });
          } else { el.__pts = []; }
          el.__th = el.querySelector('.trend').clientHeight || window.innerHeight * 0.34;
        }
        var pts = el.__pts;
        if (pts.length) {
          var prog = tg * (pts.length - 1), fi = Math.floor(prog), fr = prog - fi;
          var vis = pts.slice(0, fi + 1).map(function (p) { return p.x.toFixed(2) + ',' + p.y.toFixed(2); });
          var lx = pts[Math.min(fi, pts.length - 1)].x, ly = pts[Math.min(fi, pts.length - 1)].y;
          if (fi < pts.length - 1) {
            lx = pts[fi].x + (pts[fi + 1].x - pts[fi].x) * fr; ly = pts[fi].y + (pts[fi + 1].y - pts[fi].y) * fr;
            vis.push(lx.toFixed(2) + ',' + ly.toFixed(2));
          }
          var ln = el.querySelector('.trend-line'), dot = el.querySelector('.trend-dot'), te = el.querySelector('.trend-end');
          if (ln) ln.setAttribute('points', vis.join(' '));
          if (dot) {  // HTML overlay dot (the SVG viewBox is stretched, so an SVG circle would skew)
            dot.style.left = lx.toFixed(2) + '%'; dot.style.top = (ly / 60 * el.__th).toFixed(1) + 'px';
          }
          if (te) te.style.opacity = Math.max(0, Math.min(1, (tg - 0.85) / 0.15));
        }
      } else if (rt === 'ring') {
        var rg = easeOut((t - win.start) / Math.min(1.3, span));
        var rfill = el.querySelector('.ring-fill'), rpe = el.querySelector('.ring-pct');
        var rv = parseFloat(rfill.dataset.val); rv = rv > 1 ? rv / 100 : rv;
        var RC = 2 * Math.PI * 42;
        rfill.style.strokeDasharray = RC.toFixed(2);
        rfill.style.strokeDashoffset = (RC * (1 - rg * rv)).toFixed(2);
        if (rpe) rpe.textContent = Math.round(rg * rv * 100) + '%';
      } else if (rt === 'ranked') {
        Array.prototype.forEach.call(el.querySelectorAll('.rankrow'), function (row, idx) {
          var rkg = easeOut((t - win.start - idx * 0.12) / Math.min(0.9, span));
          row.style.opacity = Math.max(0, Math.min(1, rkg * 3));
          var rb = row.querySelector('.rankbar');
          rb.style.width = (Math.max(0, rkg) * parseFloat(rb.dataset.val) * 100) + '%';
        });
      } else if (rt === 'delta') {
        var dg = easeOut((t - win.start) / Math.min(1.0, span));
        var dvals = el.querySelectorAll('.delta-val');
        if (dvals[0]) countUp(dvals[0], dg);
        if (dvals[1]) countUp(dvals[1], easeOut((t - win.start - 0.12) / Math.min(1.0, span)));
        var badge = el.querySelector('.delta-badge');
        if (badge) badge.style.opacity = Math.max(0, Math.min(1, (dg - 0.6) / 0.4));
      } else if (rt === 'timeline') {
        var tlg = easeOut((t - win.start) / Math.min(1.2, span));
        var tline = el.querySelector('.tl-line'); if (tline) tline.style.width = (tlg * 100) + '%';
        Array.prototype.forEach.call(el.querySelectorAll('.tl-event'), function (ev, idx) {
          var eg = Math.max(0, easeOut((t - win.start - 0.12 - idx * 0.18) / Math.min(0.6, span)));
          ev.style.opacity = eg;
          var d = ev.querySelector('.tl-dot'); if (d) d.style.transform = 'scale(' + (0.3 + 0.7 * eg) + ')';
        });
      } else if (rt === 'waterfall') {
        var barMaxW = window.innerHeight * 0.26, wmax = parseFloat(el.dataset.wfmax) || 1, wscale = barMaxW / wmax;
        Array.prototype.forEach.call(el.querySelectorAll('.wf-bar'), function (bar, idx) {
          var wg = Math.max(0, easeOut((t - win.start - idx * 0.13) / Math.min(0.7, span)));
          bar.style.bottom = (parseFloat(bar.dataset.floor) * wscale) + 'px';
          bar.style.height = (wg * parseFloat(bar.dataset.val) * wscale) + 'px';
        });
      } else if (rt === 'matrix') {
        Array.prototype.forEach.call(el.querySelectorAll('.mx-pt'), function (pt, idx) {
          var mg = Math.max(0, easeOut((t - win.start - 0.15 - idx * 0.14) / Math.min(0.6, span)));
          pt.style.opacity = mg;
          pt.style.transform = 'translate(-50%, 50%) scale(' + (0.2 + 0.8 * mg) + ')';
        });
      } else if (rt === 'reframe') {
        var fg = easeOut((t - win.start) / Math.min(1.4, span));
        var rl = el.querySelector('.rf-line'); if (rl) rl.style.width = (Math.min(1, fg / 0.45) * 100) + '%';
        var af = el.querySelector('.rf-after'), ra = el.querySelector('.rf-arrow');
        var ao = Math.max(0, Math.min(1, (fg - 0.45) / 0.45));
        if (af) { af.style.opacity = ao; af.style.transform = 'translateY(' + ((1 - ao) * 14).toFixed(1) + 'px)'; }
        if (ra) ra.style.opacity = ao;
      } else if (rt === 'highlight') {
        var hg = Math.max(0, easeOut((t - win.start - 0.3) / Math.min(0.8, span)));
        Array.prototype.forEach.call(el.querySelectorAll('.hl-bg'), function (bg) { bg.style.width = (hg * 100) + '%'; });
      } else if (rt === 'build') {
        // Motion serves comprehension (§8.6): when the build line's words map 1:1 to the
        // forced-alignment word timings for this slide, each word appears exactly as it's
        // spoken. Otherwise fall back to a fixed stagger from the slide start.
        var bspans = el.querySelectorAll('.bw');
        var bwords = el.__bwords;
        if (bwords === undefined) {
          var ws = tl.words.filter(function (w) { return w.slide === win.id; });
          el.__bwords = bwords = (ws.length === bspans.length) ? ws : null;
        }
        Array.prototype.forEach.call(bspans, function (w, idx) {
          var startT = bwords ? bwords[idx].start : (win.start + idx * 0.07);
          var bg = Math.max(0, easeOut((t - startT) / 0.32));
          w.style.opacity = bg;
          w.style.transform = 'translateY(' + ((1 - bg) * 18).toFixed(1) + 'px) scale(' + (0.85 + 0.15 * bg) + ')';
        });
      } else if (rt === 'list') {
        Array.prototype.forEach.call(el.querySelectorAll('.li-row'), function (row, idx) {
          var lg = Math.max(0, easeOut((t - win.start - idx * 0.14) / Math.min(0.6, span)));
          row.style.opacity = lg;
          row.style.transform = 'translateX(' + ((1 - lg) * -24).toFixed(1) + 'px)';
        });
      } else if (rt === 'define') {
        var deg = Math.max(0, easeOut((t - win.start - 0.3) / Math.min(0.6, span)));
        var body = el.querySelector('.def-body');
        if (body) { body.style.opacity = deg; body.style.transform = 'translateY(' + ((1 - deg) * 16).toFixed(1) + 'px)'; }
      } else if (rt === 'equation') {
        var eqg = easeOut((t - win.start - 0.1) / Math.min(0.8, span));
        var eqm = el.querySelector('.eqmain');
        if (eqm) { eqm.style.opacity = eqg; eqm.style.transform = 'scale(' + (0.94 + 0.06 * eqg).toFixed(4) + ')'; }
        var prevT = undefined;
        Array.prototype.forEach.call(el.querySelectorAll('.eqrow'), function (row, idx) {
          var t0 = cueTime(win.id, row.dataset.cue, win.start + 0.9 + idx * 0.7, prevT);
          prevT = t0 + 0.01;
          var rg = Math.max(0, easeOut((t - t0) / 0.45));
          row.style.opacity = rg;
          row.style.transform = 'translateY(' + ((1 - rg) * 18).toFixed(1) + 'px)';
          row.classList.toggle('now', t >= t0 && t < t0 + 1.6);
        });
      } else if (rt === 'derivation') {
        var drows = el.querySelectorAll('.drow'), lastOn = -1, dts = [];
        Array.prototype.forEach.call(drows, function (row, idx) {
          dts[idx] = cueTime(win.id, row.dataset.cue, win.start + 0.3 + idx * Math.max(1.2, (span - 0.6) / drows.length),
                             idx ? dts[idx - 1] + 0.01 : undefined);
          if (t >= dts[idx]) lastOn = idx;
        });
        Array.prototype.forEach.call(drows, function (row, idx) {
          var dg = Math.max(0, easeOut((t - dts[idx]) / 0.5));
          row.style.opacity = (idx < lastOn ? 0.45 : 1) * dg;   // earlier steps recede, current step leads
          row.style.transform = 'translateX(' + ((1 - dg) * -26).toFixed(1) + 'px)';
          row.classList.toggle('now', idx === lastOn);
        });
      } else if (rt === 'scene2d') {
        renderScene(el, win, t);
      } else if (rt === 'meme') {
        var ms = easeOut((t - win.start) / Math.min(0.3, span));
        var me = el.querySelector('.meme-emoji'), mp = el.querySelector('.meme-punch'), mset0 = el.querySelector('.meme-setup');
        if (mset0) mset0.style.opacity = ms;
        var pt0 = win.start + Math.min(span * 0.4, 0.9);
        if (me) me.style.transform = 'scale(' + (0.3 + 0.7 * backOut((t - win.start - 0.1) / 0.35)).toFixed(4) + ') rotate(' +
          (Math.sin((t - win.start) * 9) * 8).toFixed(2) + 'deg)';
        if (mp) { var mpg = clamp01((t - pt0) / 0.22); mp.style.opacity = mpg; mp.style.transform = 'scale(' + (0.5 + 0.5 * backOut(mpg)).toFixed(4) + ')'; }
      }
    });

    // no kinetic captions on the CTA end card — the CTA text is already on screen
    if (typeById[active.id] === 'cta') {
      if (captionEl.dataset.sig !== 'cta') { captionEl.innerHTML = ''; captionEl.dataset.sig = 'cta'; }
      return;
    }
    // kinetic captions for the active slide.
    // caption_mode "window" (default): TikTok-style — group words into small chunks (caption_window
    //   words, breaking at sentence punctuation) and show ONLY the chunk containing the spoken word.
    // caption_mode "full": legacy — show the whole slide's narration, highlight the spoken word.
    var words = tl.words.filter(function (w) { return w.slide === active.id; });
    var capMode = DECK.caption_mode || 'window';
    var winN = DECK.caption_window || 4;
    var sig = active.id + ':' + words.length + ':' + capMode + ':' + winN;
    if (captionEl.dataset.sig !== sig) {
      captionEl.dataset.sig = sig; captionEl.innerHTML = '';
      // size caption to viewport; place above the bottom safe area
      var vw = window.innerWidth, vh = window.innerHeight;  // actual viewport (multi-aspect)
      var safeBottom = DECK.safe_bottom || 0.14;            // platform safe-zone inset
      captionEl.style.bottom = Math.round(vh * safeBottom) + 'px';
      var fs = Math.round(Math.min(vw, vh) * ({ brainrot: 0.105, lecture: 0.036 }[DECK.caption_style] || 0.052));  // short-side => consistent across aspects
      var chunk = 0, cnt = 0;
      words.forEach(function (w) {
        var sp = document.createElement('span'); sp.className = 'w'; sp.textContent = w.word;
        sp.style.fontSize = fs + 'px';
        // symbols are case-sensitive (f = frequency, F = force; m = metres, M = mega): never case-transform
        // single-letter tokens or anything with a digit in the styled caption modes
        if ((/^[^A-Za-z0-9]*[A-Za-z\u0370-\u03ff][^A-Za-z0-9]*$/.test(w.word) && !/^\W*(a|A|I)\W*$/.test(w.word)) || /\d/.test(w.word)) sp.setAttribute('data-sym', '1');
        sp.setAttribute('data-chunk', chunk);                // chunk membership for window mode
        captionEl.appendChild(sp);
        cnt++;
        if (cnt >= winN || /[.!?]$/.test(w.word)) { chunk++; cnt = 0; }  // break on size or sentence end
      });
    }
    var spans = captionEl.children;
    // active word index: exact time hit, else the most recent word that has started, else first.
    var act = -1;
    for (var i = 0; i < words.length; i++) { if (t >= words[i].start && t < words[i].end) { act = i; break; } }
    if (act < 0) { for (var j = 0; j < words.length; j++) { if (t >= words[j].start) act = j; } }
    if (act < 0) act = 0;
    var activeChunk = spans[act] ? +spans[act].getAttribute('data-chunk') : 0;
    for (var k = 0; k < spans.length; k++) {
      var w = words[k];
      var on = w && t >= w.start && t < w.end;
      // window mode: hide every word outside the active chunk so only ~winN words show at once.
      if (capMode === 'window') {
        spans[k].style.display = (+spans[k].getAttribute('data-chunk') === activeChunk) ? '' : 'none';
      }
      spans[k].className = on ? 'w active' : 'w';
      if (DECK.caption_style === 'brainrot' && w) {
        // kinetic pop: each word springs in (overshoot) the moment it is spoken, with a small
        // alternating tilt per chunk; words not yet spoken in the chunk wait at low opacity.
        var wdt = t - w.start, chunkN = +spans[k].getAttribute('data-chunk');
        var sc = wdt < 0 ? 0.85 : (wdt < 0.16 ? 0.55 + 0.45 * backOut(wdt / 0.16) * 1.0 : 1.0);
        spans[k].style.opacity = wdt < 0 ? 0.35 : 1;
        spans[k].style.transform = 'scale(' + (sc * (on ? 1.08 : 1)).toFixed(4) + ') rotate(' + (chunkN % 2 ? 2.5 : -2.5) + 'deg)';
        continue;
      }
      // gentle emphasis: color (in CSS) + a small scale. Keep the scale modest so the
      // enlarged active word doesn't visually crowd its neighbours (scale doesn't reflow).
      spans[k].style.transform = on ? 'scale(1.06)' : 'scale(1.0)';
    }
  };

  // Signal ready only once any declared @font-face glyphs are actually loaded, so the
  // first captured frame uses real fonts (not a fallback). Themes with no `fonts` field
  // declare zero faces, so this resolves immediately — no delay for them.
  function signalReady() { window.__deckReady = true; }
  function afterMath() {
    if (document.fonts && document.fonts.size) {
      var loads = [];
      document.fonts.forEach(function (ff) { loads.push(ff.load().catch(function () {})); });
      Promise.all(loads).then(function () { return document.fonts.ready; }).then(signalReady, signalReady);
    } else {
      signalReady();
    }
  }

  // Typeset every LaTeX placeholder once, then measure: a math node that errored, has zero
  // size, or would overflow the viewport is reported (window.__mathReport -> work/math_report.json)
  // so QA can fail on missing/distorted equations. Wide display equations are scaled down
  // UNIFORMLY (font-size) to fit — never stretched — and the scale is recorded.
  function typesetAll() {
    var report = [], vw = window.innerWidth, vh = window.innerHeight;
    // tex2svg() bypasses the document pipeline, so add MathJax's SVG stylesheet ourselves (before measuring)
    document.head.appendChild(MathJax.svgStylesheet());
    Array.prototype.forEach.call(document.querySelectorAll('.tex'), function (ph) {
      var spec = TEX[+ph.dataset.ti], slide = ph.closest('.slide'), rec = { slide: slide ? slide.dataset.id : null, tex: spec.tex };
      try {
        var node = MathJax.tex2svg(spec.tex, { display: spec.display });
        ph.appendChild(node);
        var err = node.querySelector('[data-mjx-error]');
        rec.ok = !err; if (err) rec.error = err.getAttribute('data-mjx-error');
      } catch (e) { rec.ok = false; rec.error = String(e); }
      var box = ph.getBoundingClientRect(), host = ph.closest('.eqmain, .dmath');
      if (host && box.width > 0) {
        var maxW = host.getBoundingClientRect().width || vw * 0.85, scale = 1;
        if (box.width > maxW) {
          scale = maxW / box.width;
          var fs0 = parseFloat(getComputedStyle(host).fontSize);
          host.style.fontSize = (fs0 * scale).toFixed(1) + 'px';
          box = ph.getBoundingClientRect();
        }
        rec.scale = +scale.toFixed(3);
      }
      rec.w = Math.round(box.width); rec.h = Math.round(box.height);
      if (rec.ok && (rec.w === 0 || rec.h === 0)) { rec.ok = false; rec.error = 'zero-size render'; }
      if (rec.ok && !ph.closest('foreignObject') && (box.right > vw + 1 || box.left < -1 || box.bottom > vh + 1)) {
        rec.ok = false; rec.error = 'outside viewport';
      }
      report.push(rec);
    });
    window.__mathReport = report;
  }

  if (TEX.length && window.MathJax && MathJax.startup && MathJax.startup.promise) {
    MathJax.startup.promise.then(typesetAll).then(afterMath, function (e) {
      window.__mathReport = [{ ok: false, error: 'MathJax startup failed: ' + e }]; afterMath();
    });
  } else {
    if (TEX.length) window.__mathReport = TEX.map(function (x) { return { tex: x.tex, ok: false, error: 'MathJax not loaded' }; });
    else window.__mathReport = [];
    afterMath();
  }
})();
