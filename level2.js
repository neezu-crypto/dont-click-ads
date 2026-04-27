// Level 2: DFS Maze — Keyboard Ball
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
  const AD_R           = Math.round(BALL_R * 1.44); // 광고 반지름
  const AD_SPAWN_DELAY = 8_000; // 8초 후 광고 출현
  const PATH_INTERVAL  = 100;   // 경로 기록 간격 (ms)
  const AD_SPEED_MULT  = 1.35;  // 플레이어 경로 재생 속도 배율 (1.35 = 35% 빠름)

  // 레벨별 난이도: 셀 크기가 작을수록 더 많은 셀 → 복잡한 미로
  const TIERS = [
    { minLv: 1,  maxLv: 10, cell: 40, timer: 70 },
  ];

  function _tier() {
    const lv = (typeof currentLevel !== 'undefined') ? currentLevel : 2;
    return TIERS.find(t => lv >= t.minLv && lv <= t.maxLv) || TIERS[0];
  }

  // 색상
  const COL_BG    = '#050608';
  const COL_FLOOR = '#1c2e52';
  const COL_EDGE  = '#2e4570';

  // ── 모듈 상태 ──
  let _area, _canvas, _ballEl, _dpad;
  let _mobileOverlay    = null;
  let _originalArea     = null;
  let _isMobileRotated  = false;
  let _onSuccess, _onFail;
  let _timerInterval = null;
  let _timeLeft = 60;
  let _keysDown = new Set(); // 현재 눌린 방향키
  let _rafId    = null;      // requestAnimationFrame ID
  let _ballPos  = { x: 0, y: 0 };
  let _ended    = false;

  // 광고 추적자 상태
  let _pathHistory    = [];   // [{x,y}] — 플레이어 경로 기록
  let _pathTimer      = null; // setInterval ID (경로 기록)
  let _adEl           = null; // 광고 원형 DOM 요소
  let _adPos          = { x: 0, y: 0 };
  let _adIdxF         = 0;    // 경로 내 실수 인덱스 (보간용)
  let _adRafId        = null; // requestAnimationFrame ID (광고 이동)
  let _adLastTs       = 0;    // 직전 RAF 타임스탬프
  let _adSpawnTimeout  = null;  // setTimeout ID (출현 예약)
  let _adTimerStarted  = false; // 출발지 이탈 후 타이머 시작 여부
  let _adLandingUrl    = '';

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

        ctx.fillStyle = COL_FLOOR;
        ctx.fillRect(iX, iY, iW, iH);

        if (!cl.E && c < _COLS - 1)
          ctx.fillRect(px + cW - wW, iY, wW * 2, iH);

        if (!cl.S && r < _ROWS - 1)
          ctx.fillRect(iX, py + cH - wH, iW, wH * 2);

        ctx.strokeStyle = COL_EDGE;
        ctx.lineWidth   = 0.5;
        if (cl.N) { ctx.beginPath(); ctx.moveTo(iX, iY); ctx.lineTo(iX + iW, iY); ctx.stroke(); }
        if (cl.W) { ctx.beginPath(); ctx.moveTo(iX, iY); ctx.lineTo(iX, iY + iH); ctx.stroke(); }
      }
    }

    _drawPortal(ctx, _sCell.c, _sCell.r, cW, cH, wW, wH, '#00ffaa', 'S');
    _drawPortal(ctx, _fCell.c, _fCell.r, cW, cH, wW, wH, '#ff4444', 'G');

    ctx.restore();
  }

  function _drawPortal(ctx, c, r, cW, cH, wW, wH, color, letter) {
    const cx  = c * cW + cW / 2;
    const cy  = r * cH + cH / 2;
    const rad = Math.min(cW, cH) / 2 - Math.max(wW, wH) - 1;

    ctx.fillStyle = color + '28';
    ctx.fillRect(c * cW + wW, r * cH + wH, cW - wW * 2, cH - wH * 2);

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1.8;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, rad + 3, 0, Math.PI * 2);
    ctx.strokeStyle = color + '44';
    ctx.lineWidth   = 2;
    ctx.stroke();

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

  // ─── 경로 기록 ───

  function _startPathRecording() {
    // 출발 셀 중심을 첫 점으로 고정 → 광고 반지름(AD_R)이 공보다 커서
    // 공 위치 기준으로 출발하면 벽에 끼므로, 셀 중심(여백 충분)에서 시작
    const sx = MAZE_PAD + (_sCell.c + 0.5) * _CELL;
    const sy = MAZE_PAD + (_sCell.r + 0.5) * _CELL;
    _pathHistory = [{ x: sx, y: sy }, { x: _ballPos.x, y: _ballPos.y }];
    _pathTimer = setInterval(() => {
      if (!_ended) _pathHistory.push({ x: _ballPos.x, y: _ballPos.y });
    }, PATH_INTERVAL);
  }

  // ─── 광고 추적자 ───

  function _spawnAd() {
    if (_ended || !_area) return;
    const ad = (typeof randomAd === 'function') ? randomAd('all') : null;
    _adLandingUrl = (ad && ad.landingUrl) ? ad.landingUrl : '';

    _adEl = document.createElement('div');
    _adEl.style.cssText = `
      position:absolute; border-radius:50%;
      background:radial-gradient(circle at 35% 35%, #ff8844, #cc2200);
      box-shadow:0 0 14px #ff440099, 0 0 28px #ff440044;
      border:2px solid #ff6600;
      z-index:9; pointer-events:none;
      display:flex; align-items:center; justify-content:center;
      color:#fff; font-weight:bold; letter-spacing:0.03em;
      animation:adPulse 0.9s ease-in-out infinite alternate;
    `;
    const label = document.createElement('span');
    label.textContent = 'AD';
    label.style.cssText = 'font-size:0.55rem; user-select:none;';
    _adEl.appendChild(label);
    _area.appendChild(_adEl);

    _adIdxF = 0;
    _adPos = { x: _pathHistory[0].x, y: _pathHistory[0].y };
    _placeAd();

    _adLastTs = performance.now();
    _adRafId = requestAnimationFrame(_adMoveTick);
  }

  function _placeAd() {
    if (!_adEl || !_area) return;
    const s = _scale();
    const r = AD_R * Math.min(s.x, s.y);
    _adEl.style.width  = `${r * 2}px`;
    _adEl.style.height = `${r * 2}px`;
    _adEl.style.left   = `${_adPos.x * s.x - r}px`;
    _adEl.style.top    = `${_adPos.y * s.y - r}px`;
  }

  // RAF 루프: 경과 시간 × 속도 배율로 실수 인덱스를 전진하고 선형 보간
  function _adMoveTick(ts) {
    _adRafId = null;
    if (_ended || !_adEl) return;

    const elapsed = ts - _adLastTs;
    _adLastTs = ts;

    const maxIdx = _pathHistory.length - 1;
    _adIdxF = Math.min(_adIdxF + (elapsed * AD_SPEED_MULT / PATH_INTERVAL), maxIdx);

    const i0 = Math.floor(_adIdxF);
    const i1 = Math.min(i0 + 1, maxIdx);
    const t  = _adIdxF - i0;
    const p0 = _pathHistory[i0], p1 = _pathHistory[i1];

    _adPos = {
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t,
    };
    _placeAd();
    _checkAdCollision();

    if (!_ended) _adRafId = requestAnimationFrame(_adMoveTick);
  }

  function _checkAdCollision() {
    if (_ended || !_adEl) return;
    const dist = Math.hypot(_ballPos.x - _adPos.x, _ballPos.y - _adPos.y);
    if (dist < BALL_R + AD_R) _onAdCaught();
  }

  function _onAdCaught() {
    if (_ended) return;
    _ended = true;
    _cleanup();
    if (_adLandingUrl) window.open(_adLandingUrl, '_blank');
    if (_onFail) _onFail('ad-caught');
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

    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2;
      dy *= Math.SQRT1_2;
    }

    const pos = _tryMove(_ballPos.x, _ballPos.y, _ballPos.x + dx, _ballPos.y + dy);
    _ballPos.x = pos.x; _ballPos.y = pos.y;
    _placeBall();

    if (_ballEl) {
      _ballEl.style.boxShadow = '0 0 20px #00ffaacc, 0 0 40px #00ffaa55';
      _ballEl.style.transform = 'scale(1.08)';
    }

    // 출발지 이탈 시 광고 출현 타이머 시작
    if (!_adTimerStarted) {
      const sx = MAZE_PAD + (_sCell.c + 0.5) * _CELL;
      const sy = MAZE_PAD + (_sCell.r + 0.5) * _CELL;
      if (Math.hypot(_ballPos.x - sx, _ballPos.y - sy) > _CELL * 0.6) {
        _adTimerStarted = true;
        _startPathRecording();
        _adSpawnTimeout = setTimeout(_spawnAd, AD_SPAWN_DELAY);
      }
    }

    // 광고 충돌 판정 (이동마다 즉시 확인)
    if (_adEl) { _checkAdCollision(); if (_ended) return; }

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
    setTimeout(() => { if (_onSuccess) _onSuccess(100); }, 400);
  }

  // ─── 모바일 조이스틱 ───

  function _createJoystick() {
    const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    if (!isTouchDevice) return null;

    const BASE_R  = 60;
    const THUMB_R = 24;
    const DEAD    = 14;
    const THRESH  = BASE_R * 0.36;

    // _isMobileRotated 시: CSS 90° CW 회전 보정으로 물리 방향 → 시각 방향 매핑
    // 계산 근거: local(lx,ly) → screen(ly, vh-lx) 변환,
    //   물리 right(ox+) = 시각 up(game y-) = ArrowUp
    //   물리 down(oy+)  = 시각 right(game x+) = ArrowRight
    const pos = _isMobileRotated
      ? 'bottom:28px;left:28px'    // CSS 회전 시 물리 bottom-right 위치
      : 'bottom:28px;right:28px';  // 일반 가로 화면

    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'position:absolute',
      pos,
      `width:${BASE_R * 2}px`,
      `height:${BASE_R * 2}px`,
      'z-index:20',
      'touch-action:none',
      'user-select:none',
      '-webkit-user-select:none',
    ].join(';');

    const base = document.createElement('div');
    base.style.cssText = [
      'position:absolute', 'inset:0',
      'border-radius:50%',
      'background:rgba(20,50,120,0.38)',
      'border:2.5px solid rgba(80,160,255,0.42)',
      'box-sizing:border-box',
    ].join(';');
    wrap.appendChild(base);

    const thumb = document.createElement('div');
    thumb.style.cssText = [
      'position:absolute',
      `width:${THUMB_R * 2}px`,
      `height:${THUMB_R * 2}px`,
      'border-radius:50%',
      `top:${BASE_R - THUMB_R}px`,
      `left:${BASE_R - THUMB_R}px`,
      'background:radial-gradient(circle at 38% 38%,rgba(180,230,255,0.95),rgba(40,130,255,0.82))',
      'border:2px solid rgba(255,255,255,0.55)',
      'box-sizing:border-box',
      'pointer-events:none',
      'will-change:transform',
    ].join(';');
    wrap.appendChild(thumb);

    let _activePtr = null;

    function _applyJoy(ox, oy) {
      const dist = Math.hypot(ox, oy);
      const clamp = Math.min(dist, BASE_R - THUMB_R);
      const r = dist > 0 ? clamp / dist : 0;
      thumb.style.transform = `translate(${ox * r}px,${oy * r}px)`;

      _keysDown.delete('ArrowUp');
      _keysDown.delete('ArrowDown');
      _keysDown.delete('ArrowLeft');
      _keysDown.delete('ArrowRight');

      if (dist > DEAD) {
        if (_isMobileRotated) {
          // CSS 90° CW 회전: 물리 right→game up, 물리 down→game right
          if (ox >  THRESH) _keysDown.add('ArrowUp');
          if (ox < -THRESH) _keysDown.add('ArrowDown');
          if (oy >  THRESH) _keysDown.add('ArrowRight');
          if (oy < -THRESH) _keysDown.add('ArrowLeft');
        } else {
          if (ox >  THRESH) _keysDown.add('ArrowRight');
          if (ox < -THRESH) _keysDown.add('ArrowLeft');
          if (oy >  THRESH) _keysDown.add('ArrowDown');
          if (oy < -THRESH) _keysDown.add('ArrowUp');
        }
      }

      if (_keysDown.size > 0 && !_rafId) _rafId = requestAnimationFrame(_moveTick);
    }

    function _resetJoy() {
      thumb.style.transform = '';
      _keysDown.delete('ArrowUp');
      _keysDown.delete('ArrowDown');
      _keysDown.delete('ArrowLeft');
      _keysDown.delete('ArrowRight');
      if (_ballEl) {
        _ballEl.style.boxShadow = '0 0 12px #00ffaa88, 0 0 24px #00ffaa44';
        _ballEl.style.transform = '';
      }
    }

    wrap.addEventListener('pointerdown', e => {
      if (_ended) return;
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      _activePtr = e.pointerId;
      const rect = base.getBoundingClientRect();
      _applyJoy(e.clientX - (rect.left + BASE_R), e.clientY - (rect.top + BASE_R));
    });

    wrap.addEventListener('pointermove', e => {
      if (e.pointerId !== _activePtr) return;
      e.preventDefault();
      const rect = base.getBoundingClientRect();
      _applyJoy(e.clientX - (rect.left + BASE_R), e.clientY - (rect.top + BASE_R));
    });

    const _endJoy = e => {
      if (e.pointerId !== _activePtr) return;
      _activePtr = null;
      _resetJoy();
    };
    wrap.addEventListener('pointerup',     _endJoy);
    wrap.addEventListener('pointercancel', _endJoy);

    return wrap;
  }

  function _rmListeners() {
    window.removeEventListener('keydown', _onKeyDown);
    window.removeEventListener('keyup',   _onKeyUp);
  }

  function _cleanup() {
    _stopTimer();
    _ended = true;
    _keysDown.clear();
    if (_rafId)           { cancelAnimationFrame(_rafId); _rafId = null; }
    if (_pathTimer)       { clearInterval(_pathTimer);      _pathTimer = null; }
    if (_adRafId)         { cancelAnimationFrame(_adRafId); _adRafId = null; }
    if (_adSpawnTimeout)  { clearTimeout(_adSpawnTimeout);  _adSpawnTimeout = null; }
    if (_adEl  && _adEl.parentNode)  { _adEl.parentNode.removeChild(_adEl);   _adEl  = null; }
    if (_dpad  && _dpad.parentNode)  { _dpad.parentNode.removeChild(_dpad);   _dpad  = null; }
    _rmListeners();
    if (_mobileOverlay) {
      _mobileOverlay.remove();
      _mobileOverlay = null;
      document.body.style.overflow = '';
    } else if (_originalArea) {
      _originalArea.style.width  = '';
      _originalArea.style.height = '';
    }
    _originalArea    = null;
    _isMobileRotated = false;
  }

  // ─── Public API ───

  function start(area, onSuccess, onFail) {
    _cleanup(); // cancel any stale RAF/timers from a previous invocation
    _originalArea = area;
    _onSuccess = onSuccess; _onFail = onFail;
    _ended = false; _keysDown.clear();
    _pathHistory = []; _adEl = null; _adPos = { x: 0, y: 0 };
    _adIdxF = 0; _adLastTs = 0; _adLandingUrl = ''; _adTimerStarted = false;

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

    // 모바일: 전체화면 + 가로 방향 잠금 + 화면 가득 채움
    const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    if (isMobile) {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen) docEl.requestFullscreen().catch(() => {});
      else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();

      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const isPortrait = vw < vh;
      // Android Chrome: orientation.lock API 존재 → OS가 회전 담당, CSS 회전 불필요
      // iOS: API 없음 → CSS 회전으로 처리
      const canLockOrientation = !!(screen.orientation && screen.orientation.lock);
      if (canLockOrientation) screen.orientation.lock('landscape').catch(() => {});

      _mobileOverlay = document.createElement('div');
      _mobileOverlay.style.cssText =
        'position:fixed;inset:0;z-index:9999;background:#07090f;' +
        'display:flex;align-items:center;justify-content:center;overflow:hidden;';

      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText =
        'position:absolute;top:10px;left:10px;z-index:10000;' +
        'background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);' +
        'color:#fff;font-size:1rem;padding:6px 12px;border-radius:8px;cursor:pointer;';
      closeBtn.addEventListener('click', () => {
        if (!_ended) { _ended = true; _cleanup(); if (_onFail) _onFail('quit'); }
      });
      _mobileOverlay.appendChild(closeBtn);

      const inner = document.createElement('div');
      if (canLockOrientation) {
        inner.style.cssText =
          `width:${Math.max(vw, vh)}px;height:${Math.min(vw, vh)}px;` +
          'position:relative;overflow:hidden;border-radius:0;';
        _isMobileRotated = false;
      } else if (isPortrait) {
        inner.style.cssText =
          `width:${vh}px;height:${vw}px;` +
          'transform:rotate(90deg);transform-origin:center center;' +
          'position:relative;overflow:hidden;border-radius:0;';
        _isMobileRotated = true;
      } else {
        inner.style.cssText =
          `width:${vw}px;height:${vh}px;` +
          'position:relative;overflow:hidden;border-radius:0;';
        _isMobileRotated = false;
      }

      _mobileOverlay.appendChild(inner);
      document.body.appendChild(_mobileOverlay);
      document.body.style.overflow = 'hidden';
      _mobileOverlay.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

      _area = inner;
    } else {
      _area = area;
      area.style.height = `${CANVAS_H}px`;
      area.innerHTML    = '';
    }

    _canvas = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:14px;';
    _canvas.width  = CANVAS_W;
    _canvas.height = CANVAS_H;
    _area.appendChild(_canvas);

    _ballEl = document.createElement('div');
    _ballEl.style.cssText = `
      position:absolute; border-radius:50%;
      user-select:none; -webkit-user-select:none;
      background:radial-gradient(circle at 35% 35%, #00ffdd, #00cc77);
      box-shadow:0 0 12px #00ffaa88, 0 0 24px #00ffaa44;
      z-index:10; transition:box-shadow 0.12s, transform 0.12s;
    `;
    _area.appendChild(_ballEl);

    const isTouchDevice = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const hint = document.createElement('div');
    hint.style.cssText = 'position:absolute;bottom:8px;left:0;right:0;text-align:center;color:#16203a;font-size:0.74rem;pointer-events:none;user-select:none;';
    hint.textContent   = isTouchDevice
      ? `[S] 출발 → [G] 도착  |  조이스틱으로 이동  (${_COLS}×${_ROWS} 격자)`
      : `[S] 출발 → [G] 도착  |  ← ↑ ↓ → 방향키로 이동  (${_COLS}×${_ROWS} 격자)`;
    _area.appendChild(hint);

    _dpad = _createJoystick();
    if (_dpad) _area.appendChild(_dpad);

    _renderMaze();
    _placeBall();

    window.addEventListener('keydown', _onKeyDown);
    window.addEventListener('keyup',   _onKeyUp);

    _startTimer(t.timer);

    return _cleanup;
  }

  function onAdElementInteract() {
    if (_ended) return;
    _cleanup();
    if (_onFail) _onFail('ad-caught');
  }

  return { start, onAdElementInteract };
})();
