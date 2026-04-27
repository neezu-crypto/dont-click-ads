// Tetris mini-game module
const TetrisModule = (() => {
  'use strict';

  // ── 논리 해상도 ──
  const COLS = 10, ROWS = 20;
  const CELL = 28; // 셀 크기(px) — 논리 캔버스 기준
  const LW = COLS * CELL;    // 320
  const LH = ROWS * CELL;    // 560
  const TARGET_LINES = 10;   // 승리 조건

  // ── 낙하 속도 ──
  const DROP_BASE  = 800;  // ms (초기 한 칸 낙하 주기)
  const DROP_MIN   = 400;  // ms (최소)
  const DROP_STEP  = 30;   // 블록 1개 쌓을 때마다 단축 ms

  // ── 테트로미노 정의 (SRS 배치) ──
  const PIECES = [
    { shape: [[1,1,1,1]],                           color: '#00f0f0' }, // I
    { shape: [[1,0],[1,0],[1,1]],                   color: '#f0a000' }, // J
    { shape: [[0,1],[0,1],[1,1]],                   color: '#0000f0' }, // L  (색 스왑 주의: 게임 전통 색)
    { shape: [[1,1],[1,1]],                         color: '#f0f000' }, // O
    { shape: [[0,1,1],[1,1,0]],                     color: '#00f000' }, // S
    { shape: [[1,1,1],[0,1,0]],                     color: '#a000f0' }, // T
    { shape: [[1,1,0],[0,1,1]],                     color: '#f00000' }, // Z
  ];

  // ── 상태 ──
  let _area, _wrap, _canvas, _ctx;
  let _onScore, _onSuccess, _onFail;
  let _ended = false, _rafId = null;

  let _board = [];      // _board[row][col] = color string | null
  let _cur   = null;    // { shape, color, r, c }  현재 낙하 블록
  let _next  = null;
  let _linesCleared = 0;
  let _blocksPlaced = 0;
  let _dropInterval = DROP_BASE;
  let _lastDrop = 0;

  let _mobileOverlay   = null;
  let _isMobileRotated = false;
  let _originalArea    = null;

  // 드래그 / 클릭 구분용
  let _pointerDown = false;
  let _dragStartX  = 0;
  let _dragAccX    = 0;   // 누적 드래그 거리 (논리px)
  let _moved       = false; // 드래그로 이동이 한 번이라도 발생했으면 true → click 무효
  const DRAG_THRESHOLD = CELL; // 한 칸 이동에 필요한 드래그 거리

  // ── 보드 초기화 ──
  function _initBoard() {
    _board = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  // ── 랜덤 피스 ──
  function _newPiece() {
    const def = PIECES[Math.floor(Math.random() * PIECES.length)];
    return {
      shape: def.shape.map(r => [...r]),
      color: def.color,
      r: 0,
      c: Math.floor((COLS - def.shape[0].length) / 2),
    };
  }

  // ── 시계방향 회전 ──
  function _rotCW(shape) {
    const rows = shape.length, cols = shape[0].length;
    const out = Array.from({ length: cols }, () => Array(rows).fill(0));
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++)
        out[c][rows - 1 - r] = shape[r][c];
    return out;
  }

  // ── 충돌 검사 ──
  function _fits(shape, pr, pc) {
    for (let r = 0; r < shape.length; r++)
      for (let c = 0; c < shape[r].length; c++) {
        if (!shape[r][c]) continue;
        const br = pr + r, bc = pc + c;
        if (br >= ROWS || bc < 0 || bc >= COLS) return false;
        if (br >= 0 && _board[br][bc]) return false;
      }
    return true;
  }

  // ── 블록 고정 ──
  function _lock() {
    const { shape, color, r, c } = _cur;
    for (let dr = 0; dr < shape.length; dr++)
      for (let dc = 0; dc < shape[dr].length; dc++)
        if (shape[dr][dc]) {
          const br = r + dr;
          if (br < 0) { _triggerFail(); return; } // 화면 밖으로 쌓임
          _board[br][c + dc] = color;
        }

    // 라인 제거
    let cleared = 0;
    for (let row = ROWS - 1; row >= 0; row--) {
      if (_board[row].every(cell => cell !== null)) {
        _board.splice(row, 1);
        _board.unshift(Array(COLS).fill(null));
        cleared++;
        row++; // 같은 row 재검사
      }
    }
    if (cleared > 0) {
      _linesCleared += cleared;
      _onScore && _onScore(cleared * 20);
      if (_linesCleared >= TARGET_LINES) { _triggerSuccess(); return; }
    }

    _blocksPlaced++;
    _dropInterval = Math.max(DROP_MIN, DROP_BASE - _blocksPlaced * DROP_STEP);

    _cur  = _next;
    _next = _newPiece();

    // 새 블록이 즉시 충돌 → 게임오버
    if (!_fits(_cur.shape, _cur.r, _cur.c)) {
      _triggerFail();
    }
  }

  // ── 성공 / 실패 처리 ──
  function _triggerSuccess() {
    if (_ended) return;
    _ended = true;
    _render();
    setTimeout(() => { if (_onSuccess) _onSuccess(); }, 600);
  }

  function _triggerFail() {
    if (_ended) return;
    _ended = true;
    _render();
    const ad = (typeof randomAd === 'function') ? (randomAd('level1') || randomAd('all')) : null;
    if (ad) window.open(ad.landingUrl, '_blank');
    if (typeof recordAdClick === 'function') recordAdClick();
    setTimeout(() => { if (_onFail) _onFail('lost'); }, 800);
  }

  // ── 이동 ──
  function _moveLeft()  { if (_fits(_cur.shape, _cur.r, _cur.c - 1)) _cur.c--; }
  function _moveRight() { if (_fits(_cur.shape, _cur.r, _cur.c + 1)) _cur.c++; }
  function _rotate() {
    const rot = _rotCW(_cur.shape);
    // Wall-kick: 제자리 → 오른쪽 → 왼쪽
    for (const dc of [0, 1, -1, 2, -2]) {
      if (_fits(rot, _cur.r, _cur.c + dc)) { _cur.shape = rot; _cur.c += dc; return; }
    }
  }

  // ── 즉시 낙하(소프트 드롭) ──
  function _softDrop() {
    if (_fits(_cur.shape, _cur.r + 1, _cur.c)) {
      _cur.r++;
      _lastDrop = performance.now();
    } else {
      _lock();
    }
  }

  // ── 그림자(Ghost) 위치 ──
  function _ghostRow() {
    let gr = _cur.r;
    while (_fits(_cur.shape, gr + 1, _cur.c)) gr++;
    return gr;
  }

  // ── 렌더링 ──
  const BG       = '#0a0a14';
  const GRID_COL = '#ffffff0d';
  const BORDER   = '#334466';

  function _render() {
    if (!_ctx || !_canvas) return;
    const ctx = _ctx;
    const cw  = _canvas.width, ch = _canvas.height;
    const sx  = cw / LW, sy = ch / LH;
    ctx.clearRect(0, 0, cw, ch);
    ctx.save();
    ctx.scale(sx, sy);

    // 배경
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, LW, LH);

    // 격자
    ctx.strokeStyle = GRID_COL;
    ctx.lineWidth   = 0.5;
    for (let c = 0; c <= COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * CELL, 0); ctx.lineTo(c * CELL, LH); ctx.stroke();
    }
    for (let r = 0; r <= ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * CELL); ctx.lineTo(LW, r * CELL); ctx.stroke();
    }

    // 보드 고정 블록
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (_board[r][c]) _drawCell(ctx, c, r, _board[r][c]);

    // Ghost
    if (_cur && !_ended) {
      const gr = _ghostRow();
      _cur.shape.forEach((row, dr) =>
        row.forEach((v, dc) => {
          if (v) _drawCell(ctx, _cur.c + dc, gr + dr, _cur.color, 0.18);
        })
      );
    }

    // 현재 블록
    if (_cur && !_ended) {
      _cur.shape.forEach((row, dr) =>
        row.forEach((v, dc) => {
          if (v) _drawCell(ctx, _cur.c + dc, _cur.r + dr, _cur.color);
        })
      );
    }

    // 테두리
    ctx.strokeStyle = BORDER;
    ctx.lineWidth   = 2;
    ctx.strokeRect(0, 0, LW, LH);

    // HUD: 진행도
    const barW = 80;
    const ratio = Math.min(_linesCleared / TARGET_LINES, 1);
    ctx.fillStyle = '#ffffff15';
    ctx.fillRect(LW - barW - 6, 6, barW, 10);
    ctx.fillStyle = '#00ffaa';
    ctx.fillRect(LW - barW - 6, 6, barW * ratio, 10);
    ctx.font = '10px monospace';
    ctx.fillStyle = '#ffffffbb';
    ctx.textAlign = 'right';
    ctx.fillText(`${_linesCleared}/${TARGET_LINES} 줄`, LW - 6, 28);
    ctx.textAlign = 'left';

    // 다음 피스 미리보기
    ctx.fillStyle = '#ffffff0a';
    ctx.fillRect(4, 4, 60, 52);
    ctx.font = '7px monospace';
    ctx.fillStyle = '#ffffff44';
    ctx.fillText('NEXT', 6, 13);
    if (_next) {
      const ns = _next.shape;
      const pw = ns[0].length * 10, ph = ns.length * 10;
      const ox = 4 + (60 - pw) / 2, oy = 16 + (38 - ph) / 2;
      ns.forEach((row, dr) =>
        row.forEach((v, dc) => {
          if (!v) return;
          ctx.fillStyle = _next.color;
          ctx.fillRect(ox + dc * 10, oy + dr * 10, 9, 9);
          ctx.fillStyle = '#ffffff33';
          ctx.fillRect(ox + dc * 10, oy + dr * 10, 9, 2);
          ctx.fillStyle = '#00000033';
          ctx.fillRect(ox + dc * 10, oy + 7 + dr * 10, 9, 2);
        })
      );
    }

    ctx.restore();
  }

  function _drawCell(ctx, c, r, color, alpha) {
    if (r < 0) return;
    const x = c * CELL, y = r * CELL;
    const a = alpha !== undefined ? alpha : 1;
    ctx.globalAlpha = a;
    ctx.fillStyle = color;
    ctx.fillRect(x + 1, y + 1, CELL - 2, CELL - 2);
    // 하이라이트
    ctx.fillStyle = '#ffffff44';
    ctx.fillRect(x + 1, y + 1, CELL - 2, 4);
    ctx.fillStyle = '#00000066';
    ctx.fillRect(x + 1, y + CELL - 5, CELL - 2, 4);
    ctx.globalAlpha = 1;
  }

  // ── 메인 루프 ──
  function _tick(ts) {
    _rafId = null;
    if (_ended) return;

    if (ts - _lastDrop >= _dropInterval) {
      _lastDrop = ts;
      if (_fits(_cur.shape, _cur.r + 1, _cur.c)) {
        _cur.r++;
      } else {
        _lock();
        if (_ended) return;
      }
    }

    _render();
    _rafId = requestAnimationFrame(_tick);
  }

  // ── 입력 좌표 → 논리 X ──
  function _clientToLogicalX(clientX) {
    const rect = _canvas.getBoundingClientRect();
    const scaleX = LW / rect.width;
    if (_isMobileRotated) {
      // CSS rotate(90deg CW) 적용 상태: clientX는 스크린 X, 논리 X는 스크린 Y에 대응
      const cx = rect.left + rect.width / 2;
      const cy = rect.top  + rect.height / 2;
      const syr = clientX - cx;
      const ex  = _area.offsetWidth / 2 + syr; // CCW 역변환 X축
      return ex * (LW / _area.offsetWidth);
    }
    return (clientX - rect.left) * scaleX;
  }

  // ── 이벤트 핸들러 ──
  function _onPointerDown(e) {
    if (_ended) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    _pointerDown = true;
    _dragStartX  = clientX;
    _dragAccX    = 0;
    _moved       = false;
  }

  function _onPointerMove(e) {
    if (!_pointerDown || _ended) return;
    e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const lx = _clientToLogicalX(clientX);
    const lStartX = _clientToLogicalX(_dragStartX);
    _dragAccX = lx - lStartX;

    const steps = Math.trunc(_dragAccX / DRAG_THRESHOLD);
    if (steps !== 0) {
      for (let i = 0; i < Math.abs(steps); i++) {
        steps > 0 ? _moveRight() : _moveLeft();
      }
      _dragStartX = clientX;
      _dragAccX   = 0;
      _moved       = true;
    }
  }

  function _onPointerUp(e) {
    if (!_pointerDown || _ended) { _pointerDown = false; return; }
    e.preventDefault();
    if (!_moved) _rotate(); // 이동 없이 놓으면 회전
    _pointerDown = false;
    _moved       = false;
  }

  function _addListeners(target) {
    target.addEventListener('mousedown',  _onPointerDown, { passive: false });
    target.addEventListener('mousemove',  _onPointerMove, { passive: false });
    target.addEventListener('mouseup',    _onPointerUp,   { passive: false });
    target.addEventListener('touchstart', _onPointerDown, { passive: false });
    target.addEventListener('touchmove',  _onPointerMove, { passive: false });
    target.addEventListener('touchend',   _onPointerUp,   { passive: false });
    target.addEventListener('touchcancel',_onPointerUp,   { passive: false });
  }

  function _removeListeners(target) {
    target.removeEventListener('mousedown',  _onPointerDown);
    target.removeEventListener('mousemove',  _onPointerMove);
    target.removeEventListener('mouseup',    _onPointerUp);
    target.removeEventListener('touchstart', _onPointerDown);
    target.removeEventListener('touchmove',  _onPointerMove);
    target.removeEventListener('touchend',   _onPointerUp);
    target.removeEventListener('touchcancel',_onPointerUp);
  }

  // ── 정리 ──
  function _cleanup() {
    _ended = true;
    if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
    const tgt = _mobileOverlay || _canvas;
    if (tgt) _removeListeners(tgt);
    if (_mobileOverlay) {
      _mobileOverlay.remove();
      _mobileOverlay = null;
      document.body.style.overflow = '';
    } else if (_originalArea) {
      _originalArea.style.width       = '';
      _originalArea.style.height      = '';
      _originalArea.style.aspectRatio = '';
      _originalArea.style.position    = '';
    }
    if (_wrap) { _wrap.style.width = ''; _wrap = null; }
    _isMobileRotated = false;
    _originalArea    = null;
    _canvas = null;
    _ctx    = null;
  }

  // ── Public: start ──
  function start(area, onScore, onSuccess, onFail) {
    _cleanup();

    _originalArea = area;
    _onScore   = onScore;
    _onSuccess = onSuccess;
    _onFail    = onFail;
    _ended     = false;

    _initBoard();
    _linesCleared = 0;
    _blocksPlaced = 0;
    _dropInterval = DROP_BASE;
    _lastDrop     = 0;
    _pointerDown  = false;
    _moved        = false;
    _cur  = _newPiece();
    _next = _newPiece();

    const isMobile = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

    if (isMobile) {
      const docEl = document.documentElement;
      if (docEl.requestFullscreen)            docEl.requestFullscreen().catch(() => {});
      else if (docEl.webkitRequestFullscreen) docEl.webkitRequestFullscreen();

      const vw = window.innerWidth, vh = window.innerHeight;
      const isPortrait = vw < vh;
      const canLock = !!(screen.orientation && screen.orientation.lock);
      if (canLock) screen.orientation.lock('portrait').catch(() => {}); // 테트리스는 세로 최적

      _mobileOverlay = document.createElement('div');
      _mobileOverlay.style.cssText =
        'position:fixed;inset:0;z-index:99995;background:#0a0a14;' +
        'display:flex;align-items:center;justify-content:center;overflow:hidden;';

      // 닫기 버튼
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText =
        'position:absolute;top:10px;left:10px;z-index:1;' +
        'background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.25);' +
        'color:#fff;font-size:1rem;padding:6px 12px;border-radius:8px;cursor:pointer;touch-action:manipulation;';
      closeBtn.addEventListener('click', () => {
        if (!_ended) { _ended = true; _cleanup(); if (_onFail) _onFail('quit'); }
      });
      _mobileOverlay.appendChild(closeBtn);

      // 테트리스는 세로 비율이 좋으므로 세로 화면 그대로 사용
      // iOS 세로 → 세로 그대로, 가로 → CSS 회전으로 세로처럼
      const inner = document.createElement('div');
      if (!isPortrait && !canLock) {
        // iOS 가로 → CSS 90° 반시계 회전으로 세로처럼 표시
        const size = Math.min(vw, vh);
        inner.style.cssText =
          `width:${vh}px;height:${vw}px;` +
          'transform:rotate(-90deg);transform-origin:center center;' +
          'position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;';
        _isMobileRotated = true;
      } else {
        inner.style.cssText =
          `width:${vw}px;height:${vh}px;` +
          'position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;';
        _isMobileRotated = false;
      }
      _mobileOverlay.appendChild(inner);
      document.body.appendChild(_mobileOverlay);
      document.body.style.overflow = 'hidden';
      _mobileOverlay.addEventListener('touchmove', e => e.preventDefault(), { passive: false });

      // 캔버스: 세로 비율(10:18 ≈ 320:560) 유지하며 화면에 맞춤
      const avW = _isMobileRotated ? vh : vw;
      const avH = _isMobileRotated ? vw : vh;
      const scale = Math.min(avW / LW, avH / LH);
      const cw = Math.floor(LW * scale), ch = Math.floor(LH * scale);

      _canvas = document.createElement('canvas');
      _canvas.width  = LW;
      _canvas.height = LH;
      _canvas.style.cssText = `width:${cw}px;height:${ch}px;display:block;touch-action:none;cursor:pointer;`;
      inner.appendChild(_canvas);
      _ctx = _canvas.getContext('2d');

      _addListeners(_mobileOverlay);
      _area = inner;
    } else {
      // PC
      _area = area;
      _wrap = area.parentElement;
      if (_wrap) _wrap.style.width = `min(${LW}px, 100%)`;
      area.style.width       = '100%';
      area.style.height      = 'auto';
      area.style.aspectRatio = `${LW} / ${LH}`;
      area.style.position    = 'relative';
      area.innerHTML = '';

      _canvas = document.createElement('canvas');
      _canvas.width  = LW;
      _canvas.height = LH;
      _canvas.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;' +
        'touch-action:none;cursor:pointer;display:block;user-select:none;';
      area.appendChild(_canvas);
      _ctx = _canvas.getContext('2d');

      _addListeners(_canvas);
    }

    _lastDrop = performance.now();
    _render();
    _rafId = requestAnimationFrame(_tick);

    return _cleanup;
  }

  return { start };
})();
