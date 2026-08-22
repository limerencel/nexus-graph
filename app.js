(() => {
  const G = window.GRAPH;
  const canvas = document.getElementById('graph');
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  const typeMap = Object.fromEntries(G.types.map((t) => [t.id, t]));
  const RADIUS = { org: 22, team: 16, model: 15, project: 14, system: 13, dataset: 12, person: 10 };

  const nodes = G.nodes.map((n, i) => {
    const ring = G.types.findIndex((t) => t.id === n.type);
    const a = (ring / G.types.length) * Math.PI * 2 + i * 0.41;
    const rad = 90 + ring * 78;
    return {
      ...n,
      r: RADIUS[n.type] || 11,
      x: Math.cos(a) * rad,
      y: Math.sin(a) * rad,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
      degree: 0,
    };
  });
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const links = G.links
    .map(([a, b, label]) => {
      const s = byId[a];
      const t = byId[b];
      if (!s || !t) return null;
      s.degree++;
      t.degree++;
      return { s, t, label, dist: 56 + (s.r + t.r) * 0.9, strength: 0.55 };
    })
    .filter(Boolean);
  for (const l of links) {
    const w = l.s.degree + l.t.degree;
    l.bias = l.t.degree / (w || 1);
  }

  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const l of links) {
    adj.get(l.s.id).push({ node: l.t, label: l.label, dir: 'out' });
    adj.get(l.t.id).push({ node: l.s, label: l.label, dir: 'in' });
  }

  let w = 0, h = 0, dpr = 1;
  const cam = { x: 0, y: 0, k: 1 };
  let alpha = 1;
  let alphaTarget = 0;
  let frozen = false;
  let selected = null;
  let hovered = null;
  let query = '';
  let matches = new Set();
  let enabled = new Set(G.types.map((t) => t.id));
  let needsDraw = true;
  let dragging = null;
  let panning = false;
  let pan0 = { x: 0, y: 0, cx: 0, cy: 0 };
  let pointers = new Map();
  let pinch = null;

  const CHARGE = -240;
  const CENTER = 0.045;
  const COLLIDE = 0.7;
  const VDECAY = 0.42;
  const ADECAY = 0.028;

  const $ = (id) => document.getElementById(id);
  const searchEl = $('search');
  const resultsEl = $('search-results');
  const freezeBtn = $('btn-freeze');
  const tooltip = $('tooltip');

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    needsDraw = true;
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - cam.x) / cam.k, y: (sy - cam.y) / cam.k };
  }

  function visible(n) {
    return enabled.has(n.type);
  }

  function isMatch(n) {
    return query ? matches.has(n.id) : false;
  }

  function dimmed(n) {
    if (!visible(n)) return true;
    if (query && !matches.has(n.id) && selected !== n) return true;
    return false;
  }

  function hitTest(sx, sy) {
    const p = screenToWorld(sx, sy);
    let best = null;
    let bestD = Infinity;
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      if (!visible(n)) continue;
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      if (d < n.r + 4 / cam.k && d < bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  function tick() {
    if (frozen) return false;
    alpha += (alphaTarget - alpha) * ADECAY;
    if (alpha < 0.001) {
      alpha = 0;
      return false;
    }

    for (const l of links) {
      if (!visible(l.s) || !visible(l.t)) continue;
      let dx = l.t.x - l.s.x;
      let dy = l.t.y - l.s.y;
      const d = Math.hypot(dx, dy) || 1e-6;
      const k = ((d - l.dist) / d) * l.strength * alpha;
      const bx = dx * k;
      const by = dy * k;
      l.s.vx += bx * (1 - l.bias);
      l.s.vy += by * (1 - l.bias);
      l.t.vx -= bx * l.bias;
      l.t.vy -= by * l.bias;
    }

    const n = nodes.length;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      if (!visible(a)) continue;
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        if (!visible(b)) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          dx = (Math.random() - 0.5) * 0.1;
          dy = (Math.random() - 0.5) * 0.1;
          d2 = dx * dx + dy * dy;
        }
        const inv = 1 / d2;
        const f = CHARGE * alpha * inv;
        a.vx -= dx * f;
        a.vy -= dy * f;
        b.vx += dx * f;
        b.vy += dy * f;
        const min = a.r + b.r + 6;
        const dist = Math.sqrt(d2);
        if (dist < min) {
          const push = ((min - dist) / dist) * COLLIDE * 0.5;
          a.x -= dx * push;
          a.y -= dy * push;
          b.x += dx * push;
          b.y += dy * push;
        }
      }
    }

    let cx = 0, cy = 0, c = 0;
    for (const nd of nodes) {
      if (!visible(nd)) continue;
      cx += nd.x;
      cy += nd.y;
      c++;
    }
    if (c) {
      cx /= c;
      cy /= c;
      const gx = -cx * CENTER;
      const gy = -cy * CENTER;
      for (const nd of nodes) {
        if (!visible(nd)) continue;
        nd.vx += gx;
        nd.vy += gy;
      }
    }

    const decay = 1 - VDECAY;
    for (const nd of nodes) {
      if (nd.fx != null) { nd.x = nd.fx; nd.vx = 0; }
      else { nd.vx *= decay; nd.x += nd.vx; }
      if (nd.fy != null) { nd.y = nd.fy; nd.vy = 0; }
      else { nd.vy *= decay; nd.y += nd.vy; }
    }
    return true;
  }

  function zoomAt(sx, sy, factor) {
    const world = screenToWorld(sx, sy);
    cam.k = Math.min(4, Math.max(0.18, cam.k * factor));
    cam.x = sx - world.x * cam.k;
    cam.y = sy - world.y * cam.k;
    needsDraw = true;
  }

  function fit(pad) {
    const vis = nodes.filter(visible);
    if (!vis.length) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of vis) {
      minX = Math.min(minX, n.x - n.r);
      minY = Math.min(minY, n.y - n.r);
      maxX = Math.max(maxX, n.x + n.r);
      maxY = Math.max(maxY, n.y + n.r);
    }
    const bw = maxX - minX || 1;
    const bh = maxY - minY || 1;
    cam.k = Math.max(0.2, Math.min((w - pad * 2) / bw, (h - pad * 2) / bh, 1.8));
    cam.x = w / 2 - ((minX + maxX) / 2) * cam.k;
    cam.y = h / 2 - ((minY + maxY) / 2) * cam.k;
    needsDraw = true;
  }

  function flyTo(n) {
    const k = Math.max(cam.k, 1.15);
    cam.k = k;
    cam.x = w / 2 - n.x * k;
    cam.y = h / 2 - n.y * k;
    needsDraw = true;
  }

  function reheat(level) {
    frozen = false;
    alpha = Math.max(alpha, level == null ? 1 : level);
    alphaTarget = 0;
    freezeBtn.textContent = 'Freeze';
    freezeBtn.classList.remove('active');
  }

  function setFrozen(on) {
    frozen = on;
    if (on) {
      alpha = 0;
      alphaTarget = 0;
      freezeBtn.textContent = 'Resume';
      freezeBtn.classList.add('active');
    } else {
      freezeBtn.textContent = 'Freeze';
      freezeBtn.classList.remove('active');
      if (alpha < 0.02) alpha = 0.12;
    }
    needsDraw = true;
  }

  function unpinAll() {
    for (const n of nodes) { n.fx = null; n.fy = null; }
    reheat(0.6);
    needsDraw = true;
  }

  function select(n) {
    selected = n;
    const panel = $('inspector');
    if (!n) { panel.hidden = true; needsDraw = true; return; }
    panel.hidden = false;
    const t = typeMap[n.type];
    $('insp-type').textContent = t ? t.label : n.type;
    $('insp-type').style.color = t ? t.color : '#5ce1e6';
    $('insp-name').textContent = n.name;
    $('insp-role').textContent = n.role || '';
    $('insp-desc').textContent = n.desc || '';
    $('insp-meta').innerHTML = '';
    for (const tag of [n.type, ...(n.tags || []), n.degree + ' links']) {
      const el = document.createElement('span');
      el.className = 'tag';
      el.textContent = tag;
      $('insp-meta').appendChild(el);
    }
    const list = $('insp-neighbors');
    list.innerHTML = '';
    const neigh = adj.get(n.id) || [];
    if (!neigh.length) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="search-empty">No neighbors</span>';
      list.appendChild(li);
    } else {
      for (const { node, label } of neigh) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.innerHTML = '<span>' + node.name + '</span><small>' + label + '</small>';
        btn.addEventListener('click', () => { select(node); flyTo(node); });
        li.appendChild(btn);
        list.appendChild(li);
      }
    }
    needsDraw = true;
  }

  function applySearch(q) {
    query = q.trim().toLowerCase();
    matches = new Set();
    resultsEl.innerHTML = '';
    if (!query) { resultsEl.hidden = true; needsDraw = true; return; }
    const found = [];
    for (const n of nodes) {
      if (!visible(n)) continue;
      const hay = (n.name + ' ' + n.type + ' ' + (n.role || '') + ' ' + (n.desc || '') + ' ' + (n.tags || []).join(' ')).toLowerCase();
      if (hay.includes(query)) { matches.add(n.id); found.push(n); }
    }
    if (!found.length) {
      resultsEl.hidden = false;
      resultsEl.innerHTML = '<div class="search-empty">No matches</div>';
    } else {
      resultsEl.hidden = false;
      found.slice(0, 12).forEach((n, i) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'search-item' + (i === 0 ? ' active' : '');
        btn.innerHTML = '<span>' + n.name + '</span><small>' + n.type + '</small>';
        btn.addEventListener('click', () => { select(n); flyTo(n); resultsEl.hidden = true; });
        resultsEl.appendChild(btn);
      });
    }
    needsDraw = true;
  }

  function drawGrid() {
    const step = 64;
    const p0 = screenToWorld(0, 0);
    const p1 = screenToWorld(w, h);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(232,236,244,0.035)';
    ctx.lineWidth = 1 / cam.k;
    const x0 = Math.floor(p0.x / step) * step;
    const y0 = Math.floor(p0.y / step) * step;
    for (let x = x0; x < p1.x; x += step) { ctx.moveTo(x, p0.y); ctx.lineTo(x, p1.y); }
    for (let y = y0; y < p1.y; y += step) { ctx.moveTo(p0.x, y); ctx.lineTo(p1.x, y); }
    ctx.stroke();
  }

  function draw() {
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, w, h);
    const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 40, w * 0.5, h * 0.5, Math.max(w, h) * 0.7);
    g.addColorStop(0, 'rgba(36, 52, 78, 0.35)');
    g.addColorStop(1, 'rgba(7, 8, 12, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.k, cam.k);
    drawGrid();
    const showEdgeLabels = cam.k > 0.95;
    const showNodeLabels = cam.k > 0.72;

    for (const l of links) {
      if (!visible(l.s) || !visible(l.t)) continue;
      const fade = dimmed(l.s) || dimmed(l.t);
      const hot = selected && (l.s === selected || l.t === selected);
      ctx.beginPath();
      ctx.moveTo(l.s.x, l.s.y);
      ctx.lineTo(l.t.x, l.t.y);
      ctx.strokeStyle = hot ? 'rgba(92,225,230,0.7)' : fade ? 'rgba(232,236,244,0.05)' : 'rgba(232,236,244,0.18)';
      ctx.lineWidth = (hot ? 1.8 : 1) / cam.k;
      ctx.stroke();
      if (showEdgeLabels && !fade && l.label) {
        const mx = (l.s.x + l.t.x) / 2;
        const my = (l.s.y + l.t.y) / 2;
        const ang = Math.atan2(l.t.y - l.s.y, l.t.x - l.s.x);
        const flip = ang > Math.PI / 2 || ang < -Math.PI / 2;
        ctx.save();
        ctx.translate(mx, my);
        ctx.rotate(flip ? ang + Math.PI : ang);
        ctx.font = 9 / cam.k + 'px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = hot ? 'rgba(92,225,230,0.9)' : 'rgba(139,147,167,0.75)';
        ctx.fillText(l.label, 0, -6 / cam.k);
        ctx.restore();
      }
    }

    for (const n of nodes) {
      if (!visible(n)) continue;
      const t = typeMap[n.type];
      const fade = dimmed(n);
      const on = n === selected || n === hovered || isMatch(n);
      const color = t ? t.color : '#e8ecf4';
      if (on && !fade) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 8, 0, Math.PI * 2);
        ctx.fillStyle = color + '22';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = fade ? 'rgba(20,24,32,0.55)' : '#10141c';
      ctx.fill();
      ctx.lineWidth = (on ? 2.4 : 1.5) / Math.max(cam.k, 0.6);
      ctx.strokeStyle = fade ? 'rgba(232,236,244,0.12)' : color;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(n.x, n.y, Math.max(2.2, n.r * 0.28), 0, Math.PI * 2);
      ctx.fillStyle = fade ? 'rgba(232,236,244,0.2)' : color;
      ctx.fill();
      if (n.fx != null) {
        ctx.beginPath();
        ctx.arc(n.x + n.r * 0.62, n.y - n.r * 0.62, 2.2 / Math.max(cam.k, 0.7), 0, Math.PI * 2);
        ctx.fillStyle = '#ffc857';
        ctx.fill();
      }
      if ((showNodeLabels || on) && !fade) {
        ctx.font = (on ? 600 : 500) + ' ' + 11 / Math.max(cam.k * 0.92, 0.55) + 'px Outfit, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = on ? '#e8ecf4' : 'rgba(232,236,244,0.78)';
        ctx.fillText(n.name, n.x, n.y + n.r + 4 / cam.k);
      }
    }
    ctx.restore();
    $('stat-alpha').textContent = 'α ' + alpha.toFixed(2);
    $('stat-state').textContent = frozen ? 'frozen' : alpha > 0.001 ? 'running' : 'settled';
  }

  function loop() {
    if (tick()) needsDraw = true;
    if (needsDraw) { draw(); needsDraw = false; }
    requestAnimationFrame(loop);
  }

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    pan0 = { x: e.clientX, y: e.clientY, cx: cam.x, cy: cam.y };
    if (pointers.size === 2) {
      const pts = [...pointers.values()];
      pinch = {
        d: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1,
        k: cam.k,
        x: cam.x,
        y: cam.y,
        mx: (pts[0].x + pts[1].x) / 2,
        my: (pts[0].y + pts[1].y) / 2,
      };
      dragging = null;
      panning = false;
      return;
    }
    const n = hitTest(e.clientX, e.clientY);
    if (n) {
      dragging = n;
      const p = screenToWorld(e.clientX, e.clientY);
      n.fx = p.x;
      n.fy = p.y;
      select(n);
      reheat(0.25);
      alphaTarget = 0.18;
      canvas.classList.add('dragging');
    } else {
      panning = true;
      canvas.classList.add('dragging');
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const pts = [...pointers.values()];
      const d = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) || 1;
      const mx = (pts[0].x + pts[1].x) / 2;
      const my = (pts[0].y + pts[1].y) / 2;
      const newK = Math.min(4, Math.max(0.18, pinch.k * (d / pinch.d)));
      const wx = (pinch.mx - pinch.x) / pinch.k;
      const wy = (pinch.my - pinch.y) / pinch.k;
      cam.k = newK;
      cam.x = mx - wx * newK;
      cam.y = my - wy * newK;
      needsDraw = true;
      return;
    }
    if (dragging) {
      const p = screenToWorld(e.clientX, e.clientY);
      dragging.fx = p.x;
      dragging.fy = p.y;
      needsDraw = true;
      return;
    }
    if (panning) {
      cam.x = pan0.cx + (e.clientX - pan0.x);
      cam.y = pan0.cy + (e.clientY - pan0.y);
      needsDraw = true;
      return;
    }
    const n = hitTest(e.clientX, e.clientY);
    if (n !== hovered) {
      hovered = n;
      canvas.classList.toggle('hover-node', !!n);
      needsDraw = true;
    }
    if (n) {
      tooltip.hidden = false;
      tooltip.style.left = e.clientX + 'px';
      tooltip.style.top = e.clientY + 'px';
      tooltip.textContent = n.name + ' · ' + n.type;
    } else tooltip.hidden = true;
  });

  function endPointer(e) {
    pointers.delete(e.pointerId);
    pinch = null;
    if (dragging) { alphaTarget = 0; dragging = null; }
    panning = false;
    canvas.classList.remove('dragging');
  }
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  canvas.addEventListener('click', (e) => {
    if (Math.hypot(e.clientX - pan0.x, e.clientY - pan0.y) > 6) return;
    const n = hitTest(e.clientX, e.clientY);
    select(n);
    resultsEl.hidden = true;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const n = hitTest(e.clientX, e.clientY);
    if (n) { n.fx = null; n.fy = null; reheat(0.35); }
    else fit(80);
  });

  searchEl.addEventListener('input', () => applySearch(searchEl.value));
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = nodes.find((n) => matches.has(n.id));
      if (first) { select(first); flyTo(first); resultsEl.hidden = true; }
    }
    if (e.key === 'Escape') { searchEl.value = ''; applySearch(''); searchEl.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) resultsEl.hidden = true;
  });

  $('btn-reheat').addEventListener('click', () => {
    for (const n of nodes) { n.vx += (Math.random() - 0.5) * 8; n.vy += (Math.random() - 0.5) * 8; }
    reheat(1);
  });
  freezeBtn.addEventListener('click', () => setFrozen(!frozen));
  $('btn-fit').addEventListener('click', () => fit(72));
  $('btn-unpin').addEventListener('click', unpinAll);
  $('insp-close').addEventListener('click', () => select(null));

  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (e.key === '/' && tag !== 'INPUT') { e.preventDefault(); searchEl.focus(); searchEl.select(); }
    if (tag === 'INPUT') return;
    if (e.key === ' ') { e.preventDefault(); setFrozen(!frozen); }
    if (e.key === 'r' || e.key === 'R') {
      for (const n of nodes) { n.vx += (Math.random() - 0.5) * 8; n.vy += (Math.random() - 0.5) * 8; }
      reheat(1);
    }
    if (e.key === 'f' || e.key === 'F') fit(72);
    if (e.key === 'Escape') select(null);
  });

  const legend = $('legend');
  for (const t of G.types) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.innerHTML = '<i></i>' + t.label;
    btn.style.color = t.color;
    btn.addEventListener('click', () => {
      if (enabled.has(t.id)) enabled.delete(t.id);
      else enabled.add(t.id);
      btn.classList.toggle('off', !enabled.has(t.id));
      if (selected && !visible(selected)) select(null);
      applySearch(searchEl.value);
      reheat(0.25);
      needsDraw = true;
    });
    legend.appendChild(btn);
  }

  $('stat-nodes').textContent = nodes.length + ' nodes';
  $('stat-links').textContent = links.length + ' edges';
  window.addEventListener('resize', resize);
  resize();
  cam.x = w / 2;
  cam.y = h / 2;
  cam.k = 0.72;
  requestAnimationFrame(() => {
    for (let i = 0; i < 80; i++) tick();
    fit(88);
    alpha = 0.35;
    loop();
  });
})();
