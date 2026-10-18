// ==================== COMPLETE REBUILT CAD & 3D ENGINE (cad-3d-engine.js) ====================
(function () {
  const gfCanvas = document.getElementById('gf-2d-canvas');
  const gfCtx = gfCanvas.getContext('2d');
  const gfStatus = document.getElementById('gf-status');
  const m1Status = document.getElementById('m1-status');

  let showNegativeGhost = false;
  let dragState = null; // { type: 'tool'|'scoop'|'snap', toolIdx, itemIdx, startX, startY, origX, origY }
  let mode2Meshes = {
    bin: { vertices: [], faces: [] },
    saddle: { vertices: [], faces: [] },
    neg: { vertices: [], faces: [] },
    snaps: { vertices: [], faces: [] }
  };

  // ==================== 1. 2D GEOMETRY & RASTER UNION CONTOUR ENGINE ====================
  function transformPt(pt, tx, ty, rotDeg) {
    const r = (rotDeg * Math.PI) / 180;
    const c = Math.cos(r), s = Math.sin(r);
    return { x: tx + pt.x * c - pt.y * s, y: ty + pt.x * s + pt.y * c };
  }

  function invTransformPt(worldPt, tx, ty, rotDeg) {
    const r = (-rotDeg * Math.PI) / 180;
    const dx = worldPt.x - tx, dy = worldPt.y - ty;
    const c = Math.cos(r), s = Math.sin(r);
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  }

  function signedPolygonArea(pts) {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
      const p0 = pts[i], p1 = pts[(i + 1) % pts.length];
      a += p0.x * p1.y - p1.x * p0.y;
    }
    return a * 0.5;
  }

  function pointInPolygon(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
      if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi + 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function pointLineDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  function rdpSimplify(pts, eps) {
    if (pts.length < 4) return pts;
    let maxDist = 0, idx = 0;
    const first = pts[0], last = pts[pts.length - 1];
    for (let i = 1; i < pts.length - 1; i++) {
      const d = pointLineDist(pts[i], first, last);
      if (d > maxDist) { maxDist = d; idx = i; }
    }
    if (maxDist > eps) {
      const left = rdpSimplify(pts.slice(0, idx + 1), eps);
      const right = rdpSimplify(pts.slice(idx), eps);
      return left.slice(0, -1).concat(right);
    }
    return [first, last];
  }

  function chaikinSmooth(pts, iterations) {
    let curr = pts;
    for (let it = 0; it < iterations; it++) {
      const next = [];
      for (let i = 0; i < curr.length; i++) {
        const p0 = curr[i], p1 = curr[(i + 1) % curr.length];
        next.push({ x: 0.75 * p0.x + 0.25 * p1.x, y: 0.75 * p0.y + 0.25 * p1.y });
        next.push({ x: 0.25 * p0.x + 0.75 * p1.x, y: 0.25 * p0.y + 0.75 * p1.y });
      }
      curr = next;
    }
    return curr;
  }

  // True rounded offset & boolean union of Tool Polygon + Finger Scoops via high-res 2D Canvas SDF rasterization.
  // Eliminates all self-intersecting miter spikes and never drops a finger scoop!
  function buildUnifiedPocketContour(worldToolPts, worldScoops, clearanceMm, binW, binH) {
    if (!worldToolPts || worldToolPts.length < 3) return [];
    const scale = 3.0; // 3 pixels per mm
    const marginMm = 4.0;
    const cw = Math.ceil((binW + marginMm * 2) * scale);
    const ch = Math.ceil((binH + marginMm * 2) * scale);
    const ox = cw / 2, oy = ch / 2;

    const can = document.createElement('canvas');
    can.width = cw; can.height = ch;
    const ctx = can.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, ch);

    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#fff';
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(0.5, clearanceMm * 2 * scale);

    // 1. Draw rounded-offset tool polygon
    ctx.beginPath();
    worldToolPts.forEach((p, i) => {
      const px = ox + p.x * scale, py = oy + p.y * scale;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fill();
    if (clearanceMm > 0.05) ctx.stroke();

    // 2. Boolean-union circular finger scoops
    (worldScoops || []).forEach(sc => {
      ctx.beginPath();
      ctx.arc(ox + sc.x * scale, oy + sc.y * scale, sc.r * scale, 0, Math.PI * 2);
      ctx.fill();
    });

    // 3. Clamp to inside the bin walls (leave 1.5mm perimeter rim so top face stays intact)
    const rimPx = Math.ceil((marginMm + 1.5) * scale);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cw, rimPx);
    ctx.fillRect(0, ch - rimPx, cw, rimPx);
    ctx.fillRect(0, 0, rimPx, ch);
    ctx.fillRect(cw - rimPx, 0, rimPx, ch);

    // 4. Trace outer boundary with Moore-Neighbor contour walk
    const imgData = ctx.getImageData(0, 0, cw, ch).data;
    const mask = new Uint8Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      if (imgData[i * 4] > 127) mask[i] = 1;
    }

    let startX = -1, startY = -1;
    outer: for (let y = 1; y < ch - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        if (mask[y * cw + x]) { startX = x; startY = y; break outer; }
      }
    }
    if (startX === -1) return [];

    const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const rawPts = [];
    let cx = startX, cy = startY, backtrackDir = 0;
    let maxSteps = 12000;
    while (maxSteps-- > 0) {
      rawPts.push({ x: (cx - ox) / scale, y: (cy - oy) / scale });
      let found = false;
      for (let k = 0; k < 8; k++) {
        const dIdx = (backtrackDir + k) % 8;
        const nx = cx + dirs[dIdx][0], ny = cy + dirs[dIdx][1];
        if (nx >= 0 && nx < cw && ny >= 0 && ny < ch && mask[ny * cw + nx]) {
          cx = nx; cy = ny;
          backtrackDir = (dIdx + 5) % 8;
          found = true;
          break;
        }
      }
      if (!found || (cx === startX && cy === startY && rawPts.length > 15)) break;
    }

    const simplified = rdpSimplify(rawPts, 0.35);
    const smoothed = chaikinSmooth(simplified, 1);

    // Deduplicate vertices closer than 0.4mm so Earcut never sees degenerate zero-length edges
    const clean = [];
    for (let p of smoothed) {
      if (!clean.length || Math.hypot(p.x - clean[clean.length - 1].x, p.y - clean[clean.length - 1].y) > 0.4) {
        clean.push(p);
      }
    }
    if (clean.length > 2 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 0.4) {
      clean.pop();
    }
    return clean;
  }

  function offsetPolygon(pts, offsetMm) {
    if (!pts || pts.length < 3 || Math.abs(offsetMm) < 1e-4) return pts ? pts.slice() : [];
    const ccw = signedPolygonArea(pts) > 0 ? 1 : -1;
    const raw = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const pPrev = pts[(i - 1 + n) % n];
      const pCurr = pts[i];
      const pNext = pts[(i + 1) % n];
      const v1x = pCurr.x - pPrev.x, v1y = pCurr.y - pPrev.y;
      const l1 = Math.hypot(v1x, v1y) || 1;
      const n1x = (v1y / l1) * ccw, n1y = (-v1x / l1) * ccw;

      const v2x = pNext.x - pCurr.x, v2y = pNext.y - pCurr.y;
      const l2 = Math.hypot(v2x, v2y) || 1;
      const n2x = (v2y / l2) * ccw, n2y = (-v2x / l2) * ccw;

      let bx = n1x + n2x, by = n1y + n2y;
      const bl = Math.hypot(bx, by);
      if (bl < 1e-4) { bx = n1x; by = n1y; } else { bx /= bl; by /= bl; }
      const dot = bx * n1x + by * n1y;
      const miter = Math.min(1.35, 1 / Math.max(0.55, dot));
      raw.push({ x: pCurr.x + bx * offsetMm * miter, y: pCurr.y + by * offsetMm * miter });
    }
    return raw;
  }

  function getGfParams() {
    const pitch = parseFloat(document.getElementById('gf-pitch').value) || 42.0;
    const uHeight = parseFloat(document.getElementById('gf-u-height').value) || 7.0;
    const gx = Math.max(1, parseInt(document.getElementById('gf-grid-x').value) || 2);
    const gy = Math.max(1, parseInt(document.getElementById('gf-grid-y').value) || 5);
    const gu = Math.max(2, parseInt(document.getElementById('gf-grid-u').value) || 4);
    const clearance = parseFloat(document.getElementById('gf-clearance').value) || 1.5;
    const pocketDepth = parseFloat(document.getElementById('gf-pocket-depth').value) || 14.0;
    const chamfer = parseFloat(document.getElementById('gf-chamfer').value) || 1.2;
    const scoopR = parseFloat(document.getElementById('gf-scoop-radius').value) || 11.0;
    return {
      pitch, uHeight, gx, gy, gu,
      binW: gx * pitch - 0.5,
      binH: gy * pitch - 0.5,
      totalZ: gu * uHeight,
      clearance, pocketDepth, chamfer, scoopR,
      useFloorSupport: document.getElementById('gf-use-floor-support')?.checked ?? true,
      snapOverhang: parseFloat(document.getElementById('gf-snap-overhang')?.value) || 0.7,
      snapRelief: document.getElementById('gf-snap-relief')?.checked ?? true,
      lip: document.getElementById('gf-lip').checked,
      magnets: document.getElementById('gf-magnets').checked,
      crushRibs: document.getElementById('gf-crush-ribs').checked,
      bridgeless: document.getElementById('gf-bridgeless').checked,
      screws: document.getElementById('gf-screws').checked,
      flatBase: document.getElementById('gf-flat-base').checked
    };
  }

  function getCanvasTransform() {
    const p = getGfParams();
    const pad = 42;
    const scale = Math.min((gfCanvas.width - pad * 2) / p.binW, (gfCanvas.height - pad * 2) / p.binH);
    return { scale, cx: gfCanvas.width / 2, cy: gfCanvas.height / 2, p };
  }

  function getToolDeleteBtnMm(tool) {
    const worldPts = tool.contourMm.map(pt => transformPt(pt, tool.xMm, tool.yMm, tool.rotDeg));
    let maxX = -Infinity, minY = Infinity;
    worldPts.forEach(p => {
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
    });
    return { x: maxX + 4, y: minY - 4 };
  }

  // ==================== 2. MODE 2: INTERACTIVE 2D GRIDFINITY CANVAS ====================
  function renderGf2D() {
    const { scale, cx, cy, p } = getCanvasTransform();
    gfCtx.clearRect(0, 0, gfCanvas.width, gfCanvas.height);

    const bw = p.binW * scale, bh = p.binH * scale;
    gfCtx.fillStyle = '#141c26';
    gfCtx.strokeStyle = '#475569';
    gfCtx.lineWidth = 2;
    gfCtx.beginPath();
    gfCtx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 3.75 * scale);
    gfCtx.fill();
    gfCtx.stroke();

    gfCtx.strokeStyle = '#1e293b';
    gfCtx.lineWidth = 1;
    for (let ix = 0; ix < p.gx; ix++) {
      for (let iy = 0; iy < p.gy; iy++) {
        const cellX = (ix - p.gx / 2 + 0.5) * p.pitch;
        const cellY = (iy - p.gy / 2 + 0.5) * p.pitch;
        const sx = cx + (cellX - p.pitch / 2) * scale;
        const sy = cy + (cellY - p.pitch / 2) * scale;
        gfCtx.strokeRect(sx, sy, p.pitch * scale, p.pitch * scale);

        if (p.magnets && !p.flatBase) {
          const mOff = p.pitch / 2 - 8.0;
          [[-mOff, -mOff], [mOff, -mOff], [mOff, mOff], [-mOff, mOff]].forEach(([dx, dy]) => {
            gfCtx.beginPath();
            gfCtx.arc(cx + (cellX + dx) * scale, cy + (cellY + dy) * scale, 3.25 * scale, 0, Math.PI * 2);
            gfCtx.strokeStyle = 'rgba(148, 163, 184, 0.22)';
            gfCtx.stroke();
          });
        }
      }
    }

    window.AppState.placedTools.forEach((tool, idx) => {
      const isSelected = idx === window.AppState.activeToolIndex;
      const worldRaw = tool.contourMm.map(pt => transformPt(pt, tool.xMm, tool.yMm, tool.rotDeg));
      const localOffset = offsetPolygon(tool.contourMm, p.clearance);
      const worldOffset = localOffset.map(pt => transformPt(pt, tX(tool), tY(tool), tool.rotDeg));
      function tX(t) { return t.xMm; }
      function tY(t) { return t.yMm; }

      if (worldOffset.length > 2) {
        gfCtx.fillStyle = isSelected ? 'rgba(56, 189, 248, 0.18)' : 'rgba(56, 189, 248, 0.09)';
        gfCtx.strokeStyle = isSelected ? '#38bdf8' : '#0284c7';
        gfCtx.lineWidth = isSelected ? 2 : 1.2;
        gfCtx.setLineDash([5, 4]);
        gfCtx.beginPath();
        worldOffset.forEach((pt, i) => {
          const px = cx + pt.x * scale, py = cy + pt.y * scale;
          if (i === 0) gfCtx.moveTo(px, py); else gfCtx.lineTo(px, py);
        });
        gfCtx.closePath();
        gfCtx.fill();
        gfCtx.stroke();
        gfCtx.setLineDash([]);
      }

      if (worldRaw.length > 2) {
        gfCtx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        gfCtx.strokeStyle = '#10b981';
        gfCtx.lineWidth = 1.8;
        gfCtx.beginPath();
        worldRaw.forEach((pt, i) => {
          const px = cx + pt.x * scale, py = cy + pt.y * scale;
          if (i === 0) gfCtx.moveTo(px, py); else gfCtx.lineTo(px, py);
        });
        gfCtx.closePath();
        gfCtx.fill();
        gfCtx.stroke();
      }

      (tool.scoops || []).forEach(sc => {
        sc.r = p.scoopR;
        const wSc = transformPt(sc, tool.xMm, tool.yMm, tool.rotDeg);
        const sx = cx + wSc.x * scale, sy = cy + wSc.y * scale, sr = sc.r * scale;
        gfCtx.fillStyle = 'rgba(245, 158, 11, 0.28)';
        gfCtx.strokeStyle = '#f59e0b';
        gfCtx.lineWidth = 2;
        gfCtx.beginPath();
        gfCtx.arc(sx, sy, sr, 0, Math.PI * 2);
        gfCtx.fill();
        gfCtx.stroke();

        if (isSelected) {
          const bx = sx + sr * 0.7, by = sy - sr * 0.7;
          gfCtx.fillStyle = '#ef4444';
          gfCtx.beginPath();
          gfCtx.arc(bx, by, 7, 0, Math.PI * 2);
          gfCtx.fill();
          gfCtx.fillStyle = '#ffffff';
          gfCtx.font = 'bold 10px sans-serif';
          gfCtx.textAlign = 'center';
          gfCtx.textBaseline = 'middle';
          gfCtx.fillText('×', bx, by);
        }
      });

      (tool.snaps || []).forEach(sn => {
        const wSn = transformPt(sn, tool.xMm, tool.yMm, tool.rotDeg);
        const sx = cx + wSn.x * scale, sy = cy + wSn.y * scale;
        gfCtx.fillStyle = 'rgba(168, 85, 247, 0.42)';
        gfCtx.strokeStyle = '#a855f7';
        gfCtx.lineWidth = 2;
        gfCtx.beginPath();
        gfCtx.arc(sx, sy, 5.5 * scale, 0, Math.PI * 2);
        gfCtx.fill();
        gfCtx.stroke();

        gfCtx.fillStyle = '#f3e8ff';
        gfCtx.font = 'bold 8px monospace';
        gfCtx.textAlign = 'center';
        gfCtx.textBaseline = 'middle';
        gfCtx.fillText('SNAP', sx, sy);

        if (isSelected) {
          const bx = sx + 4.5 * scale, by = sy - 4.5 * scale;
          gfCtx.fillStyle = '#ef4444';
          gfCtx.beginPath();
          gfCtx.arc(bx, by, 6.5, 0, Math.PI * 2);
          gfCtx.fill();
          gfCtx.fillStyle = '#ffffff';
          gfCtx.font = 'bold 9px sans-serif';
          gfCtx.fillText('×', bx, by);
        }
      });

      gfCtx.fillStyle = '#e2e8f0';
      gfCtx.font = '600 11px monospace';
      gfCtx.textAlign = 'center';
      gfCtx.textBaseline = 'alphabetic';
      gfCtx.fillText(`${tool.name} (${tool.rotDeg.toFixed(0)}°)`, cx + tool.xMm * scale, cy + tool.yMm * scale);

      if (worldRaw.length > 2) {
        const delMm = getToolDeleteBtnMm(tool);
        const dxPx = cx + delMm.x * scale;
        const dyPx = cy + delMm.y * scale;
        gfCtx.fillStyle = '#ef4444';
        gfCtx.strokeStyle = '#ffffff';
        gfCtx.lineWidth = 1.5;
        gfCtx.beginPath();
        gfCtx.arc(dxPx, dyPx, 10, 0, Math.PI * 2);
        gfCtx.fill();
        gfCtx.stroke();

        gfCtx.fillStyle = '#ffffff';
        gfCtx.font = 'bold 14px sans-serif';
        gfCtx.textAlign = 'center';
        gfCtx.textBaseline = 'middle';
        gfCtx.fillText('×', dxPx, dyPx);
      }
    });
  }

  function canvasEventToMm(e) {
    const rect = gfCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (gfCanvas.width / rect.width);
    const py = (e.clientY - rect.top) * (gfCanvas.height / rect.height);
    const { scale, cx, cy } = getCanvasTransform();
    return { xMm: (px - cx) / scale, yMm: (py - cy) / scale, px, py, scale, cx, cy };
  }

  gfCanvas.addEventListener('mousedown', e => {
    const { xMm, yMm, px, py, scale, cx, cy } = canvasEventToMm(e);
    const tools = window.AppState.placedTools;

    for (let tIdx = tools.length - 1; tIdx >= 0; tIdx--) {
      const t = tools[tIdx];
      if (t.contourMm.length > 2) {
        const delMm = getToolDeleteBtnMm(t);
        const dxPx = cx + delMm.x * scale, dyPx = cy + delMm.y * scale;
        if (Math.hypot(px - dxPx, py - dyPx) <= 12) {
          tools.splice(tIdx, 1);
          window.AppState.activeToolIndex = Math.max(0, tools.length - 1);
          rebuildMode2ThreeJS();
          return;
        }
      }
    }

    for (let tIdx = tools.length - 1; tIdx >= 0; tIdx--) {
      const t = tools[tIdx];
      for (let sIdx = (t.snaps || []).length - 1; sIdx >= 0; sIdx--) {
        const sn = t.snaps[sIdx];
        const wSn = transformPt(sn, t.xMm, t.yMm, t.rotDeg);
        const sx = cx + wSn.x * scale, sy = cy + wSn.y * scale;
        if (tIdx === window.AppState.activeToolIndex) {
          const bx = sx + 4.5 * scale, by = sy - 4.5 * scale;
          if (Math.hypot(px - bx, py - by) <= 8) {
            t.snaps.splice(sIdx, 1);
            rebuildMode2ThreeJS();
            return;
          }
        }
        if (Math.hypot(xMm - wSn.x, yMm - wSn.y) <= 6.5) {
          window.AppState.activeToolIndex = tIdx;
          dragState = { type: 'snap', toolIdx: tIdx, itemIdx: sIdx };
          renderGf2D();
          return;
        }
      }
    }

    for (let tIdx = tools.length - 1; tIdx >= 0; tIdx--) {
      const t = tools[tIdx];
      for (let sIdx = (t.scoops || []).length - 1; sIdx >= 0; sIdx--) {
        const sc = t.scoops[sIdx];
        const wSc = transformPt(sc, t.xMm, t.yMm, t.rotDeg);
        const sx = cx + wSc.x * scale, sy = cy + wSc.y * scale, sr = sc.r * scale;

        if (tIdx === window.AppState.activeToolIndex) {
          const bx = sx + sr * 0.7, by = sy - sr * 0.7;
          if (Math.hypot(px - bx, py - by) <= 9) {
            t.scoops.splice(sIdx, 1);
            rebuildMode2ThreeJS();
            return;
          }
        }
        if (Math.hypot(xMm - wSc.x, yMm - wSc.y) <= sc.r) {
          window.AppState.activeToolIndex = tIdx;
          dragState = { type: 'scoop', toolIdx: tIdx, itemIdx: sIdx };
          renderGf2D();
          return;
        }
      }
    }

    for (let tIdx = tools.length - 1; tIdx >= 0; tIdx--) {
      const t = tools[tIdx];
      const worldPts = t.contourMm.map(pt => transformPt(pt, t.xMm, t.yMm, t.rotDeg));
      if (pointInPolygon(xMm, yMm, worldPts) || Math.hypot(xMm - t.xMm, yMm - t.yMm) < 18) {
        window.AppState.activeToolIndex = tIdx;
        dragState = { type: 'tool', toolIdx: tIdx, startX: xMm, startY: yMm, origX: t.xMm, origY: t.yMm };
        renderGf2D();
        return;
      }
    }
  });

  window.addEventListener('mousemove', e => {
    if (!dragState) return;
    const { xMm, yMm } = canvasEventToMm(e);
    const t = window.AppState.placedTools[dragState.toolIdx];
    if (!t) return;
    if (dragState.type === 'tool') {
      t.xMm = dragState.origX + (xMm - dragState.startX);
      t.yMm = dragState.origY + (yMm - dragState.startY);
    } else if (dragState.type === 'scoop') {
      const localPt = invTransformPt({ x: xMm, y: yMm }, t.xMm, t.yMm, t.rotDeg);
      t.scoops[dragState.itemIdx].x = localPt.x;
      t.scoops[dragState.itemIdx].y = localPt.y;
    } else if (dragState.type === 'snap') {
      const localPt = invTransformPt({ x: xMm, y: yMm }, t.xMm, t.yMm, t.rotDeg);
      t.snaps[dragState.itemIdx].x = localPt.x;
      t.snaps[dragState.itemIdx].y = localPt.y;
    }
    renderGf2D();
  });

  window.addEventListener('mouseup', () => {
    if (dragState) {
      dragState = null;
      rebuildMode2ThreeJS();
    }
  });

  gfCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    const t = window.AppState.placedTools[window.AppState.activeToolIndex];
    if (!t) return;
    t.rotDeg = (t.rotDeg + (e.deltaY > 0 ? 5 : -5)) % 360;
    renderGf2D();
  }, { passive: false });

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if ((e.key === 'Delete' || e.key === 'Backspace') &&
        document.getElementById('tab-3').classList.contains('active')) {
      const idx = window.AppState.activeToolIndex;
      if (idx >= 0 && idx < window.AppState.placedTools.length) {
        window.AppState.placedTools.splice(idx, 1);
        window.AppState.activeToolIndex = Math.max(0, window.AppState.placedTools.length - 1);
        rebuildMode2ThreeJS();
      }
    }
  });

  // ==================== 3. THREE.JS VIEWPORT MANAGER ====================
  function createOrbitViewport(containerId) {
    const container = document.getElementById(containerId);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x090d12);

    const camera = new THREE.PerspectiveCamera(42, 1, 1, 2000);
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    container.innerHTML = '';
    container.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x334155, 0.9);
    scene.add(hemi);
    const dir1 = new THREE.DirectionalLight(0xffffff, 0.75);
    dir1.position.set(120, -140, 220);
    scene.add(dir1);
    const dir2 = new THREE.DirectionalLight(0x38bdf8, 0.4);
    dir2.position.set(-140, 120, 100);
    scene.add(dir2);

    const grid = new THREE.GridHelper(300, 15, 0x38bdf8, 0x1e293b);
    grid.rotation.x = Math.PI / 2;
    scene.add(grid);

    const rootGroup = new THREE.Group();
    scene.add(rootGroup);

    let sph = { radius: 280, theta: -0.65, phi: 1.05, targetX: 0, targetY: 0 };
    let isDown = false, isRight = false, prevX = 0, prevY = 0;

    function updateCam() {
      const w = container.clientWidth || 640, h = container.clientHeight || 580;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      camera.position.set(
        sph.targetX + sph.radius * Math.sin(sph.phi) * Math.cos(sph.theta),
        sph.targetY + sph.radius * Math.sin(sph.phi) * Math.sin(sph.theta),
        sph.radius * Math.cos(sph.phi)
      );
      camera.up.set(0, 0, 1);
      camera.lookAt(sph.targetX, sph.targetY, 10);
      renderer.render(scene, camera);
    }

    renderer.domElement.addEventListener('mousedown', e => {
      isDown = true; isRight = e.button === 2 || e.shiftKey; prevX = e.clientX; prevY = e.clientY;
    });
    window.addEventListener('mousemove', e => {
      if (!isDown) return;
      const dx = e.clientX - prevX, dy = e.clientY - prevY;
      prevX = e.clientX; prevY = e.clientY;
      if (isRight) {
        sph.targetX -= dx * 0.25; sph.targetY += dy * 0.25;
      } else {
        sph.theta -= dx * 0.008;
        sph.phi = Math.max(0.1, Math.min(Math.PI - 0.1, sph.phi - dy * 0.008));
      }
      updateCam();
    });
    window.addEventListener('mouseup', () => { isDown = false; });
    renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
    renderer.domElement.addEventListener('wheel', e => {
      e.preventDefault();
      sph.radius = Math.max(50, Math.min(900, sph.radius * (e.deltaY > 0 ? 1.08 : 0.92)));
      updateCam();
    }, { passive: false });

    window.addEventListener('resize', updateCam);
    setTimeout(updateCam, 60);
    return { scene, rootGroup, updateCam };
  }

  const vpMode2 = createOrbitViewport('gf-3d-viewport');
  const vpMode1 = createOrbitViewport('m1-3d-viewport');

  function indexedMeshToThreeGeometry(mesh) {
    const geom = new THREE.BufferGeometry();
    const pos = new Float32Array(mesh.faces.length * 9);
    let k = 0;
    for (let f of mesh.faces) {
      const v0 = mesh.vertices[f[0]], v1 = mesh.vertices[f[2]], v2 = mesh.vertices[f[1]];
      pos[k++] = v0[0]; pos[k++] = -v0[1]; pos[k++] = v0[2];
      pos[k++] = v1[0]; pos[k++] = -v1[1]; pos[k++] = v1[2];
      pos[k++] = v2[0]; pos[k++] = -v2[1]; pos[k++] = v2[2];
    }
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.computeVertexNormals();
    return geom;
  }

  // ==================== 4. MODE 2: CLEAN RASTER-CONTOUR CSG + EXPLICIT SLOPED SADDLE ====================
  function makeRoundedRectPts(w, h, r, segsPerCorner = 8) {
    const pts = [];
    const rx = Math.min(r, w / 2 - 0.1), ry = Math.min(r, h / 2 - 0.1);
    const corners = [
      { cx:  w / 2 - rx, cy:  h / 2 - ry, a0: 0,             a1: Math.PI / 2 },
      { cx: -w / 2 + rx, cy:  h / 2 - ry, a0: Math.PI / 2,   a1: Math.PI },
      { cx: -w / 2 + rx, cy: -h / 2 + ry, a0: Math.PI,       a1: 1.5 * Math.PI },
      { cx:  w / 2 - rx, cy: -h / 2 + ry, a0: 1.5 * Math.PI, a1: 2 * Math.PI }
    ];
    corners.forEach(c => {
      for (let i = 0; i < segsPerCorner; i++) {
        const a = c.a0 + (i / segsPerCorner) * (c.a1 - c.a0);
        pts.push({ x: c.cx + Math.cos(a) * rx, y: c.cy + Math.sin(a) * ry });
      }
    });
    return pts;
  }

  function triangulate2DWithHoles(outerPts, holePtsArray = []) {
    const contourV2 = outerPts.map(p => new THREE.Vector2(p.x, p.y));
    const holesV2 = holePtsArray.map(h => h.map(p => new THREE.Vector2(p.x, p.y)));
    return THREE.ShapeUtils.triangulateShape(contourV2, holesV2);
  }

  function evalToolFloorZ(localY, minY, maxY, hProfile, baseFloorZ, topZ, useSupport) {
    if (!useSupport) return baseFloorZ;
    const pocketDepth = topZ - baseFloorZ;
    // t = 0.0 is the TOP tip of the tool (minimum Y), t = 1.0 is the BOTTOM base of the handle (maximum Y)
    const t = Math.max(0, Math.min(1, (localY - minY) / Math.max(1, maxY - minY)));
    let zSupport = 0;

    if (hProfile && hProfile.length >= 2) {
      const exactIdx = t * (hProfile.length - 1);
      const i0 = Math.floor(exactIdx), i1 = Math.min(hProfile.length - 1, i0 + 1);
      const f = exactIdx - i0;
      zSupport = hProfile[i0].zBottom * (1 - f) + hProfile[i1].zBottom * f;
    }

    // Fallback smooth upward ramp under the top 36% of the tool if side profile wasn't uploaded yet
    if (zSupport < 0.5 && t < 0.36) {
      const ramp = (0.36 - t) / 0.36;
      zSupport = Math.pow(ramp, 1.15) * (pocketDepth * 0.68);
    }

    const raisedZ = baseFloorZ + Math.max(0, zSupport - 0.25);
    return Math.min(topZ - 1.5, raisedZ);
  }

  function addFlatPolygonPrism(verts, faces, poly2D, z0, z1) {
    if (!poly2D || poly2D.length < 3) return;
    const pts = signedPolygonArea(poly2D) < 0 ? poly2D.slice().reverse() : poly2D.slice();
    const n = pts.length;
    const baseIdx = verts.length;

    pts.forEach(p => verts.push([p.x, p.y, z0]));
    pts.forEach(p => verts.push([p.x, p.y, z1]));

    const tris = triangulate2DWithHoles(pts, []);
    tris.forEach(([a, b, c]) => {
      faces.push([baseIdx + a, baseIdx + c, baseIdx + b]);
      faces.push([baseIdx + n + a, baseIdx + n + b, baseIdx + n + c]);
    });

    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      const b0 = baseIdx + i, b1 = baseIdx + next;
      const t0 = baseIdx + n + i, t1 = baseIdx + n + next;
      faces.push([b0, b1, t1], [b0, t1, t0]);
    }
  }

  function buildMode2Meshes() {
    const p = getGfParams();
    const topZ = p.totalZ;
    const pocketDepth = Math.min(p.totalZ - 4.8, p.pocketDepth);
    const pocketFloorZ = topZ - pocketDepth;

    const holePolys = [];
    const negVerts = [], negFaces = [];
    const saddleVerts = [], saddleFaces = [];
    const snapVerts = [], snapFaces = [];

    window.AppState.placedTools.forEach(t => {
      const worldRaw = t.contourMm.map(pt => transformPt(pt, t.xMm, t.yMm, t.rotDeg));
      const scoopsWorld = (t.scoops || []).map(sc => ({
        ...transformPt(sc, t.xMm, t.yMm, t.rotDeg),
        r: p.scoopR
      }));

      let minY = Infinity, maxY = -Infinity;
      t.contourMm.forEach(pt => { if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y; });
      const hProf = (window.AppState.activeHeightProfile && window.AppState.activeHeightProfile.length)
        ? window.AppState.activeHeightProfile
        : (t.heightProfile || []);

      // 1. Unified contour via 2D Canvas SDF rasterization (never drops a scoop or self-intersects!)
      const mergedHole = buildUnifiedPocketContour(worldRaw, scoopsWorld, p.clearance, p.binW, p.binH);
      if (mergedHole.length >= 3) {
        holePolys.push({ poly: mergedHole, tool: t, minY, maxY, hProf });
        addFlatPolygonPrism(negVerts, negFaces, mergedHole, pocketFloorZ, topZ + (p.lip ? 4.4 : 0.4));
      }
    });

    const binVerts = [], binFaces = [];
    const outerRim = makeRoundedRectPts(p.binW, p.binH, 3.75, 10);
    const outerCCW = signedPolygonArea(outerRim) < 0 ? outerRim.slice().reverse() : outerRim;
    const holesCW = holePolys.map(item => (signedPolygonArea(item.poly) > 0 ? item.poly.slice().reverse() : item.poly.slice()));

    // A. Top Surface with Clean, Exact Carved Pocket Holes
    const topStartIdx = binVerts.length;
    outerCCW.forEach(pt => binVerts.push([pt.x, pt.y, topZ]));
    const holeStartIndices = [];
    holesCW.forEach(h => {
      holeStartIndices.push(binVerts.length);
      h.forEach(pt => binVerts.push([pt.x, pt.y, topZ]));
    });

    const topTris = triangulate2DWithHoles(outerCCW, holesCW);
    topTris.forEach(([a, b, c]) => {
      binFaces.push([topStartIdx + a, topStartIdx + b, topStartIdx + c]);
    });

    // B. Solid Flat Pocket Floor + Explicit Sloped Under-Support Saddle + Inward Snap Clips
    holesCW.forEach((h, hIdx) => {
      const { tool, minY, maxY, hProf } = holePolys[hIdx];
      const n = h.length;
      const topHoleIdx = holeStartIndices[hIdx];

      // 1. Vertical Pocket Walls down to flat pocketFloorZ
      const flWallIdx = binVerts.length;
      h.forEach(pt => binVerts.push([pt.x, pt.y, pocketFloorZ]));
      for (let i = 0; i < n; i++) {
        const next = (i + 1) % n;
        binFaces.push(
          [topHoleIdx + i, flWallIdx + i, flWallIdx + next],
          [topHoleIdx + i, flWallIdx + next, topHoleIdx + next]
        );
      }

      // 2. Rock-Solid Flat Pocket Floor Cap at pocketFloorZ
      const hPos = h.slice().reverse();
      const flCapIdx = binVerts.length;
      hPos.forEach(pt => binVerts.push([pt.x, pt.y, pocketFloorZ]));
      const floorTris = triangulate2DWithHoles(hPos, []);
      floorTris.forEach(([a, b, c]) => {
        binFaces.push([flCapIdx + a, flCapIdx + b, flCapIdx + c]);
      });

      // 3. Explicit Sloped Under-Support Saddle (Watertight 3D ramp under the top of the tool!)
      // Built along the tool's local Y axis inside the offset tool contour (excluding finger scoops
      // so your fingers can always slide all the way under the tool at the scoops!).
      if (p.useFloorSupport) {
        const localToolOffset = offsetPolygon(tool.contourMm, p.clearance * 0.85);
        const slices = 44;
        const bands = [];
        for (let s = 0; s <= slices; s++) {
          const tNorm = s / slices;
          const localY = minY + 0.6 + tNorm * (maxY - minY - 1.2);
          const zFloor = evalToolFloorZ(localY, minY, maxY, hProf, pocketFloorZ, topZ, true);

          const xHits = [];
          for (let i = 0; i < localToolOffset.length; i++) {
            const p0 = localToolOffset[i], p1 = localToolOffset[(i + 1) % localToolOffset.length];
            if ((p0.y <= localY && p1.y > localY) || (p1.y <= localY && p0.y > localY)) {
              xHits.push(p0.x + ((localY - p0.y) / (p1.y - p0.y)) * (p1.x - p0.x));
            }
          }
          xHits.sort((a, b) => a - b);
          if (xHits.length >= 2) {
            const xL = xHits[0], xR = xHits[xHits.length - 1];
            if (xR > xL + 0.8) {
              const wL = transformPt({ x: xL, y: localY }, tool.xMm || 0, tool.yMm || 0, tool.rotDeg || 0);
              const wR = transformPt({ x: xR, y: localY }, tool.xMm || 0, tool.yMm || 0, tool.rotDeg || 0);
              bands.push({ wL, wR, z: zFloor });
            }
          }
        }

        const pushSaddleTo = (vArr, fArr) => {
          for (let s = 0; s < bands.length - 1; s++) {
            const b0 = bands[s], b1 = bands[s + 1];
            if (b0.z <= pocketFloorZ + 0.1 && b1.z <= pocketFloorZ + 0.1) continue;
            const sb = vArr.length;
            vArr.push([b0.wL.x, b0.wL.y, b0.z]);         // 0: Top Left s
            vArr.push([b0.wR.x, b0.wR.y, b0.z]);         // 1: Top Right s
            vArr.push([b1.wL.x, b1.wL.y, b1.z]);         // 2: Top Left s+1
            vArr.push([b1.wR.x, b1.wR.y, b1.z]);         // 3: Top Right s+1
            vArr.push([b0.wL.x, b0.wL.y, pocketFloorZ]); // 4: Bot Left s
            vArr.push([b0.wR.x, b0.wR.y, pocketFloorZ]); // 5: Bot Right s
            vArr.push([b1.wL.x, b1.wL.y, pocketFloorZ]); // 6: Bot Left s+1
            vArr.push([b1.wR.x, b1.wR.y, pocketFloorZ]); // 7: Bot Right s+1

            // Top sloped ramp surface (+Z normal), side skirts, and front/back endcaps
            fArr.push(
              [sb + 0, sb + 3, sb + 2], [sb + 0, sb + 1, sb + 3], // Top sloped ramp (+Z)
              [sb + 0, sb + 2, sb + 6], [sb + 0, sb + 6, sb + 4], // Left skirt
              [sb + 1, sb + 7, sb + 3], [sb + 1, sb + 5, sb + 7], // Right skirt
              [sb + 0, sb + 5, sb + 1], [sb + 0, sb + 4, sb + 5], // Back wall
              [sb + 2, sb + 3, sb + 7], [sb + 2, sb + 7, sb + 6]  // Front step wall
            );
          }
        };

        pushSaddleTo(binVerts, binFaces);
        pushSaddleTo(saddleVerts, saddleFaces);
      }

      // 4. Deterministic Inward Snap-Fit Retention Clips
      (tool.snaps || []).forEach(sn => {
        const wSn = transformPt(sn, tool.xMm || 0, tool.yMm || 0, tool.rotDeg || 0);
        let bestIdx = 0, bestD = Infinity;
        hPos.forEach((pt, idx) => {
          const d = Math.hypot(pt.x - wSn.x, pt.y - wSn.y);
          if (d < bestD) { bestD = d; bestIdx = idx; }
        });

        const pPrev = hPos[(bestIdx - 3 + n) % n];
        const pCurr = hPos[bestIdx];
        const pNext = hPos[(bestIdx + 3) % n];
        const tx = pNext.x - pPrev.x, ty = pNext.y - pPrev.y;
        const tl = Math.hypot(tx, ty) || 1;
        const ux = tx / tl, uy = ty / tl;
        const nx = ty / tl, ny = -tx / tl;

        const halfW = (sn.width || 10.0) * 0.5;
        const ov = Math.max(1.8, p.snapOverhang * 2.4);
        const zTopLip = topZ - 0.2;
        const zNoseTop = topZ - 1.4;
        const zNoseBot = topZ - 2.6;
        const zBotLip = Math.max(pocketFloorZ + 0.5, topZ - 4.8);

        const addClipBox = (vArr, fArr) => {
          const sBase = vArr.length;
          [-halfW, halfW].forEach(s => {
            const wx = pCurr.x + ux * s - nx * 0.3, wy = pCurr.y + uy * s - ny * 0.3;
            const tipX = pCurr.x + ux * s + nx * ov, tipY = pCurr.y + uy * s + ny * ov;
            vArr.push([wx, wy, zTopLip]);
            vArr.push([tipX, tipY, zNoseTop]);
            vArr.push([tipX, tipY, zNoseBot]);
            vArr.push([wx, wy, zBotLip]);
          });
          fArr.push(
            [sBase + 0, sBase + 5, sBase + 1], [sBase + 0, sBase + 4, sBase + 5],
            [sBase + 1, sBase + 6, sBase + 2], [sBase + 1, sBase + 5, sBase + 6],
            [sBase + 2, sBase + 7, sBase + 3], [sBase + 2, sBase + 6, sBase + 7],
            [sBase + 0, sBase + 7, sBase + 4], [sBase + 0, sBase + 3, sBase + 7],
            [sBase + 0, sBase + 2, sBase + 3], [sBase + 0, sBase + 1, sBase + 2],
            [sBase + 4, sBase + 6, sBase + 5], [sBase + 4, sBase + 7, sBase + 6]
          );
        };

        addClipBox(binVerts, binFaces);
        addClipBox(snapVerts, snapFaces);
      });
    });

    // C. Outer Bin Perimeter Walls & Bottom Base
    const botWallZ = p.flatBase ? 0.0 : 4.75;
    const botRimIdx = binVerts.length;
    outerCCW.forEach(pt => binVerts.push([pt.x, pt.y, botWallZ]));

    const nOuter = outerCCW.length;
    for (let i = 0; i < nOuter; i++) {
      const next = (i + 1) % nOuter;
      binFaces.push(
        [topStartIdx + i, botRimIdx + i, botRimIdx + next],
        [topStartIdx + i, botRimIdx + next, topStartIdx + next]
      );
    }

    const botTris = triangulate2DWithHoles(outerCCW, []);
    botTris.forEach(([a, b, c]) => {
      binFaces.push([botRimIdx + a, botRimIdx + c, botRimIdx + b]);
    });

    // D. Optional Gridfinity Stacking Lip
    if (p.lip) {
      const lipInner = makeRoundedRectPts(p.binW - 5.2, p.binH - 5.2, 1.8, 10);
      const lipTip = makeRoundedRectPts(p.binW - 1.4, p.binH - 1.4, 3.0, 10);
      const liIdx = binVerts.length;
      lipInner.forEach(pt => binVerts.push([pt.x, pt.y, topZ]));
      const ltIdx = binVerts.length;
      lipTip.forEach(pt => binVerts.push([pt.x, pt.y, topZ + 4.4]));
      const loIdx = binVerts.length;
      outerCCW.forEach(pt => binVerts.push([pt.x, pt.y, topZ + 3.6]));

      for (let i = 0; i < nOuter; i++) {
        const next = (i + 1) % nOuter;
        binFaces.push([liIdx + i, ltIdx + i, ltIdx + next], [liIdx + i, ltIdx + next, liIdx + next]);
        binFaces.push([ltIdx + i, loIdx + i, loIdx + next], [ltIdx + i, loIdx + next, ltIdx + next]);
        binFaces.push([loIdx + i, topStartIdx + i, topStartIdx + next], [loIdx + i, topStartIdx + next, loIdx + next]);
      }
    }

    // E. Gridfinity Per-Cell Baseplate Feet
    if (!p.flatBase) {
      for (let ix = 0; ix < p.gx; ix++) {
        for (let iy = 0; iy < p.gy; iy++) {
          const cx = (ix - (p.gx - 1) / 2) * p.pitch;
          const cy = (iy - (p.gy - 1) / 2) * p.pitch;
          const footTop = makeRoundedRectPts(p.pitch - 0.5, p.pitch - 0.5, 3.75, 6);
          const footBot = makeRoundedRectPts(p.pitch - 6.4, p.pitch - 6.4, 1.5, 6);
          const ftIdx = binVerts.length;
          footTop.forEach(pt => binVerts.push([cx + pt.x, cy + pt.y, 4.75]));
          const fbIdx = binVerts.length;
          footBot.forEach(pt => binVerts.push([cx + pt.x, cy + pt.y, 0.0]));
          const nf = footTop.length;
          for (let i = 0; i < nf; i++) {
            const next = (i + 1) % nf;
            binFaces.push(
              [ftIdx + i, fbIdx + i, fbIdx + next],
              [ftIdx + i, fbIdx + next, ftIdx + next]
            );
          }
          const fbTris = triangulate2DWithHoles(footBot, []);
          fbTris.forEach(([a, b, c]) => {
            binFaces.push([fbIdx + a, fbIdx + c, fbIdx + b]);
          });
        }
      }
    }

    mode2Meshes = {
      bin: { vertices: binVerts, faces: binFaces },
      saddle: { vertices: saddleVerts, faces: saddleFaces },
      neg: { vertices: negVerts, faces: negFaces },
      snaps: { vertices: snapVerts, faces: snapFaces }
    };
    return mode2Meshes;
  }

  function rebuildMode2ThreeJS() {
    renderGf2D();
    const { bin, saddle, neg, snaps } = buildMode2Meshes();
    while (vpMode2.rootGroup.children.length > 0) vpMode2.rootGroup.remove(vpMode2.rootGroup.children[0]);

    if (bin.faces.length > 0) {
      const binGeom = indexedMeshToThreeGeometry(bin);
      const binMat = new THREE.MeshStandardMaterial({
        color: 0x334155,
        roughness: 0.38,
        metalness: 0.12,
        side: THREE.DoubleSide
      });
      vpMode2.rootGroup.add(new THREE.Mesh(binGeom, binMat));
    }

    // Highlight the Sloped Under-Support Saddle in emerald green so you can clearly see the upward ramp!
    if (saddle && saddle.faces.length > 0) {
      const sadGeom = indexedMeshToThreeGeometry(saddle);
      const sadMat = new THREE.MeshStandardMaterial({
        color: 0x10b981,
        roughness: 0.32,
        metalness: 0.1,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      vpMode2.rootGroup.add(new THREE.Mesh(sadGeom, sadMat));
    }

    // Highlight Snap-Fit Retention Clips in purple
    if (snaps && snaps.faces.length > 0) {
      const snapGeom = indexedMeshToThreeGeometry(snaps);
      const snapMat = new THREE.MeshStandardMaterial({
        color: 0xa855f7,
        roughness: 0.28,
        metalness: 0.15,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      vpMode2.rootGroup.add(new THREE.Mesh(snapGeom, snapMat));
    }

    if (showNegativeGhost && neg.faces.length > 0) {
      const negGeom = indexedMeshToThreeGeometry(neg);
      const negMat = new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.22,
        roughness: 0.3,
        depthWrite: false,
        side: THREE.DoubleSide
      });
      vpMode2.rootGroup.add(new THREE.Mesh(negGeom, negMat));
    }
    vpMode2.updateCam();
    gfStatus.textContent = `3D Bin Built: ${bin.faces.length.toLocaleString()} tris | Support Saddle: ${saddle.faces.length} tris | Snaps:${snaps.faces.length} tris.`;
  }

  // ==================== 5. MODE 1: WATERTIGHT 3D TOOL RECONSTRUCTOR + TAUBIN SMOOTHING ====================
  function reconstructMode1() {
    const contour = window.AppState.activeToolContourMm;
    if (!contour || contour.length < 3) return;

    const method = document.getElementById('m1-method').value;
    const shapeMode = document.getElementById('m1-profile-shape').value;
    const axialRes = Math.max(24, Math.min(180, parseInt(document.getElementById('m1-voxel-res').value) || 96));
    const smoothIter = parseInt(document.getElementById('m1-smooth-iter').value) || 6;
    const boolOffset = parseFloat(document.getElementById('m1-boolean-offset').value) || 0.0;
    const defaultZ = parseFloat(document.getElementById('inp-tool-thickness').value) || 14.0;
    const hProf = window.AppState.activeHeightProfile || [];

    const pts = offsetPolygon(contour, boolOffset);
    let minY = Infinity, maxY = -Infinity;
    pts.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });

    const ringCount = 24;
    const rings = [];
    for (let s = 0; s < axialRes; s++) {
      const t = s / (axialRes - 1);
      const ySlice = minY + 0.2 + t * (maxY - minY - 0.4);

      const xHits = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a.y <= ySlice && b.y > ySlice) || (b.y <= ySlice && a.y > ySlice)) {
          const x = a.x + ((ySlice - a.y) / (b.y - a.y)) * (b.x - a.x);
          xHits.push(x);
        }
      }
      xHits.sort((a, b) => a - b);
      let cx = 0, rx = 0.1;
      if (xHits.length >= 2) {
        cx = (xHits[0] + xHits[xHits.length - 1]) * 0.5;
        rx = Math.max(0.1, (xHits[xHits.length - 1] - xHits[0]) * 0.5);
      } else if (s > 0) {
        cx = rings[s - 1].cx;
      }

      const tipTaper = Math.min(1.0, Math.min(t / 0.04, (1.0 - t) / 0.04));
      let zBot = 0, zTop = defaultZ;
      if (hProf.length > 1) {
        const hIdx = Math.min(hProf.length - 1, Math.floor(t * hProf.length));
        zBot = Math.max(0, Math.min(defaultZ * 0.65, (hProf[hIdx].zBottom || 0) - boolOffset));
        zTop = Math.min(defaultZ * 1.25, (hProf[hIdx].zTop || defaultZ) + boolOffset);
      }
      const midZ = (zBot + zTop) * 0.5;
      const halfThick = Math.max(0.4, (zTop - zBot) * 0.5 * tipTaper);
      zBot = midZ - halfThick;
      zTop = midZ + halfThick;

      const cz = (zBot + zTop) * 0.5;
      const rz = Math.max(1.2, (zTop - zBot) * 0.5);

      const expP = (shapeMode === 'visualhull' || method === 'carve') ? 6.0 : (shapeMode === 'rounded' ? 3.5 : 2.1);
      const ring = [];
      for (let k = 0; k < ringCount; k++) {
        const ang = (k / ringCount) * Math.PI * 2;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const norm = Math.pow(Math.pow(Math.abs(ca), expP) + Math.pow(Math.abs(sa), expP), -1 / expP);
        ring.push([cx + rx * ca * norm, ySlice, cz + rz * sa * norm]);
      }
      rings.push({ cx, y: ySlice, cz, ring });
    }

    const vertices = [], faces = [];
    rings.forEach(r => r.ring.forEach(v => vertices.push(v)));
    for (let s = 0; s < axialRes - 1; s++) {
      for (let k = 0; k < ringCount; k++) {
        const kn = (k + 1) % ringCount;
        const i00 = s * ringCount + k, i01 = s * ringCount + kn;
        const i10 = (s + 1) * ringCount + k, i11 = (s + 1) * ringCount + kn;
        faces.push([i00, i10, i11], [i00, i11, i01]);
      }
    }
    const startCapIdx = vertices.length;
    vertices.push([rings[0].cx, rings[0].y, rings[0].cz]);
    const endCapIdx = vertices.length;
    const lastR = rings[axialRes - 1];
    vertices.push([lastR.cx, lastR.y, lastR.cz]);
    for (let k = 0; k < ringCount; k++) {
      const kn = (k + 1) % ringCount;
      faces.push([startCapIdx, kn, k]);
      const base = (axialRes - 1) * ringCount;
      faces.push([endCapIdx, base + k, base + kn]);
    }

    if (smoothIter > 0) {
      const adj = Array.from({ length: vertices.length }, () => new Set());
      faces.forEach(([a, b, c]) => {
        adj[a].add(b); adj[a].add(c);
        adj[b].add(a); adj[b].add(c);
        adj[c].add(a); adj[c].add(b);
      });
      const laplacianStep = weight => {
        const nextV = vertices.map(v => v.slice());
        for (let i = 0; i < vertices.length; i++) {
          const nbrs = Array.from(adj[i]);
          if (!nbrs.length) continue;
          let sx = 0, sy = 0, sz = 0;
          nbrs.forEach(n => { sx += vertices[n][0]; sy += vertices[n][1]; sz += vertices[n][2]; });
          nextV[i][0] += weight * (sx / nbrs.length - vertices[i][0]);
          nextV[i][1] += weight * (sy / nbrs.length - vertices[i][1]);
          nextV[i][2] += weight * (sz / nbrs.length - vertices[i][2]);
        }
        for (let i = 0; i < vertices.length; i++) vertices[i] = nextV[i];
      };
      for (let it = 0; it < smoothIter; it++) {
        laplacianStep(0.45);
        laplacianStep(-0.47);
      }
    }

    window.AppState.mode1Mesh = { vertices, faces };
    while (vpMode1.rootGroup.children.length > 0) vpMode1.rootGroup.remove(vpMode1.rootGroup.children[0]);
    const geom = indexedMeshToThreeGeometry(window.AppState.mode1Mesh);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      roughness: 0.32,
      metalness: 0.55,
      side: THREE.DoubleSide
    });
    vpMode1.rootGroup.add(new THREE.Mesh(geom, mat));
    vpMode1.updateCam();
    m1Status.textContent = `Watertight Manifold Reconstructed: ${vertices.length} vertices,${faces.length} triangles.`;
  }

  // ==================== 6. CAD & VECTOR EXPORTERS (.SCAD, .STL, .3MF, .STEP, .SVG, .DXF) ====================
  function meshToAsciiStl(mesh, solidName = 'toolscan_mesh') {
    const out = [`solid ${solidName}`];
    for (let [a, b, c] of mesh.faces) {
      const v0 = mesh.vertices[a], v1 = mesh.vertices[c], v2 = mesh.vertices[b];
      out.push(`facet normal 0 0 0\nouter loop\nvertex ${v0[0].toFixed(3)} ${(-v0[1]).toFixed(3)}${v0[2].toFixed(3)}\nvertex ${v1[0].toFixed(3)}${(-v1[1]).toFixed(3)} ${v1[2].toFixed(3)}\nvertex${v2[0].toFixed(3)} ${(-v2[1]).toFixed(3)}${v2[2].toFixed(3)}\nendloop\nendfacet`);
    }
    out.push(`endsolid ${solidName}`);
    return out.join('\n');
  }

  function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i];
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return (c ^ -1) >>> 0;
  }

  function createZipBlob(files) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const nameBytes = enc.encode(f.name);
      const dataBytes = enc.encode(f.content);
      const crc = crc32(dataBytes);
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true);
      lv.setUint32(14, crc, true); lv.setUint32(18, dataBytes.length, true); lv.setUint32(22, dataBytes.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lfh.set(nameBytes, 30);

      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, dataBytes.length, true); cv.setUint32(24, dataBytes.length, true);
      cv.setUint16(28, nameBytes.length, true); cv.setUint32(42, offset, true);
      cdh.set(nameBytes, 46);

      parts.push(lfh, dataBytes);
      central.push(cdh);
      offset += lfh.length + dataBytes.length;
    });
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...central, eocd], { type: 'model/3mf' });
  }

  function exportMeshAs3MF(mesh, filename) {
    const vXml = mesh.vertices.map(v => `<vertex x="${v[0].toFixed(3)}" y="${(-v[1]).toFixed(3)}" z="${v[2].toFixed(3)}"/>`).join('\n');
    const tXml = mesh.faces.map(f => `<triangle v1="${f[0]}" v2="${f[2]}" v3="${f[1]}"/>`).join('\n');
    const modelXml = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>\n${vXml}\n</vertices><triangles>\n${tXml}\n</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
    const typesXml = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
    const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
    const blob = createZipBlob([
      { name: '[Content_Types].xml', content: typesXml },
      { name: '_rels/.rels', content: relsXml },
      { name: '3D/3dmodel.model', content: modelXml }
    ]);
    window.AppState.downloadBlob(blob, filename);
  }

function generateMode2OpenSCAD() {
    const p = getGfParams();
    const lines = [
      `// ============================================================================`,
      `// ToolScan CAD — Parametric Gridfinity Tool Holder with Snap-Clips & Support`,
      `// Zero external dependencies. Compatible with OpenSCAD Customizer & Manifold.`,
      `// ============================================================================`,
      ``,
      `/* [Gridfinity Bin Dimensions] */`,
      `grid_x = ${p.gx};`,
      `grid_y = ${p.gy};`,
      `grid_u = ${p.gu};`,
      `pitch = ${p.pitch.toFixed(2)};`,
      `u_height = ${p.uHeight.toFixed(2)};`,
      `include_stacking_lip = ${p.lip};`,
      `flat_drawer_bottom = ${p.flatBase};`,
      ``,
      `/* [Pocket, Snap-Fit & Under-Support Parameters] */`,
      `clearance = ${p.clearance.toFixed(2)};`,
      `pocket_depth = ${p.pocketDepth.toFixed(2)};`,
      `entry_chamfer = ${p.chamfer.toFixed(2)};`,
      `scoop_radius = ${p.scoopR.toFixed(2)};`,
      `dished_scoop_bottom = true;`,
      `use_contoured_floor_support = ${p.useFloorSupport};`,
      `snap_overhang_mm = ${p.snapOverhang.toFixed(2)};`,
      `use_snap_flex_slots = ${p.snapRelief};`,
      ``,
      `/* [Text Label Parameters] */`,
      `include_text_labels = true;`,
      `text_font = "Liberation Sans:style=Bold";`,
      `text_size = 4.20;`,
      `text_depth = -0.60;`,
      `text_offset_y = 0.0;`,
      ``,
      `/* [Baseplate Magnet & Screw Options] */`,
      `use_magnets = ${p.magnets};`,
      `magnet_diameter = 6.50;`,
      `magnet_depth = 2.40;`,
      `use_crush_ribs = ${p.crushRibs};`,
      `crush_rib_count = 8;`,
      `crush_rib_interference = 0.22;`,
      `bridgeless_magnets = ${p.bridgeless};`,
      `use_m3_screws = ${p.screws};`,
      `m3_diameter = 3.40;`,
      `m3_depth = 6.00;`,
      ``,
      `render_mode = "bin"; // ["bin", "negative"]`,
      `$fn = 64;`,
      ``,
      `bin_w = grid_x * pitch - 0.50;`,
      `bin_h = grid_y * pitch - 0.50;`,
      `total_z = grid_u * u_height;`,
      `outer_rad = 3.75;`,
      `foot_height = flat_drawer_bottom ? 0 : 4.75;`,
      `lip_height = 4.40;`,
      `pocket_floor_z = max(foot_height + 1.0, total_z - pocket_depth);`,
      ``,
      `module rounded_rect_2d(w, h, r) {`,
      `  r_clamped = max(0.05, min(r, min(w, h) / 2 - 0.05));`,
      `  offset(r = r_clamped) square([w - 2 * r_clamped, h - 2 * r_clamped], center = true);`,
      `}`,
      ``,
      `module gridfinity_single_foot() {`,
      `  cell_w = pitch - 0.50;`,
      `  w0 = cell_w - 2 * (0.80 + 2.15);`,
      `  r0 = max(0.80, outer_rad - (0.80 + 2.15));`,
      `  w1 = cell_w - 2 * 2.15;`,
      `  r1 = max(1.60, outer_rad - 2.15);`,
      `  hull() {`,
      `    linear_extrude(height = 0.01) rounded_rect_2d(w0, w0, r0);`,
      `    translate([0, 0, 0.80]) linear_extrude(height = 1.80) rounded_rect_2d(w1, w1, r1);`,
      `  }`,
      `  hull() {`,
      `    translate([0, 0, 2.59]) linear_extrude(height = 0.01) rounded_rect_2d(w1, w1, r1);`,
      `    translate([0, 0, 4.75]) linear_extrude(height = 0.01) rounded_rect_2d(cell_w, cell_w, outer_rad);`,
      `  }`,
      `}`,
      ``,
      `module magnet_screw_cavity() {`,
      `  if (use_magnets) {`,
      `    difference() {`,
      `      cylinder(d = magnet_diameter, h = magnet_depth + 0.02);`,
      `      if (use_crush_ribs) {`,
      `        for (i = [0 : crush_rib_count - 1]) {`,
      `          rotate([0, 0, i * (360 / crush_rib_count)])`,
      `            translate([magnet_diameter / 2, 0, 0])`,
      `              cylinder(r = crush_rib_interference * 1.6, h = magnet_depth + 0.05, $fn = 3);`,
      `        }`,
      `      }`,
      `    }`,
      `    if (bridgeless_magnets) {`,
      `      translate([0, 0, magnet_depth - 0.01])`,
      `        linear_extrude(height = 0.42)`,
      `          intersection() {`,
      `            circle(d = magnet_diameter);`,
      `            square([magnet_diameter + 1, m3_diameter], center = true);`,
      `          }`,
      `      translate([0, 0, magnet_depth + 0.39])`,
      `        linear_extrude(height = 0.42)`,
      `          square([m3_diameter, m3_diameter], center = true);`,
      `    }`,
      `  }`,
      `  if (use_m3_screws) {`,
      `    cylinder(d = m3_diameter, h = m3_depth);`,
      `  }`,
      `}`,
      ``,
      `module gridfinity_stacking_lip() {`,
      `  z_pts = [0.00, 0.70, 2.50, 4.40];`,
      `  insets = [2.60, 1.90, 1.90, 0.00];`,
      `  for (s = [0 : 2]) {`,
      `    hull() {`,
      `      translate([0, 0, total_z + z_pts[s]])`,
      `        linear_extrude(height = 0.02)`,
      `          difference() {`,
      `            rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `            offset(r = -max(0.05, insets[s])) rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `          }`,
      `      translate([0, 0, total_z + z_pts[s + 1]])`,
      `        linear_extrude(height = 0.02)`,
      `          difference() {`,
      `            rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `            offset(r = -max(0.05, insets[s + 1])) rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `          }`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `module single_tool_cutout(pts, scoops) {`,
      `  cut_top = total_z + (include_stacking_lip ? lip_height + 1.0 : 1.0);`,
      `  cut_h = cut_top - pocket_floor_z;`,
      `  translate([0, 0, pocket_floor_z])`,
      `    linear_extrude(height = cut_h)`,
      `      offset(r = clearance) polygon(points = pts);`,
      `  if (entry_chamfer > 0.05) {`,
      `    hull() {`,
      `      translate([0, 0, total_z - entry_chamfer])`,
      `        linear_extrude(height = 0.02)`,
      `          offset(r = clearance) polygon(points = pts);`,
      `      translate([0, 0, total_z + 0.02])`,
      `        linear_extrude(height = cut_top - total_z)`,
      `          offset(r = clearance + entry_chamfer) polygon(points = pts);`,
      `    }`,
      `  }`,
      `  for (sc = scoops) {`,
      `    translate([sc[0], sc[1], 0]) {`,
      `      if (dished_scoop_bottom) {`,
      `        r_dish = min(scoop_radius, pocket_depth * 0.65);`,
      `        hull() {`,
      `          translate([0, 0, pocket_floor_z + r_dish])`,
      `            scale([1, 1, r_dish / scoop_radius]) sphere(r = scoop_radius);`,
      `          translate([0, 0, cut_top])`,
      `            cylinder(r = scoop_radius, h = 0.1);`,
      `        }`,
      `      } else {`,
      `        translate([0, 0, pocket_floor_z])`,
      `          cylinder(r = scoop_radius, h = cut_h);`,
      `      }`,
      `    }`,
      `  }`,
      `}`,
      ``,
      `// ---- Raised Under-Support Floor Saddle & Snap-Fit Clips ----`,
      `module tool_positive_features() {`
    ];

    window.AppState.placedTools.forEach(t => {
      const ptsStr = t.contourMm.map(pt => `[${pt.x.toFixed(2)},${(-pt.y).toFixed(2)}]`).join(', ');
      let minY = Infinity, maxY = -Infinity;
      t.contourMm.forEach(pt => { if (pt.y < minY) minY = pt.y; if (pt.y > maxY) maxY = pt.y; });
      const hProf = (window.AppState.activeHeightProfile && window.AppState.activeHeightProfile.length)
        ? window.AppState.activeHeightProfile
        : (t.heightProfile || []);

      lines.push(`  translate([${t.xMm.toFixed(2)}, ${(-t.yMm).toFixed(2)}, 0]) rotate([0, 0,${(-t.rotDeg).toFixed(2)}]) {`);
      lines.push(`    if (use_contoured_floor_support) {`);
      lines.push(`      intersection() {`);
      lines.push(`        translate([0, 0, pocket_floor_z]) linear_extrude(height = pocket_depth) offset(r = clearance) polygon(points = [${ptsStr}]);`);
      lines.push(`        union() {`);

      const numSlices = 24;
      const sliceLen = (maxY - minY) / numSlices;
      for (let s = 0; s < numSlices; s++) {
        const localY = minY + (s + 0.5) * sliceLen;
        const zFloor = evalToolFloorZ(localY, minY, maxY, hProf, p.totalZ - p.pocketDepth, p.totalZ, true);
        const zSup = Math.max(0, zFloor - (p.totalZ - p.pocketDepth));
        if (zSup > 0.25) {
          const yCenterOpenSCAD = -localY;
          lines.push(`          translate([0, ${yCenterOpenSCAD.toFixed(2)}, pocket_floor_z +${(zSup / 2).toFixed(2)}]) cube([200, ${(sliceLen + 0.4).toFixed(2)},${zSup.toFixed(2)}], center = true);`);
        }
      }

      lines.push(`        }`);
      lines.push(`      }`);
      lines.push(`    }`);

      (t.snaps || []).forEach(sn => {
        const dirSign = sn.x < 0 ? 1 : -1;
        lines.push(`    translate([${sn.x.toFixed(2)},${(-sn.y).toFixed(2)}, total_z - 2.2]) rotate([90, 0, 0]) linear_extrude(height = ${(sn.width || 12).toFixed(1)}, center = true) polygon(points = [[0, 1.4], [${(dirSign * p.snapOverhang).toFixed(2)}, 0], [0, -1.6]]);`);
      });

      lines.push(`  }`);
    });

    lines.push(
      `}`,
      ``,
      `module snap_relief_slots() {`,
      `  if (use_snap_flex_slots) {`
    );

    window.AppState.placedTools.forEach(t => {
      lines.push(`    translate([${t.xMm.toFixed(2)}, ${(-t.yMm).toFixed(2)}, 0]) rotate([0, 0,${(-t.rotDeg).toFixed(2)}]) {`);
      (t.snaps || []).forEach(sn => {
        const wallOutShift = sn.x < 0 ? -(p.clearance + 2.2) : (p.clearance + 2.2);
        lines.push(`      translate([${(sn.x + wallOutShift).toFixed(2)},${(-sn.y).toFixed(2)}, pocket_floor_z]) hull() { translate([0, -6, 0]) cylinder(d = 1.6, h = pocket_depth + 6, $fn = 20); translate([0, 6, 0]) cylinder(d = 1.6, h = pocket_depth + 6,$fn = 20); }`);
      });
      lines.push(`    }`);
    });

    lines.push(
      `  }`,
      `}`,
      ``,
      `module tool_text_labels() {`,
      `  if (include_text_labels) {`
    );

    window.AppState.placedTools.forEach(t => {
      const safeName = (t.name || 'Tool').replace(/"/g, '\\"');
      lines.push(`    translate([${t.xMm.toFixed(2)},${(-t.yMm).toFixed(2)} + text_offset_y, pocket_floor_z - 0.02])`);
      lines.push(`      linear_extrude(height = abs(text_depth) + 0.02)`);
      lines.push(`        text("${safeName}", size = text_size, font = text_font, halign = "center", valign = "center");`);
    });

    lines.push(
      `  }`,
      `}`,
      ``,
      `module tool_negative_volume() {`
    );

    window.AppState.placedTools.forEach(t => {
      const ptsStr = t.contourMm.map(pt => `[${pt.x.toFixed(2)},${(-pt.y).toFixed(2)}]`).join(', ');
      const scoopsStr = (t.scoops || []).map(sc => `[${sc.x.toFixed(2)},${(-sc.y).toFixed(2)}]`).join(', ');
      lines.push(`  translate([${t.xMm.toFixed(2)},${(-t.yMm).toFixed(2)}, 0])`);
      lines.push(`    rotate([0, 0, ${(-t.rotDeg).toFixed(2)}])`);
      lines.push(`      single_tool_cutout(pts = [${ptsStr}], scoops = [${scoopsStr}]);`);
    });

    lines.push(
      `}`,
      ``,
      `module gridfinity_bin() {`,
      `  union() {`,
      `    difference() {`,
      `      union() {`,
      `        difference() {`,
      `          union() {`,
      `            if (flat_drawer_bottom) {`,
      `              linear_extrude(height = total_z) rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `            } else {`,
      `              for (ix = [0 : grid_x - 1], iy = [0 : grid_y - 1]) {`,
      `                cx = (ix - (grid_x - 1) / 2) * pitch;`,
      `                cy = (iy - (grid_y - 1) / 2) * pitch;`,
      `                translate([cx, cy, 0]) gridfinity_single_foot();`,
      `              }`,
      `              translate([0, 0, 4.74])`,
      `                linear_extrude(height = total_z - 4.74)`,
      `                  rounded_rect_2d(bin_w, bin_h, outer_rad);`,
      `            }`,
      `            if (include_stacking_lip) {`,
      `              gridfinity_stacking_lip();`,
      `            }`,
      `          }`,
      `          if (!flat_drawer_bottom && (use_magnets || use_m3_screws)) {`,
      `            m_off = pitch / 2 - 8.0;`,
      `            for (ix = [0 : grid_x - 1], iy = [0 : grid_y - 1]) {`,
      `              cx = (ix - (grid_x - 1) / 2) * pitch;`,
      `              cy = (iy - (grid_y - 1) / 2) * pitch;`,
      `              for (dx = [-m_off, m_off], dy = [-m_off, m_off]) {`,
      `                translate([cx + dx, cy + dy, -0.01]) magnet_screw_cavity();`,
      `              }`,
      `            }`,
      `          }`,
      `        }`,
      `        if (text_depth > 0) {`,
      `          tool_text_labels();`,
      `        }`,
      `      }`,
      `      tool_negative_volume();`,
      `      snap_relief_slots();`,
      `      if (text_depth < 0) {`,
      `        translate([0, 0, text_depth])`,
      `          tool_text_labels();`,
      `      }`,
      `    }`,
      `    tool_positive_features();`,
      `  }`,
      `}`,
      ``,
      `if (render_mode == "negative") {`,
      `  difference() {`,
      `    tool_negative_volume();`,
      `    tool_positive_features();`,
      `  }`,
      `} else {`,
      `  gridfinity_bin();`,
      `}`
    );

    return lines.join('\n') + '\n';
  }

  function exportMode2Step() {
    const p = getGfParams();
    const t = window.AppState.placedTools[window.AppState.activeToolIndex] || window.AppState.placedTools[0];
    const pts = t ? offsetPolygon(t.contourMm, p.clearance).map(pt => transformPt(pt, t.xMm, t.yMm, t.rotDeg)) : [];
    let step = `ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('ToolScan CAD Extruded Tool Pocket Solid'),'2;1');\nFILE_NAME('tool_pocket.step','2026-10-18T00:00:00',('ToolScan'),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\nENDSEC;\nDATA;\n`;
    let id = 10;
    const ptIds = pts.map(pt => {
      step += `#${id} = CARTESIAN_POINT('',(${pt.x.toFixed(3)},${(-pt.y).toFixed(3)},0.0));\n`;
      return `#${id++}`;
    });
    if (ptIds.length > 2) ptIds.push(ptIds[0]);
    step += `#${id} = POLYLINE('tool_contour',(${ptIds.join(',')}));\n`;
    step += `#${id + 1} = DIRECTION('extrude_dir',(0.0,0.0,1.0));\n`;
    step += `#${id + 2} = VECTOR('extrude_vec',#${id + 1},${p.pocketDepth.toFixed(3)});\n`;
    step += `ENDSEC;\nEND-ISO-10303-21;\n`;
    window.AppState.downloadBlob(step, 'ToolScan_Pocket_Profile.step', 'application/step');
  }

  function exportMode2Svg() {
    const p = getGfParams();
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${p.binW.toFixed(2)}mm" height="${p.binH.toFixed(2)}mm" viewBox="${(-p.binW / 2).toFixed(2)} ${(-p.binH / 2).toFixed(2)} ${p.binW.toFixed(2)} ${p.binH.toFixed(2)}">\n`;
    svg += `  <rect x="${(-p.binW / 2).toFixed(2)}" y="${(-p.binH / 2).toFixed(2)}" width="${p.binW.toFixed(2)}" height="${p.binH.toFixed(2)}" rx="3.75" fill="none" stroke="#000" stroke-width="0.4"/>\n`;
    window.AppState.placedTools.forEach(t => {
      const offPts = offsetPolygon(t.contourMm, p.clearance).map(pt => transformPt(pt, t.xMm, t.yMm, t.rotDeg));
      const d = offPts.map((pt, i) => `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(2)} ${pt.y.toFixed(2)}`).join(' ') + ' Z';
      svg += `  <path d="${d}" fill="none" stroke="#0284c7" stroke-width="0.5"/>\n`;
      (t.scoops || []).forEach(sc => {
        const w = transformPt(sc, t.xMm, t.yMm, t.rotDeg);
        svg += `  <circle cx="${w.x.toFixed(2)}" cy="${w.y.toFixed(2)}" r="${p.scoopR.toFixed(2)}" fill="none" stroke="#f59e0b" stroke-width="0.4"/>\n`;
      });
    });
    svg += `</svg>`;
    window.AppState.downloadBlob(svg, 'ToolScan_1to1_Outline.svg', 'image/svg+xml');
  }

  function exportMode2Dxf() {
    const p = getGfParams();
    let dxf = `0\nSECTION\n2\nENTITIES\n`;
    window.AppState.placedTools.forEach(t => {
      const offPts = offsetPolygon(t.contourMm, p.clearance).map(pt => transformPt(pt, t.xMm, t.yMm, t.rotDeg));
      for (let i = 0; i < offPts.length; i++) {
        const a = offPts[i], b = offPts[(i + 1) % offPts.length];
        dxf += `0\nLINE\n8\nTOOL_POCKET\n10\n${a.x.toFixed(3)}\n20\n${(-a.y).toFixed(3)}\n11\n${b.x.toFixed(3)}\n21\n${(-b.y).toFixed(3)}\n`;
      }
      (t.scoops || []).forEach(sc => {
        const w = transformPt(sc, t.xMm, t.yMm, t.rotDeg);
        dxf += `0\nCIRCLE\n8\nFINGER_SCOOPS\n10\n${w.x.toFixed(3)}\n20\n${(-w.y).toFixed(3)}\n40\n${p.scoopR.toFixed(3)}\n`;
      });
    });
    dxf += `0\nENDSEC\n0\nEOF\n`;
    window.AppState.downloadBlob(dxf, 'ToolScan_1to1_Outline.dxf', 'application/dxf');
  }

  // ==================== 7. UI BUTTON & EVENT WIRING ====================
  ['gf-pitch', 'gf-u-height', 'gf-grid-x', 'gf-grid-y', 'gf-grid-u', 'gf-clearance', 'gf-pocket-depth', 'gf-chamfer', 'gf-scoop-radius',
   'gf-use-floor-support', 'gf-snap-overhang', 'gf-snap-relief',
   'gf-lip', 'gf-magnets', 'gf-crush-ribs', 'gf-bridgeless', 'gf-screws', 'gf-flat-base'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', rebuildMode2ThreeJS);
  });

  document.getElementById('btn-gf-autofit').addEventListener('click', () => {
    const pitch = parseFloat(document.getElementById('gf-pitch').value) || 42.0;
    const cl = parseFloat(document.getElementById('gf-clearance').value) || 1.5;
    let maxX = 20, maxY = 20;
    window.AppState.placedTools.forEach(t => {
      t.contourMm.forEach(pt => {
        const w = transformPt(pt, t.xMm, t.yMm, t.rotDeg);
        maxX = Math.max(maxX, Math.abs(w.x) + cl + 4.5);
        maxY = Math.max(maxY, Math.abs(w.y) + cl + 4.5);
      });
    });
    document.getElementById('gf-grid-x').value = Math.max(1, Math.ceil((maxX * 2) / pitch));
    document.getElementById('gf-grid-y').value = Math.max(1, Math.ceil((maxY * 2) / pitch));
    rebuildMode2ThreeJS();
  });

  document.getElementById('btn-gf-rotate-45').addEventListener('click', () => {
    const t = window.AppState.placedTools[window.AppState.activeToolIndex];
    if (t) { t.rotDeg = (t.rotDeg + 45) % 360; rebuildMode2ThreeJS(); }
  });

  document.getElementById('btn-gf-add-scoop').addEventListener('click', () => {
    const t = window.AppState.placedTools[window.AppState.activeToolIndex];
    if (t) {
      const r = parseFloat(document.getElementById('gf-scoop-radius').value) || 11.0;
      t.scoops.push({ x: 0, y: 0, r });
      rebuildMode2ThreeJS();
    }
  });

  const addSnapBtn = document.getElementById('btn-gf-add-snap');
  if (addSnapBtn) {
    addSnapBtn.addEventListener('click', () => {
      const t = window.AppState.placedTools[window.AppState.activeToolIndex];
      if (t) {
        t.snaps = t.snaps || [];
        t.snaps.push({ x: -12, y: 0, width: 12.0 });
        rebuildMode2ThreeJS();
      }
    });
  }

  document.getElementById('btn-gf-clear-tools').addEventListener('click', () => {
    window.AppState.placedTools = [];
    rebuildMode2ThreeJS();
  });

  document.getElementById('btn-gf-rebuild-3d').addEventListener('click', rebuildMode2ThreeJS);
  document.getElementById('btn-gf-toggle-neg').addEventListener('click', () => {
    showNegativeGhost = !showNegativeGhost;
    rebuildMode2ThreeJS();
  });

  document.getElementById('btn-exp-scad').addEventListener('click', () => {
    window.AppState.downloadBlob(generateMode2OpenSCAD(), 'Gridfinity_Tool_Holder.scad', 'text/plain');
  });
  document.getElementById('btn-exp-bin-stl').addEventListener('click', () => {
    buildMode2Meshes();
    window.AppState.downloadBlob(meshToAsciiStl(mode2Meshes.bin, 'gridfinity_bin'), 'Gridfinity_Tool_Bin.stl', 'application/sla');
  });
  document.getElementById('btn-exp-neg-stl').addEventListener('click', () => {
    buildMode2Meshes();
    window.AppState.downloadBlob(meshToAsciiStl(mode2Meshes.neg, 'tool_negative'), 'Tool_Negative_Volume.stl', 'application/sla');
  });
  document.getElementById('btn-exp-3mf').addEventListener('click', () => {
    buildMode2Meshes();
    exportMeshAs3MF(mode2Meshes.bin, 'Gridfinity_Tool_Bin.3mf');
  });
  document.getElementById('btn-exp-step').addEventListener('click', exportMode2Step);
  document.getElementById('btn-exp-svg').addEventListener('click', exportMode2Svg);
  document.getElementById('btn-exp-dxf').addEventListener('click', exportMode2Dxf);

  document.getElementById('btn-m1-reconstruct').addEventListener('click', reconstructMode1);
  ['m1-method', 'm1-profile-shape', 'm1-voxel-res', 'm1-smooth-iter', 'm1-boolean-offset'].forEach(id => {
    document.getElementById(id).addEventListener('change', reconstructMode1);
  });

  document.getElementById('btn-m1-exp-stl').addEventListener('click', () => {
    if (!window.AppState.mode1Mesh.faces.length) reconstructMode1();
    window.AppState.downloadBlob(meshToAsciiStl(window.AppState.mode1Mesh, 'mode1_tool_mesh'), 'Tool_3D_Model.stl', 'application/sla');
  });
  document.getElementById('btn-m1-exp-3mf').addEventListener('click', () => {
    if (!window.AppState.mode1Mesh.faces.length) reconstructMode1();
    exportMeshAs3MF(window.AppState.mode1Mesh, 'Tool_3D_Model.3mf');
  });
  document.getElementById('btn-m1-exp-scad').addEventListener('click', () => {
    if (!window.AppState.mode1Mesh.faces.length) reconstructMode1();
    const m = window.AppState.mode1Mesh;
    const pts = m.vertices.map(v => `[${v[0].toFixed(2)},${(-v[1]).toFixed(2)},${v[2].toFixed(2)}]`).join(',');
    const fcs = m.faces.map(f => `[${f[0]},${f[1]},${f[2]}]`).join(',');
    const scad = `// ToolScan CAD — Mode 1 Reconstructed 3D Tool Polyhedron\npolyhedron(points=[${pts}], faces=[${fcs}], convexity=6);\n`;
    window.AppState.downloadBlob(scad, 'Tool_3D_Polyhedron.scad', 'text/plain');
  });

  window.addEventListener('tab-changed', e => {
    if (e.detail === 'tab-3') {
      setTimeout(rebuildMode2ThreeJS, 50);
    } else if (e.detail === 'tab-4') {
      setTimeout(reconstructMode1, 50);
    }
  });

  window.CAD3DEngine = {
    refreshMode2: rebuildMode2ThreeJS,
    reconstructMode1
  };
})();
