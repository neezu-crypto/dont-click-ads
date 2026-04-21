// Level 2: DFS Maze — Ball Drag
const Level2Module = (() => {
  'use strict';

  // ── 캔버스 고정 해상도 (논리 px) ──
  const CANVAS_W     = 860;
  const CANVAS_H     = 500;
  const MAZE_PAD     = 30;
  const MAZE_INNER_W = CANVAS_W - MAZE_PAD * 2; // 800
  const MAZE_INNER_H = CANVAS_H - MAZE_PAD * 2; // 440
  const WALL_T       = 3;   // 벽 두께 (셀 경계 양쪽에 각 WALL_T px)
  const BALL_R       = 12;  // 공 반지름 (고정)

  // 레벨별 난이도: 셀 크기가 작을수록 더 많은 셀 → 복잡한 미로
  const TIERS = [
    { minLv: 1,  maxLv: 3,  cell: 40, timer: 70 },
    { minLv: 4,  maxLv: 6,  cell: 36, timer: 60 },
    { minLv: 7,  maxLv: 10, cell: 32, timer: 55 },
  ];

  function _tier() {
    const lv = (typeof currentLevel !== 'undefined') ? currentLevel : 2;
    return TIERS.find(t => lv >= t.minLv && lv <= t.maxLv) || TIERS[0];
  }

  // 색상
  const COL_BG    = '#07090f';
  const COL_FLOOR = '#0d1428';
  const COL_EDGE  = '#15203a';

  // ── 모듈 상태 ──
  let _area, _canvas, _ballEl;
  let _onSuccess, _onFail;
  let _timerInterval = null;
  let _timeLeft = 60;
  let _keysDown = new Set(); // 현재 눌린 방향키
  let _rafId    = null;      // requestAnimationFrame ID
  let _ballPos  = { x: 0, y: 0 };
  let _ended    = false;

  // 게임마다 재생성
  let _grid  = null;   // _grid[r][c] = { vis, N, S, E, W }
  let _COLS  = 0, _ROWS = 0, _CELL = 40;
  let _MAZE_W = 0, _MAZE_H = 0;
  let _mask   = null;  // Uint8ClampedArray, 마스크 이미지 R채널
  let _sCell  = { c: 0, r: 0 };   // 출발 셀 (좌하단)
  let _fCell  = { c: 0, r: 0 };   // 도착 셀 (우상단)

  // ─── DFS 미로 생성 (반복 방식, 스택 안전) ───

  function _genMaze(cols, rows) {
    const g = [];
    for (let r = 0; r < rows; r++) {
      g.push([]);
      for (let c = 0; c < cols; c++)
        g[r].push({ vis: false, N: true, S: true, E: true, W: true });
    }

    const stack = [[0, rows - 1]];
    g[rows - 1][0].vis = true;

    while (stack.length) {
      const [c, r] = stack[stack.length - 1];
      const nbrs = [
        [c,   r-1, 'N', 'S'],
        [c,   r+1, 'S', 'N'],
        [c+1, r,   'E', 'W'],
        [c-1, r,   'W', 'E'],
      ].filter(([nc, nr]) =>
        nc >= 0 && nc < cols && nr >= 0 && nr < rows && !g[nr][nc].vis
      );

      if (nbrs.length) {
        const [nc, nr, w, ow] = nbrs[Math.floor(Math.random() * nbrs.length)];
        g[r][c][w]    = false;
        g[nr][nc][ow] = false;
        g[nr][nc].vis = true;
        stack.push([nc, nr]);
      } else {
        stack.pop();
      }
    }
    return g;
  }

  // ─── 픽셀 충돌 마스크 ───
  // 오프스크린 캔버스에 흰색(통로)/검은색(벽) 이진 이미지를 그립니다.
  // 좌표계: (0,0)~(_MAZE_W-1, _MAZE_H-1) — 캔버스 pos에서 MAZE_PAD를 빼서 변환.

  function _buildMask(g, cols, rows, cell, wt) {
    const W = cols * cell, H = rows * cell;
    const oc = document.createElement('canvas');
    oc.width = W; oc.height = H;
    const ctx = oc.getContext('2d');

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#fff';

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cl = g[r][c];
        const x0 = c * cell + wt,  y0 = r * cell + wt;
        const iW = cell - wt * 2,  iH = cell - wt * 2;

        ctx.fillRect(x0, y0, iW, iH);

        if (!cl.E && c < cols - 1)
          ctx.fillRect(c * cell + cell - wt, y0, wt * 2, iH);
        if (!cl.S && r < rows - 1)
          ctx.fillRect(x0, r * cell + cell - wt, iW, wt * 2);
      }
    }
    return ctx.getImageData(0, 0, W, H).data;
  }

  // 마스크 픽셀 조회 (흰색 = 통로)
  function _mFree(mx, my) {
    if (mx < 0 || my < 0 || mx >= _MAZE_W || my >= _MAZE_H) return false;
    return _mask[(my * _MAZE_W + mx) * 4] > 128;
  }

  // 공 반지름 8방향 + 중심 9점이 모두 통로인지 확인
  function _ballFits(cx, cy) {
    const mx = cx - MAZE_PAD, my = cy - MAZE_PAD;
    const r  = BALL_R + 1;
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      if (!_mFree(Math.round(mx + Math.cos(a) * r), Math.round(my + Math.sin(a) * r)))
        return false;
    }
    return _mFree(Math.round(mx), Math.round(my));
  }

  // 이동 시도 → 벽 슬라이딩 처리
  function _tryMove(fx, fy, tx, ty) {
    if (_ballFits(tx, ty)) return { x: tx, y: ty };
    if (_ballFits(tx, fy)) return { x: tx, y: fy };
    if (_ballFits(fx, ty)) return { x: fx, y: ty };
    return { x: fx, y: fy };
  }

  // ─── 미로 렌더링 ───

  function _renderMaze() {
    if (!_canvas || !_grid) return;
    const ctx = _canvas.getContext('2d');
    const cw  = _canvas.width, ch = _canvas.height;
    const sx  = cw / CANVAS_W,  sy = ch / CANVAS_H;

    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = COL_BG;
    ctx.fillRect(0, 0, cw, ch);

    // 미로 영역으로 이동
    ctx.save();
    ctx.translate(MAZE_PAD * sx, MAZE_PAD * sy);

    const cW = _CELL * sx, cH = _CELL * sy;
    const wW = WALL_T * sx, wH = WALL_T * sy;

    for (let r = 0; r < _ROWS; r++) {
      for (let c = 0; c < _COLS; c++) {
        const cl = _grid[r][c];
        const px = c * cW, py = r * cH;
        const iX = px + wW, iY = py + wH;
        const iW = cW - wW * 2, iH = cH - wH * 2;

        // 통로 바닥
        ctx.fillStyle = COL_FLOOR;
        ctx.fillRect(iX, iY, iW, iH);

        // 열린 동쪽 통로
        if (!cl.E && c < _COLS - 1)
          ctx.fillRect(px + cW - wW, iY, wW * 2, iH);

        // 열린 남쪽 통로
        if (!cl.S && r < _ROWS - 1)
          ctx.fillRect(iX, py + cH - wH, iW, wH * 2);

        // 닫힌 벽 엣지 하이라이트 (상·좌)
        ctx.strokeStyle = COL_EDGE;
        ctx.lineWidth   = 0.5;
        if (cl.N) { ctx.beginPath(); ctx.moveTo(iX, iY); ctx.lineTo(iX + iW, iY); ctx.stroke(); }
        if (cl.W) { ctx.beginPath(); ctx.moveTo(iX, iY); ctx.lineTo(iX, iY + iH); ctx.stroke(); }
      }
    }

    // 출발·도착 포털
    _drawPortal(ctx, _sCell.c, _sCell.r, cW, cH, wW, wH, '#00ffaa', 'S');
    _drawPortal(ctx, _fCell.c, _fCell.r, cW, cH, wW, wH, '#ff4444', 'G');

    ctx.restore();
  }

  function _drawPortal(ctx, c, r, cW, cH, wW, wH, color, letter) {
    const cx  = c * cW + cW / 2;
    const cy  = r * cH + cH / 2;
    const rad = Math.min(cW, cH) / 2 - Math.max(wW, wH) - 1;

    // 배경 색조
    ctx.fillStyle = color + '28';
    ctx.fillRect(c * cW + wW, r * cH + wH, cW - wW * 2, cH - wH * 2);

    // 원형 링
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.8;
    ctx.stroke();

    // 발광 후광
    ctx.beginPath();
    ctx.arc(cx, cy, rad + 3, 0, Math.PI * 2);
    ctx.strokeStyle = color + '44';
    ctx.lineWidth   = 2;
    ctx.stroke();

    // 라벨
    ctx.font         = `bold ${Math.round(rad * 0.85)}px monospace`;
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, cx, cy);
    ctx.restore();
  }

  // ─── 좌표 변환 ───

  function _scale() {
    if (!_area) return { x: 1, y: 1 };
    return { x: _area.offsetWidth / CANVAS_W, y: _area.offsetHeight / CANVAS_H };
  }

  function _toLogi(dx, dy) {
    const s = _scale();
    return { x: dx / s.x, y: dy / s.y };
  }

  function _placeBall() {
    if (!_ballEl || !_area) return;
    const s = _scale();
    const r = BALL_R * Math.min(s.x, s.y);
    _ballEl.style.width  = `${r * 2}px`;
    _ballEl.style.height = `${r * 2}px`;
    _ballEl.style.left   = `${_ballPos.x * s.x - r}px`;
    _ballEl.style.top    = `${_ballPos.y * s.y - r}px`;
  }

  // ─── 타이머 ───

  function _startTimer(dur) {
    _timeLeft = dur;
    _syncTimerEl();
    _timerInterval = setInterval(() => {
      _timeLeft--;
      _syncTimerEl();
      if (_timeLeft <= 0) {
        _stopTimer();
        if (!_ended) { _ended = true; _rmListeners(); if (_onFail) _onFail('timeout'); }
      }
    }, 1000);
  }

  function _stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  }

  function _syncTimerEl() {
    const el = document.getElementById('timer-display');
    if (!el) return;
    el.textContent      = _timeLeft;
    el.style.color      = _timeLeft <= 10 ? '#ff4444' : '';
    el.style.textShadow = _timeLeft <= 10 ? '0 0 8px #ff444488' : '';
  }

  // ─── 방향키 이벤트 & RAF 이동 루프 ───

  const MOVE_SPEED = 2.8; // 프레임당 이동 거리 (논리 px, 60fps ≈ 168px/s)

  function _onKeyDown(e) {
    if (_ended) return;
    if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    _keysDown.add(e.key);
    if (!_rafId) _rafId = requestAnimationFrame(_moveTick);
  }

  function _onKeyUp(e) {
    _keysDown.delete(e.key);
    // 모든 키가 떼어졌으면 공 멈춤 표시
    if (_keysDown.size === 0 && _ballEl) {
      _ballEl.style.boxShadow = '0 0 12px #00ffaa88, 0 0 24px #00ffaa44';
      _ballEl.style.transform = '';
    }
  }

  function _moveTick() {
    _rafId = null;
    if (_ended || _keysDown.size === 0) return;

    let dx = 0, dy = 0;
    if (_keysDown.has('ArrowRight')) dx += MOVE_SPEED;
    if (_keysDown.has('ArrowLeft'))  dx -= MOVE_SPEED;
    if (_keysDown.has('ArrowDown'))  dy += MOVE_SPEED;
    if (_keysDown.has('ArrowUp'))    dy -= MOVE_SPEED;

    // 대각선 이동 속도 정규화
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    const pos = _tryMove(_ballPos.x, _ballPos.y, _ballPos.x + dx, _ballPos.y + dy);
    _ballPos.x = pos.x; _ballPos.y = pos.y;
    _placeBall();

    // 이동 중 글로우 효과
    if (_ballEl) {
      _ballEl.style.boxShadow = '0 0 20px #00ffaacc, 0 0 40px #00ffaa55';
      _ballEl.style.transform = 'scale(1.08)';
    }

    // 도착 판정
    const gx = MAZE_PAD + (_fCell.c + 0.5) * _CELL;
    const gy = MAZE_PAD + (_fCell.r + 0.5) * _CELL;
    if (Math.hypot(_ballPos.x - gx, _ballPos.y - gy) < _CELL * 0.42) {
      _onGoal(); return;
    }

    _rafId = requestAnimationFrame(_moveTick);
  }

  function _onGoal() {
    if (_ended) return;
    _ended = true; _stopTimer();
    _keysDown.clear();
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }

    _ballPos = { x: MAZE_PAD + (_fCell.c + 0.5) * _CELL, y: MAZE_PAD + (_fCell.r + 0.5) * _CELL };
    _placeBall();

    if (_ballEl) {
      _ballEl.style.transition = 'all 0.35s cubic-bezier(0.34,1.56,0.64,1)';
      _ballEl.style.background = 'radial-gradient(circle at 35% 35%, #ffff88, #ffcc00)';
      _ballEl.style.boxShadow  = '0 0 40px #ffcc00cc, 0 0 80px #ffcc0044';
      _ballEl.style.transform  = 'scale(1.5)';
    }

    _rmListeners();
    setTimeout(() => { if (_onSuccess) _onSuccess(500); }, 400);
  }

  function _rmListeners() {
    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('keyup',   _onKeyUp);
  }

  function _cleanup() {
    _stopTimer();
    _ended = true;
    _keysDown.clear();
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    _rmListeners();
    if (_area) { _area.style.width = ''; _area.style.height = ''; }
  }

  // ─── Public API ───

  function start(area, onSuccess, onFail) {
    _area = area; _onSuccess = onSuccess; _onFail = onFail;
    _ended = false; _keysDown.clear();

    const t = _tier();
    _CELL   = t.cell;
    _COLS   = Math.floor(MAZE_INNER_W / _CELL);
    _ROWS   = Math.floor(MAZE_INNER_H / _CELL);
    _MAZE_W = _COLS * _CELL;
    _MAZE_H = _ROWS * _CELL;

    _sCell = { c: 0,         r: _ROWS - 1 }; // 좌하단 출발
    _fCell = { c: _COLS - 1, r: 0 };          // 우상단 도착

    _grid = _genMaze(_COLS, _ROWS);
    _mask = _buildMask(_grid, _COLS, _ROWS, _CELL, WALL_T);

    _ballPos = {
      x: MAZE_PAD + (_sCell.c + 0.5) * _CELL,
      y: MAZE_PAD + (_sCell.r + 0.5) * _CELL,
    };

    // 게임 영역 확장
    area.style.width  = `min(${CANVAS_W}px, 96vw)`;
    area.style.height = `${CANVAS_H}px`;
    area.innerHTML    = '';

    // 캔버스 (고정 해상도, CSS가 스케일 처리)
    _canvas = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:14px;';
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;
    area.appendChild(_canvas);

    // 공 엘리먼트
    _ballEl = document.createElement('div');
    _ballEl.style.cssText = `
      position:absolute; border-radius:50%;
      user-select:none; -webkit-user-select:none;
      background:radial-gradient(circle at 35% 35%, #00ffdd, #00cc77);
      box-shadow:0 0 12px #00ffaa88, 0 0 24px #00ffaa44;
      z-index:10; transition:box-shadow 0.12s, transform 0.12s;
    `;
    area.appendChild(_ballEl);

    // 방향키 안내 UI
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;bottom:8px;left:0;right:0;text-align:center;color:#16203a;font-size:0.74rem;pointer-events:none;user-select:none;';
    hint.textContent   = `[S] 출발 → [G] 도착  |  ← ↑ ↓ → 방향키로 이동  (${_COLS}×${_ROWS} 격자)`;
    area.appendChild(hint);

    _renderMaze();
    _placeBall();

    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup',   _onKeyUp);

    // 타이머 표시 즉시 반영 후 시작
    _startTimer(t.timer);

    return _cleanup;
  }

  function onAdElementInteract() {
    if (_ended) return;
    _cleanup();
    if (_onFail) _onFail('ad-click');
  }

  return { start, onAdElementInteract };
})();
