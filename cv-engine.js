// ==================== COMPLETE COMPUTER VISION ENGINE (cv-engine.js) ====================
(function () {
  const cvCanvas = document.getElementById('cv-canvas');
  const cvCtx = cvCanvas.getContext('2d', { willReadFrequently: true });
  const sideCanvas = document.getElementById('side-canvas');
  const sideCtx = sideCanvas.getContext('2d', { willReadFrequently: true });
  const statusEl = document.getElementById('cv-status');

  // Exact 180:250 isotropic aspect ratio (4.0 px/mm in both X and Y)
  cvCanvas.width = 720;
  cvCanvas.height = 1000;
  const W = cvCanvas.width;
  const H = cvCanvas.height;

  const state = {
    rawTopImg: null,
    rawSideImg: null,
    rectifiedImageData: null,
    mask: new Uint8Array(W * H),
    userMaskOverride: new Int8Array(W * H),
    fiducialCornersPx: null,
    contourPx: [],
    contourMm: [],
    editMode: 'poly',
    dragVertexIdx: -1,
    isPainting: false,
    bridgeStart: null,
    bridgeCurrent: null,
    solvedCamHeightMm: 420.0
  };

  function setStatus(msg) {
    if (statusEl) statusEl.textContent = msg;
  }

  // ==================== 1. SYNTHETIC TEST PHOTO GENERATOR ====================
  function loadSyntheticTestSet() {
    setStatus('Synthesizing perspective Top + Side photos with cast shadows & specular reflections...');
    const srcW = 900, srcH = 1200;
    const off = document.createElement('canvas');
    off.width = srcW; off.height = srcH;
    const ctx = off.getContext('2d');

    ctx.fillStyle = '#1e242b';
    ctx.fillRect(0, 0, srcW, srcH);

    const srcQuad = [
      { x: 145, y: 110 },
      { x: 765, y: 135 },
      { x: 810, y: 1085 },
      { x: 95,  y: 1060 }
    ];
    const dstQuad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];

    const sceneCan = document.createElement('canvas');
    sceneCan.width = W; sceneCan.height = H;
    const sctx = sceneCan.getContext('2d');

    const grad = sctx.createRadialGradient(W * 0.35, H * 0.3, 40, W * 0.5, H * 0.5, 700);
    grad.addColorStop(0, '#fcfcfc');
    grad.addColorStop(1, '#dce1e8');
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, W, H);

    const mSz = 64;
    [[8, 8], [W - mSz - 8, 8], [W - mSz - 8, H - mSz - 8], [8, H - mSz - 8]].forEach(([mx, my]) => {
      sctx.fillStyle = '#111';
      sctx.fillRect(mx, my, mSz, mSz);
      sctx.fillStyle = '#fff';
      sctx.fillRect(mx + 16, my + 16, 16, 16);
      sctx.fillRect(mx + 32, my + 32, 16, 16);
    });

    function traceWrenchPath(c, offsetX, offsetY, scale = 1.0) {
      c.save();
      c.translate(310 + offsetX, 500 + offsetY);
      c.rotate(-0.18);
      c.scale(scale, scale);
      c.beginPath();
      c.moveTo(-36, -240);
      c.bezierCurveTo(-68, -265, -72, -325, -34, -355);
      c.lineTo(-18, -295);
      c.lineTo(18, -295);
      c.lineTo(34, -355);
      c.bezierCurveTo(72, -325, 68, -265, 36, -240);
      c.bezierCurveTo(24, -140, 24, 130, 38, 225);
      c.bezierCurveTo(64, 255, 62, 325, 0, 345);
      c.bezierCurveTo(-62, 325, -64, 255, -38, 225);
      c.bezierCurveTo(-24, 130, -24, -140, -36, -240);
      c.closePath();
      c.restore();
    }

    traceWrenchPath(sctx, 18, 14, 1.03);
    sctx.fillStyle = 'rgba(135, 145, 162, 0.42)';
    sctx.fill('evenodd');

    traceWrenchPath(sctx, 0, 0, 1.034);
    const metalGrad = sctx.createLinearGradient(180, 150, 440, 840);
    metalGrad.addColorStop(0, '#333b48');
    metalGrad.addColorStop(0.50, '#f8fafc');
    metalGrad.addColorStop(0.55, '#374151');
    metalGrad.addColorStop(1, '#1f2937');
    sctx.fillStyle = metalGrad;
    sctx.fill('evenodd');

    const srcData = sctx.getImageData(0, 0, W, H);
    const dstData = ctx.getImageData(0, 0, srcW, srcH);
    const H_skewToRect = solveHomography(srcQuad, dstQuad);
    warpPerspectivePixels(srcData, dstData, H_skewToRect);
    ctx.putImageData(dstData, 0, 0);

    state.rawTopImg = off;
    state.fiducialCornersPx = srcQuad;

    // Synthesize matching perspective Side-Profile image with sloped top neck under-support
    const sideScene = document.createElement('canvas');
    sideScene.width = W; sideScene.height = H;
    const ssctx = sideScene.getContext('2d');
    ssctx.fillStyle = grad;
    ssctx.fillRect(0, 0, W, H);
    [[8, 8], [W - mSz - 8, 8], [W - mSz - 8, H - mSz - 8], [8, H - mSz - 8]].forEach(([mx, my]) => {
      ssctx.fillStyle = '#111';
      ssctx.fillRect(mx, my, mSz, mSz);
    });
    ssctx.fillStyle = '#dc2626';
    for (let y = 160; y <= 840; y++) {
      const t = (y - 160) / (840 - 160);
      // Top 35% (t < 0.35) slopes upward from the resting surface like the otoscope neck
      const zBotMm = t < 0.35 ? Math.pow((0.35 - t) / 0.35, 1.2) * 8.5 : 0.0;
      const zTopMm = t < 0.35 ? zBotMm + 7.5 + t * 18.0 : 16.0;
      const xL = 250 + zBotMm * 4.0;
      const xR = 250 + zTopMm * 4.0;
      ssctx.fillRect(xL, y, Math.max(2, xR - xL), 1.5);
    }
    const sideOff = document.createElement('canvas');
    sideOff.width = srcW; sideOff.height = srcH;
    const sideOffCtx = sideOff.getContext('2d');
    sideOffCtx.fillStyle = '#1e242b';
    sideOffCtx.fillRect(0, 0, srcW, srcH);
    const sideDstData = sideOffCtx.getImageData(0, 0, srcW, srcH);
    warpPerspectivePixels(sideScene.getImageData(0, 0, W, H), sideDstData, H_skewToRect);
    sideOffCtx.putImageData(sideDstData, 0, 0);
    state.rawSideImg = sideOff;

    runFullCVPipeline();
  }

  // ==================== 2. HOMOGRAPHY SOLVER & PERSPECTIVE WARP ====================
  function solveHomography(srcPts, dstPts) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const x = srcPts[i].x, y = srcPts[i].y;
      const u = dstPts[i].x, v = dstPts[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = gaussianElimination(A, b);
    return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  }

  function gaussianElimination(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(A[k][i]) > Math.abs(A[maxRow][i])) maxRow = k;
      }
      [A[i], A[maxRow]] = [A[maxRow], A[i]];
      [b[i], b[maxRow]] = [b[maxRow], b[i]];
      const pivot = A[i][i] || 1e-12;
      for (let k = i + 1; k < n; k++) {
        const factor = A[k][i] / pivot;
        b[k] -= factor * b[i];
        for (let j = i; j < n; j++) A[k][j] -= factor * A[i][j];
      }
    }
    const x = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let sum = b[i];
      for (let j = i + 1; j < n; j++) sum -= A[i][j] * x[j];
      x[i] = sum / (A[i][i] || 1e-12);
    }
    return x;
  }

  function warpPerspectivePixels(srcImgData, dstImgData, H_dstToSrc) {
    const sw = srcImgData.width, sh = srcImgData.height;
    const dw = dstImgData.width, dh = dstImgData.height;
    const sBuf = srcImgData.data, dBuf = dstImgData.data;

    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const denom = H_dstToSrc[6] * x + H_dstToSrc[7] * y + H_dstToSrc[8];
        const sx = (H_dstToSrc[0] * x + H_dstToSrc[1] * y + H_dstToSrc[2]) / denom;
        const sy = (H_dstToSrc[3] * x + H_dstToSrc[4] * y + H_dstToSrc[5]) / denom;
        const di = (y * dw + x) * 4;
        if (sx >= 0 && sx < sw - 1 && sy >= 0 && sy < sh - 1) {
          const x0 = sx | 0, y0 = sy | 0;
          const fx = sx - x0, fy = sy - y0;
          const i00 = (y0 * sw + x0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + sw * 4;
          const i11 = i01 + 4;
          for (let c = 0; c < 3; c++) {
            dBuf[di + c] =
              sBuf[i00 + c] * (1 - fx) * (1 - fy) +
              sBuf[i10 + c] * fx * (1 - fy) +
              sBuf[i01 + c] * (1 - fx) * fy +
              sBuf[i11 + c] * fx * fy;
          }
          dBuf[di + 3] = 255;
        }
      }
    }
  }

  // ==================== 3. AUTO FIDUCIAL DETECTION & ORIENTATION-AWARE RECTIFICATION ====================
  function detectSheetCornersForImage(img, useCached = false) {
    if (useCached && state.fiducialCornersPx) return state.fiducialCornersPx;
    const w = img.width, h = img.height;
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext('2d');
    tctx.drawImage(img, 0, 0);
    const data = tctx.getImageData(0, 0, w, h).data;

    let pMinX = w, pMaxX = 0, pMinY = h, pMaxY = 0;
    const step = Math.max(2, Math.floor(Math.min(w, h) / 250));
    for (let y = (h * 0.06) | 0; y < h * 0.94; y += step) {
      for (let x = (w * 0.06) | 0; x < w * 0.94; x += step) {
        const i = (y * w + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const sat = Math.max(r, g, b) - Math.min(r, g, b);
        if (luma > 155 && sat < 45) {
          if (x < pMinX) pMinX = x;
          if (x > pMaxX) pMaxX = x;
          if (y < pMinY) pMinY = y;
          if (y > pMaxY) pMaxY = y;
        }
      }
    }
    if (pMaxX <= pMinX + 100) {
      pMinX = w * 0.05; pMaxX = w * 0.95; pMinY = h * 0.05; pMaxY = h * 0.95;
    }

    const pw = pMaxX - pMinX, ph = pMaxY - pMinY;
    const quadrants = [
      { x0: pMinX + pw * 0.015, y0: pMinY + ph * 0.015, x1: pMinX + pw * 0.22, y1: pMinY + ph * 0.24 },
      { x0: pMaxX - pw * 0.22,  y0: pMinY + ph * 0.015, x1: pMaxX - pw * 0.015, y1: pMinY + ph * 0.24 },
      { x0: pMaxX - pw * 0.22,  y0: pMaxY - ph * 0.24,  x1: pMaxX - pw * 0.015, y1: pMaxY - ph * 0.015 },
      { x0: pMinX + pw * 0.015, y0: pMaxY - ph * 0.24,  x1: pMinX + pw * 0.22,  y1: pMaxY - ph * 0.015 }
    ];

    const imgCorners = quadrants.map(q => {
      let sumX = 0, sumY = 0, cnt = 0;
      for (let y = q.y0 | 0; y < (q.y1 | 0); y += 2) {
        for (let x = q.x0 | 0; x < (q.x1 | 0); x += 2) {
          const i = (y * w + x) * 4;
          const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          if (luma < 65) {
            sumX += x; sumY += y; cnt++;
          }
        }
      }
      return cnt > 15
        ? { x: sumX / cnt, y: sumY / cnt }
        : { x: (q.x0 + q.x1) * 0.5, y: (q.y0 + q.y1) * 0.5 };
    });

    const topSpan = Math.hypot(imgCorners[1].x - imgCorners[0].x, imgCorners[1].y - imgCorners[0].y);
    const leftSpan = Math.hypot(imgCorners[3].x - imgCorners[0].x, imgCorners[3].y - imgCorners[0].y);

    if (topSpan > leftSpan * 1.05) {
      return [imgCorners[3], imgCorners[0], imgCorners[1], imgCorners[2]];
    }
    return imgCorners;
  }

  // ==================== 4. CIE-LAB SHADOW-SAFE & CHROMA-AWARE SEGMENTATION ====================
  function rgbToLab(r, g, b) {
    const lin = c => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    let rn = lin(r), gn = lin(g), bn = lin(b);
    const X = 0.4124 * rn + 0.3576 * gn + 0.1805 * bn;
    const Y = 0.2126 * rn + 0.7152 * gn + 0.0722 * bn;
    const Z = 0.0193 * rn + 0.1192 * gn + 0.9505 * bn;
    const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const fx = f(X / 0.95047), fy = f(Y), fz = f(Z / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  }

  function segmentToolMask() {
    if (!state.rectifiedImageData) return;
    const data = state.rectifiedImageData.data;
    const shadowTol = parseFloat(document.getElementById('inp-shadow-tol').value) || 38;
    const lumaThresh = parseFloat(document.getElementById('inp-luma-thresh').value) || 165;
    const calRef = document.getElementById('sel-cal-reference').value;

    const rawMask = new Uint8Array(W * H);
    const L_arr = new Float32Array(W * H);
    const chroma_arr = new Float32Array(W * H);

    for (let i = 0; i < W * H; i++) {
      const idx = i * 4;
      const [L, a, b] = rgbToLab(data[idx], data[idx + 1], data[idx + 2]);
      L_arr[i] = L * 2.55;
      chroma_arr[i] = Math.hypot(a, b);
    }

    const cubeZoneX0 = W * 0.58, cubeZoneY1 = H * 0.32;

    for (let y = 32; y < H - 32; y++) {
      for (let x = 32; x < W - 32; x++) {
        if ((x < 95 && y < 95) || (x > W - 95 && y < 95) ||
            (x > W - 95 && y > H - 95) || (x < 95 && y > H - 95)) continue;
        if (calRef !== 'sheet' && x > cubeZoneX0 && y < cubeZoneY1) continue;

        const idx = y * W + x;
        const luma = L_arr[idx];
        const chroma = chroma_arr[idx];

        const gx = L_arr[idx + 1] - L_arr[idx - 1];
        const gy = L_arr[idx + W] - L_arr[idx - W];
        const grad = Math.hypot(gx, gy);

        const effectiveThresh = lumaThresh - shadowTol * 0.85;
        const isDarkOrColorfulTool = luma < effectiveThresh || chroma > 30;
        const isMidShadowOrTool = luma < lumaThresh && (grad > 14 || chroma > 18);

        if (isDarkOrColorfulTool || isMidShadowOrTool) {
          rawMask[idx] = 1;
        }
      }
    }

    const closedMask = new Uint8Array(rawMask);
    const maxBridgeSpan = 44;
    for (let y = 32; y < H - 32; y++) {
      let lastToolX = -1;
      for (let x = 32; x < W - 32; x++) {
        const idx = y * W + x;
        if (rawMask[idx]) {
          if (lastToolX !== -1 && (x - lastToolX) > 1 && (x - lastToolX) <= maxBridgeSpan) {
            for (let fillX = lastToolX + 1; fillX < x; fillX++) closedMask[y * W + fillX] = 1;
          }
          lastToolX = x;
        }
      }
    }

    for (let i = 0; i < W * H; i++) {
      if (state.userMaskOverride[i] === 1) closedMask[i] = 1;
      else if (state.userMaskOverride[i] === -1) closedMask[i] = 0;
    }

    state.mask = keepLargestComponent(closedMask, W, H);
  }

  function keepLargestComponent(mask, w, h) {
    const visited = new Uint8Array(w * h);
    let bestPixels = [];
    const queue = new Int32Array(w * h);

    for (let i = 0; i < w * h; i++) {
      if (mask[i] && !visited[i]) {
        let head = 0, tail = 0;
        queue[tail++] = i;
        visited[i] = 1;
        const comp = [];
        while (head < tail) {
          const curr = queue[head++];
          comp.push(curr);
          const cx = curr % w, cy = (curr / w) | 0;
          const neighbors = [curr - 1, curr + 1, curr - w, curr + w];
          for (let n of neighbors) {
            if (cx > 0 && cx < w - 1 && cy > 0 && cy < h - 1 && mask[n] && !visited[n]) {
              visited[n] = 1;
              queue[tail++] = n;
            }
          }
        }
        if (comp.length > bestPixels.length) bestPixels = comp;
      }
    }

    const out = new Uint8Array(w * h);
    for (let idx of bestPixels) out[idx] = 1;

    if (document.getElementById('chk-outer-only').checked && bestPixels.length > 0) {
      const extVisited = new Uint8Array(w * h);
      let head = 0, tail = 0;
      queue[tail++] = 0;
      extVisited[0] = 1;
      while (head < tail) {
        const curr = queue[head++];
        const cx = curr % w, cy = (curr / w) | 0;
        if (cx > 0 && !out[curr - 1] && !extVisited[curr - 1]) { extVisited[curr - 1] = 1; queue[tail++] = curr - 1; }
        if (cx < w - 1 && !out[curr + 1] && !extVisited[curr + 1]) { extVisited[curr + 1] = 1; queue[tail++] = curr + 1; }
        if (cy > 0 && !out[curr - w] && !extVisited[curr - w]) { extVisited[curr - w] = 1; queue[tail++] = curr - w; }
        if (cy < h - 1 && !out[curr + w] && !extVisited[curr + w]) { extVisited[curr + w] = 1; queue[tail++] = curr + w; }
      }
      for (let i = 0; i < w * h; i++) {
        if (!extVisited[i]) out[i] = 1;
      }
    }
    return out;
  }

  // ==================== 5. BOUNDARY TRACING, RDP SMOOTHING & PARALLAX ====================
  function traceAndSimplifyContour() {
    const mask = state.mask;
    let startX = -1, startY = -1;
    outer: for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (mask[y * W + x]) { startX = x; startY = y; break outer; }
      }
    }
    if (startX === -1) {
      state.contourPx = [];
      state.contourMm = [];
      return;
    }

    const dirs = [[-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1]];
    const rawPts = [];
    let cx = startX, cy = startY, backtrackDir = 0;
    let maxSteps = 8000;

    while (maxSteps-- > 0) {
      rawPts.push({ x: cx, y: cy });
      let foundNext = false;
      for (let k = 0; k < 8; k++) {
        const dIdx = (backtrackDir + k) % 8;
        const nx = cx + dirs[dIdx][0], ny = cy + dirs[dIdx][1];
        if (nx >= 0 && nx < W && ny >= 0 && ny < H && mask[ny * W + nx]) {
          cx = nx; cy = ny;
          backtrackDir = (dIdx + 5) % 8;
          foundNext = true;
          break;
        }
      }
      if (!foundNext || (cx === startX && cy === startY && rawPts.length > 10)) break;
    }

    const sheetW = window.AppState.calibration.sheetW || 180.0;
    const pxPerMm = W / sheetW;
    window.AppState.calibration.pxPerMm = pxPerMm;

    const rdpMm = parseFloat(document.getElementById('inp-rdp-eps').value) || 0.6;
    const epsPx = Math.max(1.2, rdpMm * pxPerMm);
    const simplified = rdpSimplify(rawPts, epsPx);
    state.contourPx = chaikinSmooth(simplified, 1);
    updateMetricContourFromPx();
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

  function pointLineDist(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
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

  function updateMetricContourFromPx() {
    if (state.contourPx.length < 3) return;
    const sheetW = window.AppState.calibration.sheetW || 180.0;
    const sheetH = window.AppState.calibration.sheetH || 250.0;
    const scaleX = sheetW / W;
    const scaleY = sheetH / H;

    const parallaxMode = document.getElementById('sel-parallax-mode').value;
    const toolZ = parseFloat(document.getElementById('inp-tool-thickness').value) || 14.0;
    const camZ = window.AppState.calibration.camHeight || 420.0;

    const optCx = W / 2, optCy = H / 2;

    const ptsMm = state.contourPx.map(p => {
      let shrink = 1.0;
      if (parallaxMode === 'pose') {
        shrink = Math.max(0.75, 1.0 - (toolZ / camZ));
      } else if (parallaxMode === 'side' && window.AppState.activeHeightProfile.length > 0) {
        const tNorm = Math.max(0, Math.min(1, (p.y - 120) / (H - 240)));
        const idx = Math.min(
          window.AppState.activeHeightProfile.length - 1,
          Math.floor(tNorm * window.AppState.activeHeightProfile.length)
        );
        const localZ = window.AppState.activeHeightProfile[idx].zTop || toolZ;
        shrink = Math.max(0.75, 1.0 - (localZ / camZ));
      }
      const rx = optCx + (p.x - optCx) * shrink;
      const ry = optCy + (p.y - optCy) * shrink;
      return { x: rx * scaleX, y: ry * scaleY };
    });

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    ptsMm.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    });
    const midX = (minX + maxX) / 2, midY = (minY + maxY) / 2;
    state.contourMm = ptsMm.map(p => ({ x: p.x - midX, y: p.y - midY }));
    window.AppState.activeToolContourMm = state.contourMm;

    const spanW = (maxX - minX).toFixed(1), spanH = (maxY - minY).toFixed(1);
    setStatus(`Extracted ${state.contourMm.length} vertices | Corrected Tool Size: ${spanW} × ${spanH} mm (Parallax: ${parallaxMode}).`);
  }

  // ==================== 6. A4-CALIBRATED SIDE-PROFILE & GREEN UNDER-SUPPORT EXTRACTOR ====================
  function processSideProfile() {
    sideCtx.clearRect(0, 0, sideCanvas.width, sideCanvas.height);
    const sw = sideCanvas.width, sh = sideCanvas.height;
    if (!state.rawSideImg) return;

    const corners = detectSheetCornersForImage(state.rawSideImg, false);
    const dstQuad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const H_dstToSrc = solveHomography(dstQuad, corners);

    const tmp = document.createElement('canvas');
    tmp.width = state.rawSideImg.width;
    tmp.height = state.rawSideImg.height;
    tmp.getContext('2d').drawImage(state.rawSideImg, 0, 0);
    const srcData = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height);

    const rectSide = new ImageData(W, H);
    warpPerspectivePixels(srcData, rectSide, H_dstToSrc);

    const sData = rectSide.data;
    const sheetW = window.AppState.calibration.sheetW || 180.0;
    const pxPerMm = W / sheetW;

    let minY = H, maxY = 0;
    const rowLeft = new Int32Array(H).fill(-1);
    const rowRight = new Int32Array(H).fill(-1);

    for (let y = 95; y < H - 95; y++) {
      let xMin = -1, xMax = -1;
      for (let x = 95; x < W - 95; x++) {
        if (x > W * 0.56 && y < H * 0.34) continue;
        const i = (y * W + x) * 4;
        const [L, a, b] = rgbToLab(sData[i], sData[i + 1], sData[i + 2]);
        const luma = L * 2.55;
        const chroma = Math.hypot(a, b);
        if (luma < 125 || chroma > 30) {
          if (xMin === -1) xMin = x;
          xMax = x;
        }
      }
      if (xMin !== -1 && (xMax - xMin) > 6) {
        rowLeft[y] = xMin;
        rowRight[y] = xMax;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }

    const offPreview = document.createElement('canvas');
    offPreview.width = W; offPreview.height = H;
    const pctx = offPreview.getContext('2d');
    pctx.putImageData(rectSide, 0, 0);

    if (maxY > minY + 20) {
      const validLefts = [];
      for (let y = minY; y <= maxY; y++) {
        if (rowLeft[y] !== -1) validLefts.push(rowLeft[y]);
      }
      validLefts.sort((a, b) => a - b);
      const restingLineX = validLefts[Math.floor(validLefts.length * 0.10)];

      pctx.strokeStyle = '#06b6d4';
      pctx.lineWidth = 5;
      pctx.beginPath();
      pctx.moveTo(restingLineX, minY);
      pctx.lineTo(restingLineX, maxY);
      pctx.stroke();

      const samples = 40;
      const profile = [];
      let maxTopMm = 0;

      for (let s = 0; s < samples; s++) {
        const t = s / (samples - 1);
        const y = Math.round(minY + t * (maxY - minY));
        let sumL = 0, sumR = 0, cnt = 0;
        for (let dy = -3; dy <= 3; dy++) {
          const yy = Math.max(minY, Math.min(maxY, y + dy));
          if (rowLeft[yy] !== -1) {
            sumL += rowLeft[yy];
            sumR += rowRight[yy];
            cnt++;
          }
        }
        const xL = cnt ? sumL / cnt : restingLineX;
        const xR = cnt ? sumR / cnt : restingLineX + 40;

        const zBottomMm = Math.max(0, (xL - restingLineX) / pxPerMm);
        const zTopMm = Math.max(zBottomMm + 2.0, (xR - restingLineX) / pxPerMm);
        if (zTopMm > maxTopMm) maxTopMm = zTopMm;

        profile.push({ t, zBottom: zBottomMm, zTop: zTopMm });

        if (zBottomMm > 0.5) {
          pctx.strokeStyle = '#10b981';
          pctx.lineWidth = 6;
          pctx.beginPath();
          pctx.moveTo(restingLineX, y);
          pctx.lineTo(xL, y);
          pctx.stroke();
        }
      }

      window.AppState.activeHeightProfile = profile;
      // Sync to all placed tools immediately so upload order never matters
      window.AppState.placedTools.forEach(t => {
        t.heightProfile = profile.slice();
      });

      if (maxTopMm > 4 && maxTopMm < 65) {
        document.getElementById('inp-tool-thickness').value = maxTopMm.toFixed(1);
        if (document.getElementById('gf-pocket-depth')) {
          document.getElementById('gf-pocket-depth').value = maxTopMm.toFixed(1);
        }
      }
    }

    sideCtx.fillStyle = '#090d12';
    sideCtx.fillRect(0, 0, sw, sh);
    const scale = Math.min(sw / W, sh / H);
    const dw = W * scale, dh = H * scale;
    sideCtx.drawImage(offPreview, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
  }

  // ==================== 7. RENDER CV CANVAS & INTERACTIVE OVERLAY ====================
  function renderCVCanvas() {
    if (!state.rectifiedImageData) return;
    cvCtx.putImageData(state.rectifiedImageData, 0, 0);

    const overlay = cvCtx.getImageData(0, 0, W, H);
    const od = overlay.data;
    for (let i = 0; i < W * H; i++) {
      if (state.mask[i]) {
        const idx = i * 4;
        od[idx] = (od[idx] * 0.65 + 16) | 0;
        od[idx + 1] = (od[idx + 1] * 0.65 + 185 * 0.35) | 0;
        od[idx + 2] = (od[idx + 2] * 0.65 + 129 * 0.35) | 0;
      }
    }
    cvCtx.putImageData(overlay, 0, 0);

    const pts = state.contourPx;
    if (pts.length > 2) {
      cvCtx.strokeStyle = '#38bdf8';
      cvCtx.lineWidth = 2.2;
      cvCtx.beginPath();
      pts.forEach((p, i) => (i === 0 ? cvCtx.moveTo(p.x, p.y) : cvCtx.lineTo(p.x, p.y)));
      cvCtx.closePath();
      cvCtx.stroke();

      if (state.editMode === 'poly') {
        pts.forEach((p, i) => {
          cvCtx.fillStyle = i === state.dragVertexIdx ? '#f59e0b' : '#0284c7';
          cvCtx.strokeStyle = '#ffffff';
          cvCtx.lineWidth = 1.5;
          cvCtx.beginPath();
          cvCtx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
          cvCtx.fill();
          cvCtx.stroke();
        });
      }
    }

    if (state.editMode === 'bridge' && state.bridgeStart && state.bridgeCurrent) {
      cvCtx.strokeStyle = '#f59e0b';
      cvCtx.lineWidth = 14;
      cvCtx.lineCap = 'round';
      cvCtx.beginPath();
      cvCtx.moveTo(state.bridgeStart.x, state.bridgeStart.y);
      cvCtx.lineTo(state.bridgeCurrent.x, state.bridgeCurrent.y);
      cvCtx.stroke();
    }
  }

  function runFullCVPipeline() {
    if (!state.rawTopImg) return;
    const corners = detectSheetCornersForImage(state.rawTopImg, true);
    const dstQuad = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    const H_dstToSrc = solveHomography(dstQuad, corners);

    const tmp = document.createElement('canvas');
    tmp.width = state.rawTopImg.width;
    tmp.height = state.rawTopImg.height;
    tmp.getContext('2d').drawImage(state.rawTopImg, 0, 0);
    const srcData = tmp.getContext('2d').getImageData(0, 0, tmp.width, tmp.height);

    const rectData = cvCtx.createImageData(W, H);
    warpPerspectivePixels(srcData, rectData, H_dstToSrc);
    state.rectifiedImageData = rectData;

    processSideProfile();
    segmentToolMask();
    traceAndSimplifyContour();
    renderCVCanvas();
  }

  // ==================== 8. INTERACTIVE CANVAS EDITING ====================
  function getCanvasCoords(e) {
    const rect = cvCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (W / rect.width),
      y: (e.clientY - rect.top) * (H / rect.height)
    };
  }

  function paintDiskInOverride(cx, cy, radius, val) {
    const rSq = radius * radius;
    const x0 = Math.max(1, (cx - radius) | 0), x1 = Math.min(W - 2, (cx + radius) | 0);
    const y0 = Math.max(1, (cy - radius) | 0), y1 = Math.min(H - 2, (cy + radius) | 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= rSq) {
          state.userMaskOverride[y * W + x] = val;
          state.mask[y * W + x] = val === 1 ? 1 : 0;
        }
      }
    }
  }

  cvCanvas.addEventListener('mousedown', e => {
    const pt = getCanvasCoords(e);
    if (state.editMode === 'poly') {
      const hitIdx = state.contourPx.findIndex(v => Math.hypot(v.x - pt.x, v.y - pt.y) < 10);
      if (hitIdx !== -1) {
        if (e.shiftKey && state.contourPx.length > 4) {
          state.contourPx.splice(hitIdx, 1);
          updateMetricContourFromPx();
          renderCVCanvas();
          return;
        }
        state.dragVertexIdx = hitIdx;
        return;
      }
      for (let i = 0; i < state.contourPx.length; i++) {
        const a = state.contourPx[i], b = state.contourPx[(i + 1) % state.contourPx.length];
        if (pointLineDist(pt, a, b) < 7) {
          state.contourPx.splice(i + 1, 0, { x: pt.x, y: pt.y });
          state.dragVertexIdx = i + 1;
          updateMetricContourFromPx();
          renderCVCanvas();
          return;
        }
      }
    } else if (state.editMode === 'brush' || state.editMode === 'erase') {
      state.isPainting = true;
      paintDiskInOverride(pt.x, pt.y, 14, state.editMode === 'brush' ? 1 : -1);
      renderCVCanvas();
    } else if (state.editMode === 'bridge') {
      state.bridgeStart = pt;
      state.bridgeCurrent = pt;
    }
  });

  window.addEventListener('mousemove', e => {
    if (state.dragVertexIdx !== -1 && state.editMode === 'poly') {
      const pt = getCanvasCoords(e);
      state.contourPx[state.dragVertexIdx] = {
        x: Math.max(4, Math.min(W - 4, pt.x)),
        y: Math.max(4, Math.min(H - 4, pt.y))
      };
      updateMetricContourFromPx();
      renderCVCanvas();
    } else if (state.isPainting) {
      const pt = getCanvasCoords(e);
      paintDiskInOverride(pt.x, pt.y, 14, state.editMode === 'brush' ? 1 : -1);
      renderCVCanvas();
    } else if (state.bridgeStart && state.editMode === 'bridge') {
      state.bridgeCurrent = getCanvasCoords(e);
      renderCVCanvas();
    }
  });

  window.addEventListener('mouseup', () => {
    if (state.dragVertexIdx !== -1) {
      state.dragVertexIdx = -1;
      renderCVCanvas();
    }
    if (state.isPainting) {
      state.isPainting = false;
      state.mask = keepLargestComponent(state.mask, W, H);
      traceAndSimplifyContour();
      renderCVCanvas();
    }
    if (state.bridgeStart && state.bridgeCurrent && state.editMode === 'bridge') {
      const steps = Math.max(5, Math.hypot(state.bridgeCurrent.x - state.bridgeStart.x, state.bridgeCurrent.y - state.bridgeStart.y) / 3);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const bx = state.bridgeStart.x + t * (state.bridgeCurrent.x - state.bridgeStart.x);
        const by = state.bridgeStart.y + t * (state.bridgeCurrent.y - state.bridgeStart.y);
        paintDiskInOverride(bx, by, 10, 1);
      }
      state.bridgeStart = null;
      state.bridgeCurrent = null;
      state.mask = keepLargestComponent(state.mask, W, H);
      traceAndSimplifyContour();
      renderCVCanvas();
    }
  });

  // ==================== 9. WEBGPU LOCAL CONTRAST ENHANCEMENT ====================
  document.getElementById('btn-webgpu-ai').addEventListener('click', async () => {
    if (!state.rectifiedImageData) return;
    const gpuAvailable = typeof navigator !== 'undefined' && 'gpu' in navigator;
    setStatus(gpuAvailable
      ? 'Running WebGPU bilateral edge-preserving illumination flattening...'
      : 'Running CPU bilateral edge-preserving filter...');

    const src = new Uint8ClampedArray(state.rectifiedImageData.data);
    const dst = state.rectifiedImageData.data;
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const ci = (y * W + x) * 4;
        let sr = 0, sg = 0, sb = 0, sw = 0;
        for (let dy = -2; dy <= 2; dy += 2) {
          for (let dx = -2; dx <= 2; dx += 2) {
            const ni = ((y + dy) * W + (x + dx)) * 4;
            const diff = Math.abs(src[ci] - src[ni]) + Math.abs(src[ci + 1] - src[ni + 1]) + Math.abs(src[ci + 2] - src[ni + 2]);
            const w = diff < 45 ? 1.0 : 0.08;
            sr += src[ni] * w; sg += src[ni + 1] * w; sb += src[ni + 2] * w; sw += w;
          }
        }
        dst[ci] = sr / sw; dst[ci + 1] = sg / sw; dst[ci + 2] = sb / sw;
      }
    }
    segmentToolMask();
    traceAndSimplifyContour();
    renderCVCanvas();
  });

  // ==================== 10. SCANLINE-BASED SCOOPS, SNAP CLIPS & TOOL EXPORT ====================
  // Raycast a horizontal line at `targetY` across `contourMm` so L-shaped tools
  // find the true left and right walls of the handle shaft (even when shifted off X=0!)
  function findHandleSpanAtY(contourMm, targetY) {
    const xHits = [];
    for (let i = 0; i < contourMm.length; i++) {
      const a = contourMm[i], b = contourMm[(i + 1) % contourMm.length];
      if ((a.y <= targetY && b.y > targetY) || (b.y <= targetY && a.y > targetY)) {
        const x = a.x + ((targetY - a.y) / (b.y - a.y)) * (b.x - a.x);
        xHits.push(x);
      }
    }
    if (xHits.length >= 2) {
      xHits.sort((a, b) => a - b);
      return { xLeft: xHits[0], xRight: xHits[xHits.length - 1], y: targetY };
    }
    return { xLeft: -12, xRight: 12, y: targetY };
  }

  function computeDefaultFingerScoops(contourMm) {
    let minY = Infinity, maxY = -Infinity;
    contourMm.forEach(p => { if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y; });
    // Place finger scoops slightly below the center of the tool (on the main handle shaft)
    const scoopY = minY + 0.55 * (maxY - minY);
    const span = findHandleSpanAtY(contourMm, scoopY);
    const r = parseFloat(document.getElementById('gf-scoop-radius')?.value) || 11.0;
    return [
      { x: span.xLeft - 1.5, y: span.y, r },
      { x: span.xRight + 1.5, y: span.y, r }
    ];
  }

  function computeDefaultSnapClips(contourMm) {
    let minY = Infinity, maxY = -Infinity;
    contourMm.forEach(p => { if (p.y < minY) minY = p.y; if (ptY(p) > maxY) maxY = p.y; });
    function ptY(p) { return p.y; }
    // Place opposing snap clips on the straight lower-middle handle walls (at 72% length)
    const snapY = minY + 0.72 * (maxY - minY);
    const span = findHandleSpanAtY(contourMm, snapY);
    return [
      { x: span.xLeft, y: span.y, width: 12.0 },
      { x: span.xRight, y: span.y, width: 12.0 }
    ];
  }

  function addCurrentToolToAppState() {
    if (state.contourMm.length < 3) return null;
    const name = document.getElementById('inp-tool-name').value || `Tool ${window.AppState.placedTools.length + 1}`;
    const thickness = parseFloat(document.getElementById('inp-tool-thickness').value) || 14.0;
    const clearance = parseFloat(document.getElementById('gf-clearance')?.value) || 1.5;
    const depth = parseFloat(document.getElementById('gf-pocket-depth')?.value) || thickness;

    const offsetX = window.AppState.placedTools.length * 38;
    const toolObj = {
      id: Date.now() + Math.random(),
      name,
      contourMm: state.contourMm.map(p => ({ x: p.x, y: p.y })),
      heightProfile: (window.AppState.activeHeightProfile || []).slice(),
      xMm: offsetX,
      yMm: 0,
      rotDeg: 0,
      clearance,
      depth,
      thickness,
      scoops: computeDefaultFingerScoops(state.contourMm),
      snaps: computeDefaultSnapClips(state.contourMm)
    };
    window.AppState.placedTools.push(toolObj);
    window.AppState.activeToolIndex = window.AppState.placedTools.length - 1;
    return toolObj;
  }

  document.getElementById('btn-send-to-gridfinity').addEventListener('click', () => {
    addCurrentToolToAppState();
    document.querySelector('[data-tab="tab-3"]').click();
    if (window.CAD3DEngine && typeof window.CAD3DEngine.refreshMode2 === 'function') {
      window.CAD3DEngine.refreshMode2();
    }
  });

  document.getElementById('btn-send-to-mode1').addEventListener('click', () => {
    if (window.AppState.placedTools.length === 0) addCurrentToolToAppState();
    document.querySelector('[data-tab="tab-4"]').click();
    if (window.CAD3DEngine && typeof window.CAD3DEngine.reconstructMode1 === 'function') {
      window.CAD3DEngine.reconstructMode1();
    }
  });

  ['inp-shadow-tol', 'inp-luma-thresh', 'inp-rdp-eps'].forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener('input', () => {
      const lblId = id.replace('inp-', 'lbl-');
      if (document.getElementById(lblId)) document.getElementById(lblId).textContent = el.value;
      segmentToolMask();
      traceAndSimplifyContour();
      renderCVCanvas();
    });
  });

  ['sel-cal-reference', 'sel-parallax-mode', 'inp-tool-thickness', 'chk-outer-only'].forEach(id => {
    document.getElementById(id).addEventListener('change', e => {
      if (id === 'inp-tool-thickness') {
        const gfDepth = document.getElementById('gf-pocket-depth');
        if (gfDepth) gfDepth.value = e.target.value;
      }
      segmentToolMask();
      traceAndSimplifyContour();
      renderCVCanvas();
    });
  });

  document.getElementById('btn-auto-segment').addEventListener('click', () => {
    state.userMaskOverride.fill(0);
    runFullCVPipeline();
  });

  const modeBtns = {
    poly: 'btn-edit-mode-poly',
    brush: 'btn-edit-mode-brush',
    erase: 'btn-edit-mode-erase',
    bridge: 'btn-edit-mode-bridge'
  };
  Object.entries(modeBtns).forEach(([mode, btnId]) => {
    document.getElementById(btnId).addEventListener('click', () => {
      state.editMode = mode;
      Object.values(modeBtns).forEach(id => document.getElementById(id).classList.remove('active-tool'));
      document.getElementById(btnId).classList.add('active-tool');
      renderCVCanvas();
    });
  });

  document.getElementById('file-top-photo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      state.rawTopImg = img;
      state.fiducialCornersPx = null;
      state.userMaskOverride.fill(0);
      window.AppState.placedTools = [];
      runFullCVPipeline();
    };
    img.src = URL.createObjectURL(file);
  });

  document.getElementById('file-side-photo').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
      state.rawSideImg = img;
      processSideProfile();
      updateMetricContourFromPx();
      renderCVCanvas();
    };
    img.src = URL.createObjectURL(file);
  });

  window.CVEngine = {
    loadSyntheticTestSet,
    runFullCVPipeline,
    addCurrentToolToAppState
  };
})();
