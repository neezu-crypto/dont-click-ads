// Dodge mini-game module — 드래그로 이동하며 탄막 회피, 20초 생존
const DodgeModule = (() => {
  'use strict';

  // ── 상수 ──
  const W = 720, H = 1000;             // 논리적 캔버스 크기
  const SURVIVE_SEC = 20;
  const PLAYER_R = 22;
  const PLAYER_SPEED = 460;            // px/s — 자연스러운 일정 속도
  const ENEMY_R = 14;
  const AD_R = 28;
  const ENEMY_SPEED_MIN = 160;
  const ENEMY_SPEED_MAX = 240;
  const AD_SPEED_MIN = 130;
  const AD_SPEED_MAX = 190;

  // 스폰 주기
  const NORMAL_SPAWN_INTERVAL = 1.0;   // 1초마다 일반 탄막 1개
  const EXTRA_SPAWN_INTERVAL  = 3.0;   // 3초마다 추가 탄막 1개
  const AD_SPAWN_INTERVAL_MIN = 4.0;
  const AD_SPAWN_INTERVAL_MAX = 6.0;

  // ── 상태 ──
  let _area = null, _canvas = null, _ctx = null;
  let _onSuccess = null, _onFail = null;
  let _ended = false;
  let _rafId = 0, _lastTime = 0;
  let _elapsed = 0;
  let _countdown = 3, _countdownTimer = 0, _started = false;

  let _player = null;
  let _dragTarget = null; // {x, y} or null — 드래그 중일 때만 설정
  let _enemies = [];
  let _ads = [];
  let _normalSpawnTimer = 0;
  let _extraSpawnTimer = 0;
  let _adSpawnTimer = 0;
  let _nextAdInterval = AD_SPAWN_INTERVAL_MIN;

  let _adImgCache = {};

  // UI
  let _uiOverlay = null;
  let _timerEl = null;
  let _countdownEl = null;

  // ── 사운드 (shooter.js와 동일 패턴) ──
  let _audioCtx = null;
  function _getAudioCtx() {
    if (_audioCtx) return _audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      _audioCtx = new Ctx();
    } catch (e) { return null; }
    return _audioCtx;
  }
  function _playBeep(freq, dur, vol, type) {
    const ctx = _getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type || 'sine';
    osc.frequency.value = freq;
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + dur);
  }

  // ── 좌표 변환 ──
  function _toLogical(clientX, clientY) {
    const rect = _canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * W / rect.width,
      y: (clientY - rect.top) * H / rect.height,
    };
  }

  // ── 입력 (드래그 중에만 이동) ──
  function _onPointerDown(e) {
    e.preventDefault();
    _setDragTarget(e);
  }
  function _onPointerMove(e) {
    if (!_dragTarget) return;
    e.preventDefault();
    _setDragTarget(e);
  }
  function _onPointerUp(e) {
    // 드래그 끝나면 이동 정지 (목표 위치 해제)
    _dragTarget = null;
  }
  function _setDragTarget(e) {
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    const p = _toLogical(t.clientX, t.clientY);
    _dragTarget = { x: p.x, y: p.y };
  }

  // ── 스폰 ──
  function _randomEdgeSpawn() {
    // 화면 4면 중 한 곳에서 스폰. 플레이어 쪽 방향으로 약간 흩어진 각도.
    const side = Math.floor(Math.random() * 4);
    let x, y;
    if (side === 0)      { x = Math.random() * W;  y = -30; }       // 위
    else if (side === 1) { x = W + 30;             y = Math.random() * H; }  // 오른
    else if (side === 2) { x = Math.random() * W;  y = H + 30; }    // 아래
    else                 { x = -30;                y = Math.random() * H; }  // 왼
    return { x, y };
  }

  function _spawnEnemy() {
    const { x, y } = _randomEdgeSpawn();
    // 플레이어 위치 기준으로 약간 분산된 목표
    const tx = _player.x + (Math.random() - 0.5) * 250;
    const ty = _player.y + (Math.random() - 0.5) * 250;
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = ENEMY_SPEED_MIN + Math.random() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN);
    _enemies.push({
      x, y,
      vx: dx / len * speed,
      vy: dy / len * speed,
      r: ENEMY_R,
      pulse: Math.random() * Math.PI * 2,
    });
  }

  function _spawnAd() {
    const { x, y } = _randomEdgeSpawn();
    // 광고도 플레이어 방향으로 날아옴 (피하는 게 메인이므로 직접 노려도 OK)
    const tx = _player.x + (Math.random() - 0.5) * 200;
    const ty = _player.y + (Math.random() - 0.5) * 200;
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = AD_SPEED_MIN + Math.random() * (AD_SPEED_MAX - AD_SPEED_MIN);
    const ad = (typeof randomAd === 'function') ? randomAd() : null;
    let img = null;
    if (ad && ad.imgUrl) {
      if (window._preloadedImgs && window._preloadedImgs[ad.imgUrl]) {
        img = window._preloadedImgs[ad.imgUrl];
      } else if (_adImgCache[ad.imgUrl]) {
        img = _adImgCache[ad.imgUrl];
      } else {
        img = new Image();
        img.src = ad.imgUrl;
        _adImgCache[ad.imgUrl] = img;
      }
    }
    _ads.push({
      x, y,
      vx: dx / len * speed,
      vy: dy / len * speed,
      r: AD_R,
      pulse: Math.random() * Math.PI * 2,
      ad, img,
    });
  }

  // ── 업데이트 ──
  function _update(dt) {
    // 플레이어 이동: 드래그 타겟이 있으면 일정 속도로 추적
    if (_dragTarget) {
      const dx = _dragTarget.x - _player.x;
      const dy = _dragTarget.y - _player.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1) {
        const step = PLAYER_SPEED * dt;
        if (step >= dist) {
          // 목표에 도달 — 그 위치에 정지
          _player.x = _dragTarget.x;
          _player.y = _dragTarget.y;
        } else {
          _player.x += dx / dist * step;
          _player.y += dy / dist * step;
        }
      }
      // 화면 밖으로 못 나가게 클램프
      _player.x = Math.max(PLAYER_R, Math.min(W - PLAYER_R, _player.x));
      _player.y = Math.max(PLAYER_R, Math.min(H - PLAYER_R, _player.y));
    }

    // 스폰
    _normalSpawnTimer += dt;
    while (_normalSpawnTimer >= NORMAL_SPAWN_INTERVAL) {
      _normalSpawnTimer -= NORMAL_SPAWN_INTERVAL;
      _spawnEnemy();
    }
    _extraSpawnTimer += dt;
    while (_extraSpawnTimer >= EXTRA_SPAWN_INTERVAL) {
      _extraSpawnTimer -= EXTRA_SPAWN_INTERVAL;
      _spawnEnemy();
    }
    _adSpawnTimer += dt;
    while (_adSpawnTimer >= _nextAdInterval) {
      _adSpawnTimer -= _nextAdInterval;
      _spawnAd();
      _nextAdInterval = AD_SPAWN_INTERVAL_MIN +
        Math.random() * (AD_SPAWN_INTERVAL_MAX - AD_SPAWN_INTERVAL_MIN);
    }

    // 적/광고 이동
    for (const e of _enemies) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.pulse += dt * 8;
    }
    for (const a of _ads) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.pulse += dt * 4;
    }

    // 충돌: 플레이어 vs 적/광고
    for (const e of _enemies) {
      const dx = e.x - _player.x, dy = e.y - _player.y;
      if (dx * dx + dy * dy < (e.r + PLAYER_R) * (e.r + PLAYER_R)) {
        _failByHit();
        return;
      }
    }
    for (const a of _ads) {
      const dx = a.x - _player.x, dy = a.y - _player.y;
      if (dx * dx + dy * dy < (a.r + PLAYER_R) * (a.r + PLAYER_R)) {
        _failByAdHit(a);
        return;
      }
    }

    // 화면 밖 정리 (충분히 멀리 나간 것만)
    _enemies = _enemies.filter(e =>
      e.x > -100 && e.x < W + 100 && e.y > -100 && e.y < H + 100);
    _ads = _ads.filter(a =>
      a.x > -100 && a.x < W + 100 && a.y > -100 && a.y < H + 100);

    // 시간 갱신
    _elapsed += dt;
    if (_timerEl) {
      const remain = Math.max(0, SURVIVE_SEC - _elapsed);
      _timerEl.textContent = remain.toFixed(1);
    }
    if (_elapsed >= SURVIVE_SEC) {
      _win();
    }
  }

  // ── 그리기 ──
  function _draw() {
    const ctx = _ctx;
    // 배경
    ctx.fillStyle = '#0a0a14';
    ctx.fillRect(0, 0, W, H);
    // 격자
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 60) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 드래그 타겟 표시 (이동 목표점)
    if (_dragTarget && _started) {
      ctx.strokeStyle = '#22ddff66';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(_player.x, _player.y);
      ctx.lineTo(_dragTarget.x, _dragTarget.y);
      ctx.stroke();
      ctx.setLineDash([]);
      // 목표점 마커
      ctx.strokeStyle = '#22ddffaa';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(_dragTarget.x, _dragTarget.y, 16, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 적 탄막 (노란)
    for (const e of _enemies) {
      const glow = 0.7 + Math.sin(e.pulse) * 0.3;
      ctx.fillStyle = '#ffdd33';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 14 * glow;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff8c0';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 광고 탄막
    for (const a of _ads) {
      const pulse = 0.6 + Math.sin(a.pulse) * 0.4;
      ctx.shadowColor = '#ff3344';
      ctx.shadowBlur = 24 * pulse;
      ctx.fillStyle = '#1a0508';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.save();
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.clip();
      if (a.img && a.img.complete && a.img.naturalWidth > 0) {
        ctx.drawImage(a.img, a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
      } else {
        ctx.fillStyle = '#ff6677';
        ctx.fillRect(a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 28px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔗', a.x, a.y);
      }
      ctx.restore();

      ctx.strokeStyle = '#ff3344';
      ctx.lineWidth = 3 + pulse * 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.stroke();

      // AD 라벨
      ctx.fillStyle = '#ff3344';
      ctx.fillRect(a.x - 14, a.y - a.r - 18, 28, 14);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AD', a.x, a.y - a.r - 11);
    }

    // 플레이어 (원형 + 안쪽 코어)
    ctx.save();
    ctx.translate(_player.x, _player.y);
    ctx.fillStyle = '#22ddff';
    ctx.shadowColor = '#22ddff';
    ctx.shadowBlur = 22;
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 카운트다운 중 어둡게
    if (!_started) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ── 메인 루프 ──
  function _tick(ts) {
    if (_ended) return;
    if (!_lastTime) _lastTime = ts;
    let dt = (ts - _lastTime) / 1000;
    _lastTime = ts;
    if (dt > 0.05) dt = 0.05;

    if (!_started) {
      _countdownTimer += dt;
      if (_countdownTimer >= 1) {
        _countdownTimer = 0;
        _countdown--;
        if (_countdown <= 0) {
          _started = true;
          if (_countdownEl) {
            _countdownEl.textContent = 'GO!';
            _playBeep(880, 0.5, 0.25, 'square');
            setTimeout(() => { if (_countdownEl) _countdownEl.style.display = 'none'; }, 600);
          }
        } else {
          if (_countdownEl) _countdownEl.textContent = String(_countdown);
          _playBeep(440, 0.18, 0.2, 'square');
        }
      }
    } else {
      _update(dt);
    }
    _draw();
    if (!_ended) _rafId = requestAnimationFrame(_tick);
  }

  // ── 종료 처리 ──
  function _win() {
    if (_ended) return;
    _ended = true;
    cancelAnimationFrame(_rafId);
    _playBeep(660, 0.15, 0.2, 'square');
    setTimeout(() => _playBeep(880, 0.3, 0.2, 'square'), 120);
    setTimeout(() => { if (_onSuccess) _onSuccess(); }, 600);
  }

  function _failByHit() {
    if (_ended) return;
    _ended = true;
    cancelAnimationFrame(_rafId);
    _playBeep(160, 0.4, 0.25, 'sawtooth');
    setTimeout(() => { if (_onFail) _onFail('lost'); }, 400);
  }

  function _failByAdHit(adObj) {
    if (_ended) return;
    _ended = true;
    cancelAnimationFrame(_rafId);
    _playBeep(120, 0.5, 0.25, 'sawtooth');
    if (adObj && adObj.ad && adObj.ad.landingUrl) {
      window.open(adObj.ad.landingUrl, '_blank');
    }
    setTimeout(() => { if (_onFail) _onFail('ad-click'); }, 400);
  }

  // ── 정리 ──
  function _cleanup() {
    _ended = true;
    cancelAnimationFrame(_rafId);
    if (_canvas) {
      _canvas.removeEventListener('mousedown', _onPointerDown);
      _canvas.removeEventListener('mousemove', _onPointerMove);
      _canvas.removeEventListener('touchstart', _onPointerDown);
      _canvas.removeEventListener('touchmove', _onPointerMove);
    }
    window.removeEventListener('mouseup', _onPointerUp);
    window.removeEventListener('touchend', _onPointerUp);
    if (_area) _area.innerHTML = '';
    _enemies = []; _ads = [];
    _dragTarget = null;
    _adImgCache = {};
  }

  // ── 시작 ──
  // 시그니처는 다른 모듈들과 통일: (area, onScore, onSuccess, onFail)
  function start(area, onScore, onSuccess, onFail) {
    _cleanup();
    _ended = false;
    _area = area;
    _onSuccess = onSuccess;
    _onFail = onFail;
    _elapsed = 0;
    _lastTime = 0;
    _normalSpawnTimer = 0;
    _extraSpawnTimer = 0;
    _adSpawnTimer = 0;
    _nextAdInterval = AD_SPAWN_INTERVAL_MIN;
    _enemies = []; _ads = [];
    _dragTarget = null;
    _countdown = 3;
    _countdownTimer = 0;
    _started = false;

    _player = { x: W / 2, y: H / 2 };

    area.innerHTML = '';
    area.style.position = 'relative';
    area.style.overflow = 'hidden';
    area.style.background = '#0a0a14';

    // 캔버스
    _canvas = document.createElement('canvas');
    _canvas.width = W;
    _canvas.height = H;
    _canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;display:block;';
    area.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    // UI 오버레이
    _uiOverlay = document.createElement('div');
    _uiOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
    area.appendChild(_uiOverlay);

    // 타이머
    _timerEl = document.createElement('div');
    _timerEl.style.cssText = `
      position:absolute;top:14px;left:50%;transform:translateX(-50%);
      font-size:2.2rem;font-weight:900;color:#22ddff;
      text-shadow:0 0 16px #22ddff88;
      font-family:'Courier New',monospace;
    `;
    _timerEl.textContent = SURVIVE_SEC.toFixed(1);
    _uiOverlay.appendChild(_timerEl);

    // 안내
    const hint = document.createElement('div');
    hint.style.cssText = `
      position:absolute;bottom:14px;left:0;right:0;text-align:center;
      color:#ffffff;font-size:0.75rem;pointer-events:none;user-select:none;
    `;
    hint.textContent = '드래그로 이동 — 20초 동안 탄막을 피하세요. 광고는 절대 닿지 마세요!';
    _uiOverlay.appendChild(hint);

    // 카운트다운
    _countdownEl = document.createElement('div');
    _countdownEl.style.cssText = `
      position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
      font-size:5rem;font-weight:900;color:#fff;
      text-shadow:0 0 30px #ff8800,0 0 60px #ff440088;
      pointer-events:none;user-select:none;z-index:20;
    `;
    _countdownEl.textContent = '3';
    _uiOverlay.appendChild(_countdownEl);
    _playBeep(440, 0.18, 0.2, 'square');

    // 입력
    _canvas.addEventListener('mousedown', _onPointerDown);
    _canvas.addEventListener('mousemove', _onPointerMove);
    _canvas.addEventListener('touchstart', _onPointerDown, { passive: false });
    _canvas.addEventListener('touchmove', _onPointerMove, { passive: false });
    window.addEventListener('mouseup', _onPointerUp);
    window.addEventListener('touchend', _onPointerUp);

    _rafId = requestAnimationFrame(_tick);
    return _cleanup;
  }

  return { start };
})();
