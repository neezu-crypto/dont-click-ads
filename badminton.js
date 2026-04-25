// Badminton mini-game module
const BadmintonModule = (() => {
  'use strict';

  // ── 논리 해상도 ──
  const W = 640, H = 420;
  const NET_Y   = H / 2;       // 210
  const PAD     = 18;          // 코트 테두리 여백
  const TARGET  = 5;           // 선취 점수

  // 라켓
  const P_HIT_R    = 34;   // 플레이어 히트 판정 반지름
  const A_HIT_R    = 30;   // AI 히트 판정 반지름
  const RACKET_VR  = 21;   // 시각적 라켓 반지름
  const HIT_CD     = 22;   // 연속 히트 방지 쿨다운 (프레임)

  // 셔틀콕
  const SHUTTLE_R  = 7;
  const GRAVITY    = 0.072;   // 각 진영 백벽 쪽으로 당기는 가속도
  const DECEL      = 0.9935;  // 공기 저항

  // AI
  const AI_SPD_MIN   = 1.5;   // 추적 최저 속도 하한
  const AI_MISS_PROB = 0.06;  // 히트 실수 확률
  const AI_DIFFICULTY = 1.3;  // 난이도 배율 (0.7=쉬움 / 1.0=보통 / 1.3=어려움)

  // 상태
  let _area, _canvas, _ctx;
  let _onScore, _onSuccess, _onFail;
  let _ended = false, _rafId = null;

  let _pScore = 0, _aScore = 0;
  let _serving = 'player';              // 'player' | 'ai'
  let _phase   = 'idle';                // 'idle' | 'serve_wait' | 'rally' | 'point_pause'

  // 플레이어 라켓
  let _pRacket  = { x: W / 2, y: H - 72 };
  let _dragging = false;
  let _dragOX = 0, _dragOY = 0;
  let _pvx = 0, _pvy = 0;
  let _prevDX = 0, _prevDY = 0;
  let _pHitCd = 0;

  // AI 라켓
  let _aRacket      = { x: W / 2, y: 72 };
  let _aHitCd       = 0;

  // 셔틀콕
  let _sX = W / 2, _sY = NET_Y + 60;
  let _sVX = 0, _sVY = 0;
  let _sActive = false;
  let _lastHitter = null;  // 'player' | 'ai' — 연속 히트 방지

  // UI
  let _msg = '';
  let _msgAlpha = 0;

  // 타임아웃 핸들
  let _serveTO  = null;
  let _pointTO  = null;
  let _timerVal = 120;
  let _timerEl  = null;
  let _timerIv  = null;

  // ── 스케일 ──

  function _scale() {
    if (!_area) return { x: 1, y: 1 };
    return { x: _area.offsetWidth / W, y: _area.offsetHeight / H };
  }

  function _toLogi(clientX, clientY) {
    const rect = _canvas.getBoundingClientRect();
    const s = _scale();
    return { x: (clientX - rect.left) / s.x, y: (clientY - rect.top) / s.y };
  }

  // ── 타이머 ──

  function _startTimer() {
    _timerVal = 120;
    _syncTimer();
    _timerIv = setInterval(() => {
      if (_ended) { clearInterval(_timerIv); return; }
      _timerVal--;
      _syncTimer();
      if (_timerVal <= 0) {
        clearInterval(_timerIv);
        if (!_ended) _endGame(_pScore > _aScore ? 'win' : 'lose');
      }
    }, 1000);
  }

  function _stopTimer() {
    if (_timerIv) { clearInterval(_timerIv); _timerIv = null; }
  }

  function _syncTimer() {
    if (_timerEl) {
      _timerEl.textContent = _timerVal;
      _timerEl.style.color      = _timerVal <= 15 ? '#ff4444' : '';
      _timerEl.style.textShadow = _timerVal <= 15 ? '0 0 8px #ff444488' : '';
    }
  }

  // ── 서브 준비 ──

  function _prepareServe(delay) {
    _phase   = 'idle';
    _sActive = false;
    _pHitCd  = 0;
    _aHitCd  = 0;
    _lastHitter  = null;

    // AI 라켓을 플레이어 라켓의 네트 대칭 위치로 이동
    _aRacket.x = _pRacket.x;
    _aRacket.y = 2 * NET_Y - _pRacket.y;

    if (_serving === 'player') {
      _sX = _pRacket.x;
      _sY = H - 105;
    } else {
      _sX = _aRacket.x;
      _sY = 105;
    }
    _sVX = 0; _sVY = 0;

    _serveTO = setTimeout(() => {
      if (_ended) return;
      _phase   = 'serve_wait';
      _sActive = true;

      if (_serving === 'ai') {
        // AI가 자동 서브
        _serveTO = setTimeout(() => {
          if (_ended || _phase !== 'serve_wait') return;
          _sVX = (Math.random() - 0.5) * 5;
          _sVY = 4.5 + Math.random() * 1.5;
          _lastHitter = 'ai';
          _phase = 'rally';
        }, 900);
      }
    }, delay);
  }

  // ── 히트 ──

  function _playerHit() {
    const power = 6.5 + Math.min(Math.abs(_pvy), 6) * 0.35;
    _sVY = -(power);
    _sVX = _pvx * 0.45 + (_sX - _pRacket.x) * 0.08;
    _sVX = Math.max(-8, Math.min(8, _sVX));
    _pHitCd    = HIT_CD;
    _lastHitter = 'player';
    _phase = 'rally';
    if (typeof playBadmintonHitSound === 'function') playBadmintonHitSound();
    _flashHit(_pRacket.x, _pRacket.y, '#00ddff');
  }

  function _aiHit() {
    // 초보 AI: 가끔 실수(빗맞음)
    if (Math.random() < AI_MISS_PROB) {
      _aHitCd = HIT_CD;
      return; // 히트 실패 → 셔틀 그대로 통과
    }
    const power = 5.5 + Math.random() * 2.5;
    _sVY = power;
    _sVX = (_sX - W / 2) * 0.06 + (Math.random() - 0.5) * 1.5;
    _sVX = Math.max(-7, Math.min(7, _sVX));
    _aHitCd    = HIT_CD;
    _lastHitter = 'ai';
    if (typeof playBadmintonHitSound === 'function') playBadmintonHitSound();
    _flashHit(_aRacket.x, _aRacket.y, '#ff6655');
  }

  // ── AI 이동 ──

  function _updateAI() {
    if (_phase === 'idle') return;

    if (_sY >= NET_Y) return; // 셔틀이 플레이어 쪽 → 제자리 대기

    // 셔틀 속도 × 난이도 배율 (최저 AI_SPD_MIN 보장)
    const aiSpd = Math.max(AI_SPD_MIN, Math.hypot(_sVX, _sVY) * AI_DIFFICULTY);
    const tx = Math.max(PAD + 22, Math.min(W - PAD - 22, _sX));
    const ty = Math.max(PAD + 18, Math.min(NET_Y - 18, _sY + 8));
    const dx = tx - _aRacket.x;
    const dy = ty - _aRacket.y;
    const d  = Math.hypot(dx, dy);
    if (d > 0.5) {
      const spd = Math.min(aiSpd, d);
      _aRacket.x += (dx / d) * spd;
      _aRacket.y += (dy / d) * spd;
    }
    _aRacket.x = Math.max(PAD + 20, Math.min(W - PAD - 20, _aRacket.x));
    _aRacket.y = Math.max(PAD + 14, Math.min(NET_Y - 14, _aRacket.y));
  }

  // ── 히트 이펙트 ──
  const _flashes = [];
  function _flashHit(x, y, color) {
    _flashes.push({ x, y, color, r: 0, alpha: 0.8, maxR: P_HIT_R + 10 });
  }
  function _updateFlashes() {
    for (let i = _flashes.length - 1; i >= 0; i--) {
      const f = _flashes[i];
      f.r     += 3;
      f.alpha -= 0.07;
      if (f.alpha <= 0) _flashes.splice(i, 1);
    }
  }

  // ── 메인 틱 ──

  function _tick() {
    _rafId = null;
    if (_ended) return;

    if (_pHitCd > 0) _pHitCd--;
    if (_aHitCd > 0) _aHitCd--;


    if (_sActive) {
      if (_phase === 'rally') {
        // 중력: 각 진영 백벽 쪽으로
        _sVY += _sY > NET_Y ? GRAVITY : -GRAVITY;

        // 감속
        _sVX *= DECEL;
        _sVY *= DECEL;

        _sX += _sVX;
        _sY += _sVY;

        // 좌우 벽 반사
        if (_sX - SHUTTLE_R < PAD) {
          _sX = PAD + SHUTTLE_R;
          _sVX = Math.abs(_sVX) * 0.65;
        }
        if (_sX + SHUTTLE_R > W - PAD) {
          _sX = W - PAD - SHUTTLE_R;
          _sVX = -Math.abs(_sVX) * 0.65;
        }

        // 아웃 판정
        if (_sY > H + 12) { _awardPoint('ai'); }
        else if (_sY < -12) { _awardPoint('player'); }

        // 네트 통과 후 역방향으로 돌아오는 셔틀 아웃 처리
        // 플레이어가 쳤는데 다시 플레이어 쪽으로 내려오면 → 네트 안친 것
        else if (_lastHitter === 'player' && _sY > NET_Y + 5 && _sVY > 0) {
          _awardPoint('ai');
        } else if (_lastHitter === 'ai' && _sY < NET_Y - 5 && _sVY < 0) {
          _awardPoint('player');
        }

        // 플레이어 히트 판정
        if (_sY > NET_Y && _pHitCd === 0 && _dragging) {
          const dp = Math.hypot(_sX - _pRacket.x, _sY - _pRacket.y);
          if (dp < P_HIT_R) _playerHit();
        }

        // AI 히트 판정
        if (_sY < NET_Y && _aHitCd === 0) {
          const da = Math.hypot(_sX - _aRacket.x, _sY - _aRacket.y);
          if (da < A_HIT_R) _aiHit();
        }

      } else if (_phase === 'serve_wait' && _serving === 'player') {
        // 플레이어 서브 대기 중 — 드래그해서 셔틀에 닿으면 발사
        if (_dragging) {
          const dp = Math.hypot(_sX - _pRacket.x, _sY - _pRacket.y);
          if (dp < P_HIT_R) _playerHit();
        }
      }
    }

    _updateAI();
    _updateFlashes();
    _updateMsgAlpha();
    _render();

    _rafId = requestAnimationFrame(_tick);
  }

  // ── 득점 처리 ──

  function _awardPoint(winner) {
    if (_ended || _phase === 'point_pause') return;
    _phase   = 'point_pause';
    _sActive = false;

    if (winner === 'player') {
      _pScore++;
      _onScore && _onScore(20);
      _showMsg(_pScore >= TARGET ? '🏆 승리!' : `득점! ${_pScore} : ${_aScore}`);
    } else {
      _aScore++;
      _showMsg(_aScore >= TARGET ? '💀 패배...' : `실점 ${_pScore} : ${_aScore}`);
    }

    if (_pScore >= TARGET) {
      _stopTimer();
      _render();
      _ended = true;
      _pointTO = setTimeout(() => { if (_onSuccess) _onSuccess(); }, 900);
      return;
    }
    if (_aScore >= TARGET) {
      _stopTimer();
      _render();
      _ended = true;
      const _ad = (typeof randomAd === 'function') ? (randomAd('level1') || randomAd('all')) : null;
      if (_ad) { window.open(_ad.landingUrl, '_blank'); }
      if (typeof recordAdClick === 'function') recordAdClick();
      _pointTO = setTimeout(() => { if (_onFail) _onFail('lost'); }, 900);
      return;
    }

    _serving = winner;
    _pointTO = setTimeout(() => {
      if (_ended) return;
      _prepareServe(400);
    }, 1200);
  }

  function _endGame(result) {
    if (_ended) return;
    _ended = true;
    _stopTimer();
    _showMsg(result === 'win' ? '🏆 시간 종료 — 승리!' : '💀 시간 종료 — 패배');
    _render();
    setTimeout(() => {
      if (result === 'win') { if (_onSuccess) _onSuccess(); }
      else                  { if (_onFail)    _onFail('timeout'); }
    }, 900);
  }

  // ── 메시지 ──

  function _showMsg(text) {
    _msg = text; _msgAlpha = 1.0;
  }
  function _updateMsgAlpha() {
    if (_msgAlpha > 0) _msgAlpha = Math.max(0, _msgAlpha - 0.018);
  }

  // ── 렌더링 ──

  const C_BG     = '#09111e';
  const C_COURT_P = '#0c1e38';
  const C_COURT_A = '#1e0c0c';
  const C_LINE    = '#ffffff18';

  function _render() {
    if (!_ctx) return;
    const ctx = _ctx;
    const s   = _scale();
    ctx.clearRect(0, 0, _canvas.width, _canvas.height);
    ctx.save();
    ctx.scale(s.x, s.y);

    // 배경
    ctx.fillStyle = C_BG;
    ctx.fillRect(0, 0, W, H);

    // 코트 — AI쪽 (위)
    ctx.fillStyle = C_COURT_A;
    ctx.fillRect(PAD, PAD, W - PAD * 2, NET_Y - PAD);

    // 코트 — 플레이어쪽 (아래)
    ctx.fillStyle = C_COURT_P;
    ctx.fillRect(PAD, NET_Y, W - PAD * 2, H / 2 - PAD);

    // 코트 테두리
    ctx.strokeStyle = '#ffffff28';
    ctx.lineWidth   = 1.5;
    ctx.strokeRect(PAD, PAD, W - PAD * 2, H - PAD * 2);

    // 중앙선
    ctx.strokeStyle = C_LINE;
    ctx.lineWidth   = 1;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(W / 2, PAD);
    ctx.lineTo(W / 2, H - PAD);
    ctx.stroke();
    ctx.setLineDash([]);

    // 서비스 라인 (각 진영 1/3 지점)
    ctx.strokeStyle = '#ffffff10';
    ctx.lineWidth   = 1;
    [NET_Y - (NET_Y - PAD) * 0.5, NET_Y + (H - PAD - NET_Y) * 0.5].forEach(ly => {
      ctx.beginPath(); ctx.moveTo(PAD, ly); ctx.lineTo(W - PAD, ly); ctx.stroke();
    });

    // 네트
    const nPosts = [PAD - 4, W - PAD + 4];
    nPosts.forEach(px => {
      ctx.fillStyle = '#888';
      ctx.fillRect(px - 3, NET_Y - 9, 6, 18);
    });
    ctx.fillStyle = '#ffffff2a';
    ctx.fillRect(PAD, NET_Y - 3, W - PAD * 2, 6);
    ctx.strokeStyle = '#ffffff50';
    ctx.lineWidth   = 0.8;
    for (let x = PAD; x <= W - PAD; x += 14) {
      ctx.beginPath();
      ctx.moveTo(x, NET_Y - 3);
      ctx.lineTo(x, NET_Y + 3);
      ctx.stroke();
    }

    // 진영 레이블
    ctx.font      = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff1a';
    ctx.fillText('AI', W / 2, NET_Y - 12);
    ctx.fillText('YOU', W / 2, NET_Y + 20);

    // 점수
    const scY = 36;
    ctx.font      = 'bold 32px monospace';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff7766';
    ctx.fillText(_aScore, W / 2 - 18, scY);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff55';
    ctx.font      = 'bold 22px monospace';
    ctx.fillText(':', W / 2, scY - 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#55ff99';
    ctx.font      = 'bold 32px monospace';
    ctx.fillText(_pScore, W / 2 + 22, scY);

    ctx.font      = '9px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff22';
    ctx.fillText(`AI  :  YOU  (${TARGET}점 선취 승리)`, W / 2, scY + 12);

    // 서브 안내
    if (_phase === 'serve_wait' && _serving === 'player') {
      ctx.font      = '13px monospace';
      ctx.fillStyle = '#ffcc44cc';
      ctx.textAlign = 'center';
      const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 280);
      ctx.globalAlpha = pulse;
      ctx.fillText('▼ 라켓을 드래그해서 셔틀을 쳐주세요!', W / 2, NET_Y + 46);
      ctx.globalAlpha = 1;
    }

    // 히트 이펙트
    _flashes.forEach(f => {
      ctx.globalAlpha = f.alpha;
      ctx.strokeStyle = f.color;
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    });

    // AI 라켓
    _drawRacket(ctx, _aRacket.x, _aRacket.y, false);

    // 플레이어 라켓
    _drawRacket(ctx, _pRacket.x, _pRacket.y, true);

    // 셔틀콕
    if (_sActive) _drawShuttle(ctx, _sX, _sY, _sVX, _sVY);

    // 플로팅 메시지
    if (_msgAlpha > 0.02) {
      ctx.globalAlpha = _msgAlpha;
      ctx.font        = 'bold 26px sans-serif';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle   = '#ffffff';
      ctx.shadowColor = '#000';
      ctx.shadowBlur  = 8;
      ctx.fillText(_msg, W / 2, H / 2);
      ctx.shadowBlur  = 0;
      ctx.textBaseline = 'alphabetic';
      ctx.globalAlpha = 1;
    }

    ctx.restore();
  }

  function _drawRacket(ctx, x, y, isPlayer) {
    const col = isPlayer ? '#22ccff' : '#ff6655';
    const hy  = isPlayer ? 1 : -1;

    // 손잡이
    ctx.strokeStyle = col + 'aa';
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y + hy * 9);
    ctx.lineTo(x, y + hy * 25);
    ctx.stroke();
    ctx.lineCap = 'butt';

    // 라켓 헤드
    ctx.strokeStyle = col;
    ctx.lineWidth   = 2.5;
    ctx.beginPath();
    ctx.ellipse(x, y - hy * 2, RACKET_VR, Math.round(RACKET_VR * 0.82), 0, 0, Math.PI * 2);
    ctx.stroke();

    // 줄
    ctx.strokeStyle = col + '44';
    ctx.lineWidth   = 1;
    [-7, 0, 7].forEach(ox => {
      ctx.beginPath();
      ctx.moveTo(x + ox, y - hy * 2 - RACKET_VR * 0.82 + 2);
      ctx.lineTo(x + ox, y - hy * 2 + RACKET_VR * 0.82 - 2);
      ctx.stroke();
    });
    [-6, 0, 6].forEach(oy => {
      ctx.beginPath();
      ctx.moveTo(x - RACKET_VR + 2, y - hy * 2 + oy);
      ctx.lineTo(x + RACKET_VR - 2, y - hy * 2 + oy);
      ctx.stroke();
    });

    // 히트 범위 (드래그 중일 때만 플레이어)
    if (isPlayer && _dragging) {
      const g = ctx.createRadialGradient(x, y, 4, x, y, P_HIT_R);
      g.addColorStop(0, col + '22');
      g.addColorStop(1, col + '00');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, P_HIT_R, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function _drawShuttle(ctx, x, y, vx, vy) {
    // 속도 방향에 따라 기울이기
    const angle = vy !== 0 ? Math.atan2(vy, vx) - Math.PI / 2 : 0;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);

    // 깃털
    ctx.fillStyle = '#ffffffcc';
    ctx.beginPath();
    ctx.moveTo(0, -SHUTTLE_R * 2.4);
    ctx.lineTo(-SHUTTLE_R * 1.15, 0);
    ctx.lineTo(SHUTTLE_R * 1.15, 0);
    ctx.closePath();
    ctx.fill();

    // 깃털 선
    ctx.strokeStyle = '#ffffff55';
    ctx.lineWidth   = 0.8;
    [-SHUTTLE_R * 0.6, 0, SHUTTLE_R * 0.6].forEach(ox => {
      ctx.beginPath();
      ctx.moveTo(ox, 0);
      ctx.lineTo(ox * 0.5, -SHUTTLE_R * 2);
      ctx.stroke();
    });

    // 코르크
    const cg = ctx.createRadialGradient(-SHUTTLE_R * 0.3, SHUTTLE_R * 0.2, 1, 0, SHUTTLE_R * 0.3, SHUTTLE_R * 0.9);
    cg.addColorStop(0, '#ffe8aa');
    cg.addColorStop(1, '#cc8833');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(0, SHUTTLE_R * 0.3, SHUTTLE_R * 0.9, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
  }

  // ── 입력 이벤트 ──

  function _evPos(e) {
    const t = e.touches ? e.touches[0] : e;
    return _toLogi(t.clientX, t.clientY);
  }

  function _onDown(e) {
    if (_ended) return;
    e.preventDefault();
    const p    = _evPos(e);
    const dist = Math.hypot(p.x - _pRacket.x, p.y - _pRacket.y);
    if (dist < P_HIT_R + 28) {
      _dragging = true;
      _dragOX   = p.x - _pRacket.x;
      _dragOY   = p.y - _pRacket.y;
      _prevDX   = p.x;
      _prevDY   = p.y;
      _pvx = 0; _pvy = 0;
    }
  }

  function _onMove(e) {
    if (!_dragging || _ended) return;
    e.preventDefault();
    const p = _evPos(e);
    _pvx    = (p.x - _prevDX) * 0.7 + _pvx * 0.3;
    _pvy    = (p.y - _prevDY) * 0.7 + _pvy * 0.3;
    _prevDX = p.x;
    _prevDY = p.y;
    _pRacket.x = Math.max(PAD + 20, Math.min(W - PAD - 20, p.x - _dragOX));
    _pRacket.y = Math.max(NET_Y + 12, Math.min(H - PAD - 22, p.y - _dragOY));
  }

  function _onUp() {
    if (_dragging) {
      _pvx *= 0.5;
      _pvy *= 0.5;
    }
    _dragging = false;
  }

  function _addListeners() {
    _canvas.addEventListener('mousedown',  _onDown, { passive: false });
    _canvas.addEventListener('mousemove',  _onMove, { passive: false });
    window .addEventListener('mouseup',    _onUp);
    _canvas.addEventListener('touchstart', _onDown, { passive: false });
    _canvas.addEventListener('touchmove',  _onMove, { passive: false });
    _canvas.addEventListener('touchend',   _onUp);
    _canvas.addEventListener('touchcancel',_onUp);
  }

  function _removeListeners() {
    _canvas.removeEventListener('mousedown',   _onDown);
    _canvas.removeEventListener('mousemove',   _onMove);
    window .removeEventListener('mouseup',     _onUp);
    _canvas.removeEventListener('touchstart',  _onDown);
    _canvas.removeEventListener('touchmove',   _onMove);
    _canvas.removeEventListener('touchend',    _onUp);
    _canvas.removeEventListener('touchcancel', _onUp);
  }

  // ── 정리 ──

  function _cleanup() {
    _ended = true;
    _stopTimer();
    if (_rafId)   { cancelAnimationFrame(_rafId); _rafId  = null; }
    if (_serveTO) { clearTimeout(_serveTO); _serveTO = null; }
    if (_pointTO) { clearTimeout(_pointTO); _pointTO = null; }
    if (_canvas)  _removeListeners();
    if (_area)    { _area.style.width = ''; _area.style.height = ''; _area.style.aspectRatio = ''; }
  }

  // ── Public API ──

  function start(area, onScore, onSuccess, onFail) {
    _cleanup();

    _area      = area;
    _onScore   = onScore;
    _onSuccess = onSuccess;
    _onFail    = onFail;
    _ended     = false;

    _pScore = 0; _aScore = 0;
    _serving = 'player';
    _phase   = 'idle';
    _msg     = ''; _msgAlpha = 0;
    _sActive = false;
    _pHitCd  = 0; _aHitCd = 0;
    _lastHitter = null;
    _dragging = false; _pvx = 0; _pvy = 0;
    _pRacket  = { x: W / 2, y: H - 72 };
    _aRacket  = { x: W / 2, y: 72 };
    _flashes.length = 0;

    area.style.width       = `min(${W}px, 90vw)`;
    area.style.height      = 'auto';
    area.style.aspectRatio = `${W} / ${H}`;
    area.style.position = 'relative';
    area.innerHTML      = '';

    _canvas = document.createElement('canvas');
    _canvas.width  = W;
    _canvas.height = H;
    _canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;' +
      'touch-action:none;border-radius:12px;cursor:grab;display:block;';
    area.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    const hint = document.createElement('div');
    hint.style.cssText =
      'position:absolute;bottom:5px;left:0;right:0;text-align:center;' +
      'color:#ffffff1e;font-size:0.7rem;pointer-events:none;user-select:none;';
    hint.textContent = '라켓 근처를 드래그 → 셔틀이 범위 안에 들어오면 자동 히트';
    area.appendChild(hint);

    _timerEl = document.getElementById('timer-display');
    _addListeners();
    _startTimer();
    _prepareServe(300);
    _rafId = requestAnimationFrame(_tick);

    return _cleanup;
  }

  return { start };
})();
