// Level 2: Ball Drag Maze
const Level2Module = (() => {
  'use strict';

  const LOGICAL_W = 640;
  const LOGICAL_H = 420;

  // ── 미로 그리드 설정 ──
  // 8열 × 5행 그리드에서 경로를 생성합니다.
  // 열 간격 ≈ 80px, 행 간격 ≈ 83px
  const GRID_COLS  = 8;
  const GRID_ROWS  = 5;
  const GRID_PAD_X = 38;
  const GRID_PAD_Y = 44;

  const CORRIDOR_HALF = 26;  // 통로 절반 폭 (px, 논리 좌표)
  const BALL_R        = 14;  // 공 반지름
  const CENTER_LIMIT  = CORRIDOR_HALF - BALL_R; // = 12 — 공 중심이 경로 중심선에서 벗어날 수 있는 최대 거리
  const FINISH_SNAP_R = 26;  // 도착 포털 인식 반경
  const TIMER_DURATION = 60;
  const SUCCESS_SCORE  = 500;

  // ─── 모듈 상태 ───
  let _area         = null;
  let _canvas       = null;
  let _ballEl       = null;
  let _onSuccess    = null;
  let _onFail       = null;
  let _timerInterval = null;
  let _timeLeft     = TIMER_DURATION;
  let _dragging     = false;
  let _grabOffset   = { x: 0, y: 0 };
  let _ballPos      = { x: 0, y: 0 };
  let _pathPoints   = [];     // 게임 시작 시 생성
  let _currentSegIdx = 0;    // 현재 공이 위치한 세그먼트 인덱스 (지름길 방지용)
  let _ended        = false;

  // ─── 경로 생성 ───

  function _gridXY(c, r) {
    const xStep = (LOGICAL_W - GRID_PAD_X * 2) / (GRID_COLS - 1);
    const yStep = (LOGICAL_H - GRID_PAD_Y * 2) / (GRID_ROWS - 1);
    return [GRID_PAD_X + c * xStep, GRID_PAD_Y + r * yStep];
  }

  // 그리드 기반 랜덤 워크로 미로 경로를 생성합니다.
  // 조건: 최소 11개 웨이포인트, 최소 3개 행 방문
  function _generatePath() {
    const midRow = Math.floor(GRID_ROWS / 2);

    for (let attempt = 0; attempt < 15; attempt++) {
      const visited     = new Set([`0,${midRow}`]);
      const visitedRows = new Set([midRow]);
      const pts         = [_gridXY(0, midRow)];
      let c = 0, r = midRow;

      for (let step = 0; step < 80; step++) {
        if (c === GRID_COLS - 1) break;

        const moves = [
          // 오른쪽: 우선순위 높음 (앞으로 진행)
          c < GRID_COLS - 1                        && { dc:  1, dr:  0, w: 5 },
          // 위아래: 중간 우선순위 (지그재그 생성)
          r > 0                                     && { dc:  0, dr: -1, w: 2 },
          r < GRID_ROWS - 1                         && { dc:  0, dr:  1, w: 2 },
          // 왼쪽: 낮은 우선순위, 중간 열에서만 허용 (백트래킹)
          c > 2 && c < GRID_COLS - 2                && { dc: -1, dr:  0, w: 1 },
        ].filter(m => m && !visited.has(`${c + m.dc},${r + m.dr}`));

        if (!moves.length) break;

        const total = moves.reduce((s, m) => s + m.w, 0);
        let roll = Math.random() * total;
        let chosen = moves[moves.length - 1];
        for (const m of moves) { roll -= m.w; if (roll <= 0) { chosen = m; break; } }

        c += chosen.dc;
        r += chosen.dr;
        visited.add(`${c},${r}`);
        visitedRows.add(r);
        pts.push(_gridXY(c, r));
      }

      // 오른쪽 끝에 닿지 못했다면 강제로 연결
      while (c < GRID_COLS - 1) { c++; pts.push(_gridXY(c, r)); }

      // 조건 충족 시 채택
      if (pts.length >= 11 && visitedRows.size >= 3) return pts;
    }

    // 폴백: 검증된 고정 미로 경로
    return [
      _gridXY(0, 2), _gridXY(1, 2), _gridXY(1, 0), _gridXY(3, 0),
      _gridXY(3, 4), _gridXY(5, 4), _gridXY(5, 1), _gridXY(6, 1),
      _gridXY(6, 3), _gridXY(7, 3), _gridXY(7, 2),
    ];
  }

  // ─── 수학 헬퍼 ───

  function _closestOnSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return { x: ax, y: ay };
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return { x: ax + t * dx, y: ay + t * dy };
  }

  // 공 중심을 현재 세그먼트 ±1 범위 안에서만 이동시킵니다.
  // 인접하지 않은 세그먼트로의 도약(지름길)을 원천 차단합니다.
  function _clampToPath(lx, ly) {
    const last = _pathPoints.length - 2;
    const lo   = Math.max(0, _currentSegIdx - 1);
    const hi   = Math.min(last, _currentSegIdx + 1);

    let bestDist = Infinity, bestPt = null, bestSeg = _currentSegIdx;
    for (let i = lo; i <= hi; i++) {
      const [ax, ay] = _pathPoints[i];
      const [bx, by] = _pathPoints[i + 1];
      const pt = _closestOnSegment(lx, ly, ax, ay, bx, by);
      const d  = Math.hypot(lx - pt.x, ly - pt.y);
      if (d < bestDist) { bestDist = d; bestPt = pt; bestSeg = i; }
    }

    _currentSegIdx = bestSeg;

    if (bestDist > CENTER_LIMIT) {
      const angle = Math.atan2(ly - bestPt.y, lx - bestPt.x);
      return {
        x: bestPt.x + Math.cos(angle) * CENTER_LIMIT,
        y: bestPt.y + Math.sin(angle) * CENTER_LIMIT,
      };
    }
    return { x: lx, y: ly };
  }

  // 공 시작 시 현재 세그먼트 인덱스 초기화
  function _initCurrentSeg() {
    let bestDist = Infinity;
    _currentSegIdx = 0;
    for (let i = 0; i < _pathPoints.length - 1; i++) {
      const [ax, ay] = _pathPoints[i];
      const [bx, by] = _pathPoints[i + 1];
      const pt = _closestOnSegment(_ballPos.x, _ballPos.y, ax, ay, bx, by);
      const d  = Math.hypot(_ballPos.x - pt.x, _ballPos.y - pt.y);
      if (d < bestDist) { bestDist = d; _currentSegIdx = i; }
    }
  }

  function _getScale() {
    if (!_area) return { x: 1, y: 1 };
    return { x: _area.offsetWidth / LOGICAL_W, y: _area.offsetHeight / LOGICAL_H };
  }

  function _toLogical(displayX, displayY) {
    const s = _getScale();
    return { x: displayX / s.x, y: displayY / s.y };
  }

  // ─── 렌더링 ───

  function _drawPath() {
    if (!_canvas || !_pathPoints.length) return;
    const ctx = _canvas.getContext('2d');
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);

    const s  = _getScale();
    const hw = CORRIDOR_HALF * Math.min(s.x, s.y);
    const pts = _pathPoints.map(([x, y]) => [x * s.x, y * s.y]);

    function polyline() {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    }

    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // 외부 광선 (발광 효과)
    ctx.save();
    ctx.strokeStyle = '#1a3380';
    ctx.lineWidth   = hw * 2 + 10;
    ctx.globalAlpha = 0.22;
    polyline(); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // 통로 바닥 (어두운 파란색)
    ctx.save();
    ctx.strokeStyle = '#111930';
    ctx.lineWidth   = hw * 2;
    polyline(); ctx.stroke();
    ctx.restore();

    // 통로 안쪽 하이라이트
    ctx.save();
    ctx.strokeStyle = '#171f40';
    ctx.lineWidth   = hw * 2 - 5;
    polyline(); ctx.stroke();
    ctx.restore();

    // 통로 벽 (양쪽 테두리선)
    ctx.save();
    ctx.strokeStyle = '#2a3f7a';
    ctx.lineWidth   = hw * 2 + 2;
    ctx.globalAlpha = 0.6;
    polyline(); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();

    // 중앙 점선 (길 안내)
    ctx.save();
    ctx.strokeStyle = '#253370';
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([8, 10]);
    polyline(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // 경유 웨이포인트 마커 (모서리 시각화)
    ctx.save();
    for (let i = 1; i < pts.length - 1; i++) {
      ctx.beginPath();
      ctx.arc(pts[i][0], pts[i][1], hw * 0.35, 0, Math.PI * 2);
      ctx.fillStyle   = '#1e2e58';
      ctx.strokeStyle = '#2a4080';
      ctx.lineWidth   = 1.5;
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();

    // START 포털 (초록)
    _drawPortal(ctx, pts[0][0], pts[0][1], hw * 0.85, '#00ffaa', 'S');
    // FINISH 포털 (빨강)
    _drawPortal(ctx, pts[pts.length - 1][0], pts[pts.length - 1][1], hw * 0.85, '#ff4444', 'G');
  }

  function _drawPortal(ctx, x, y, r, color, letter) {
    const grd = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    grd.addColorStop(0, color + 'aa');
    grd.addColorStop(1, color + '00');
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r + 5, 0, Math.PI * 2);
    ctx.strokeStyle = color + '44';
    ctx.lineWidth   = 2;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font         = `bold ${Math.round(r * 0.75)}px monospace`;
    ctx.fillStyle    = color;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(letter, x, y);
    ctx.restore();
  }

  function _placeBall() {
    if (!_ballEl || !_area) return;
    const s = _getScale();
    const r = BALL_R * Math.min(s.x, s.y);
    _ballEl.style.width  = `${r * 2}px`;
    _ballEl.style.height = `${r * 2}px`;
    _ballEl.style.left   = `${_ballPos.x * s.x - r}px`;
    _ballEl.style.top    = `${_ballPos.y * s.y - r}px`;
  }

  // ─── 타이머 ───

  function _startTimer() {
    _timeLeft = TIMER_DURATION;
    _updateTimerDisplay();
    _timerInterval = setInterval(() => {
      _timeLeft--;
      _updateTimerDisplay();
      if (_timeLeft <= 0) {
        _stopTimer();
        if (!_ended) {
          _ended = true;
          _removeListeners();
          if (_onFail) _onFail('timeout');
        }
      }
    }, 1000);
  }

  function _stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  }

  function _updateTimerDisplay() {
    const el = document.getElementById('timer-display');
    if (!el) return;
    el.textContent      = _timeLeft;
    el.style.color      = _timeLeft <= 10 ? '#ff4444' : '';
    el.style.textShadow = _timeLeft <= 10 ? '0 0 8px #ff444488' : '';
  }

  // ─── 이벤트 핸들러 ───

  function _getEventXY(e) {
    const src = e.touches ? e.touches[0] : e;
    return { clientX: src.clientX, clientY: src.clientY };
  }

  function _onDown(e) {
    if (_ended || !_area || !_ballEl) return;
    const { clientX, clientY } = _getEventXY(e);
    const rect = _area.getBoundingClientRect();
    const s    = _getScale();
    const mx   = clientX - rect.left;
    const my   = clientY - rect.top;
    const bx   = _ballPos.x * s.x;
    const by   = _ballPos.y * s.y;
    const r    = BALL_R * Math.min(s.x, s.y);

    if (Math.hypot(mx - bx, my - by) <= r * 2.2) {
      e.preventDefault();
      _dragging = true;
      const lp  = _toLogical(mx, my);
      _grabOffset = { x: lp.x - _ballPos.x, y: lp.y - _ballPos.y };
      _ballEl.style.cursor    = 'grabbing';
      _ballEl.style.boxShadow = '0 0 22px #00ffaacc, 0 0 44px #00ffaa44';
      _ballEl.style.transform = 'scale(1.15)';
    }
  }

  function _onMove(e) {
    if (!_dragging || _ended || !_area) return;
    e.preventDefault();
    const { clientX, clientY } = _getEventXY(e);
    const rect = _area.getBoundingClientRect();
    const raw  = _toLogical(clientX - rect.left, clientY - rect.top);
    const req  = { x: raw.x - _grabOffset.x, y: raw.y - _grabOffset.y };
    const pos  = _clampToPath(req.x, req.y);
    _ballPos.x = pos.x;
    _ballPos.y = pos.y;
    _placeBall();

    const [fx, fy] = _pathPoints[_pathPoints.length - 1];
    if (Math.hypot(_ballPos.x - fx, _ballPos.y - fy) < FINISH_SNAP_R) {
      _onReachFinish();
    }
  }

  function _onUp() {
    if (!_dragging) return;
    _dragging = false;
    if (_ballEl) {
      _ballEl.style.cursor    = 'grab';
      _ballEl.style.boxShadow = '0 0 12px #00ffaa88, 0 0 24px #00ffaa44';
      _ballEl.style.transform = '';
    }
  }

  function _onReachFinish() {
    if (_ended) return;
    _ended = true;
    _stopTimer();
    _dragging = false;

    const [fx, fy] = _pathPoints[_pathPoints.length - 1];
    _ballPos = { x: fx, y: fy };
    _placeBall();

    if (_ballEl) {
      _ballEl.style.transition = 'all 0.35s cubic-bezier(0.34,1.56,0.64,1)';
      _ballEl.style.background = 'radial-gradient(circle at 35% 35%, #ffff88, #ffcc00)';
      _ballEl.style.boxShadow  = '0 0 40px #ffcc00cc, 0 0 80px #ffcc0044';
      _ballEl.style.transform  = 'scale(1.5)';
    }

    _removeListeners();
    setTimeout(() => { if (_onSuccess) _onSuccess(SUCCESS_SCORE); }, 400);
  }

  // ─── 정리 ───

  function _removeListeners() {
    if (_area) {
      _area.removeEventListener('mousedown',  _onDown);
      _area.removeEventListener('touchstart', _onDown);
    }
    window.removeEventListener('mousemove', _onMove);
    window.removeEventListener('mouseup',   _onUp);
    window.removeEventListener('touchmove', _onMove);
    window.removeEventListener('touchend',  _onUp);
  }

  function _cleanup() {
    _stopTimer();
    _ended    = true;
    _dragging = false;
    _removeListeners();
  }

  // ─── Public API ───

  function start(area, onSuccess, onFail) {
    _area      = area;
    _onSuccess = onSuccess;
    _onFail    = onFail;
    _ended     = false;
    _dragging  = false;

    // 매 시작마다 새 미로 경로 생성
    _pathPoints    = _generatePath();
    _ballPos       = { x: _pathPoints[0][0], y: _pathPoints[0][1] };
    _currentSegIdx = 0;

    area.innerHTML = '';

    // 캔버스 (경로 그리기)
    _canvas             = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;border-radius:14px;';
    _canvas.width       = area.offsetWidth  || LOGICAL_W;
    _canvas.height      = area.offsetHeight || LOGICAL_H;
    area.appendChild(_canvas);

    // 드래그 가능한 공
    _ballEl = document.createElement('div');
    _ballEl.id = 'level2-ball';
    _ballEl.style.cssText = `
      position: absolute;
      background: radial-gradient(circle at 35% 35%, #00ffdd, #00cc77);
      border-radius: 50%;
      cursor: grab;
      user-select: none;
      -webkit-user-select: none;
      box-shadow: 0 0 12px #00ffaa88, 0 0 24px #00ffaa44;
      z-index: 10;
      transition: box-shadow 0.15s, transform 0.15s;
    `;
    area.appendChild(_ballEl);

    // 안내 라벨
    const hint = document.createElement('div');
    hint.style.cssText = `
      position: absolute;
      bottom: 10px; left: 0; right: 0;
      text-align: center;
      color: #1e2a50;
      font-size: 0.78rem;
      pointer-events: none;
      user-select: none;
    `;
    hint.textContent = '공을 드래그해서 통로를 따라 [G] 포털까지 이동하세요!';
    area.appendChild(hint);

    _drawPath();
    _placeBall();
    _initCurrentSeg();

    area.addEventListener('mousedown',  _onDown);
    area.addEventListener('touchstart', _onDown, { passive: false });
    window.addEventListener('mousemove', _onMove);
    window.addEventListener('mouseup',   _onUp);
    window.addEventListener('touchmove', _onMove, { passive: false });
    window.addEventListener('touchend',  _onUp);

    _startTimer();

    return _cleanup;
  }

  function onAdElementInteract() {
    if (_ended) return;
    _cleanup();
    if (_onFail) _onFail('ad-click');
  }

  return { start, onAdElementInteract };
})();
