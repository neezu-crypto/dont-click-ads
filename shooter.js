// Shooter mini-game module — 자동 발사 + 드래그 조준 + 광고 탄막 회피
const ShooterModule = (() => {
  'use strict';

  // ── 상수 ──
  const W = 720, H = 1000;             // 논리적 캔버스 크기 (CSS로 스케일)
  const SURVIVE_SEC = 20;              // 승리 조건: 20초 버티기
  const PLAYER_Y = H - 110;            // 플레이어 Y 위치
  const PLAYER_R = 22;                 // 플레이어 충돌 반경
  const AIM_RANGE = Math.PI * 80 / 180;  // 조준 가능 범위 ±80°
  const FIRE_INTERVAL = 0.25;          // 자동 발사 주기 (초)
  const BULLET_SPEED = 720;            // 플레이어 총알 속도 (px/s)
  const ENEMY_SPEED_MIN = 140;         // 적 탄막 속도 최소
  const ENEMY_SPEED_MAX = 220;         // 적 탄막 속도 최대
  const AD_SPEED_MIN = 110;
  const AD_SPEED_MAX = 170;
  const AD_RADIUS = 28;
  const ENEMY_RADIUS = 14;

  // ── 상태 ──
  let _area = null, _canvas = null, _ctx = null;
  let _onSuccess = null, _onFail = null;
  let _ended = false;
  let _rafId = 0, _lastTime = 0;
  let _elapsed = 0;
  let _countdown = 3, _countdownTimer = 0, _started = false;

  let _player = null;
  let _aimAngle = 0;     // -π/2 = 위쪽 (기본). -π/2 ± AIM_RANGE
  let _fireTimer = 0;
  let _bullets = [];     // 플레이어 총알
  let _enemies = [];     // 적 탄막
  let _ads = [];         // 광고 탄막
  let _spawnTimer = 0;
  let _adSpawnTimer = 0;

  let _dragging = false;
  let _adImgCache = {};  // 광고 이미지 캐시

  // UI
  let _uiOverlay = null;
  let _timerEl = null;
  let _countdownEl = null;

  // 사운드 (racing.js와 동일 패턴)
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

  // ── 좌표 변환 (실 픽셀 → 논리 좌표) ──
  function _toLogical(clientX, clientY) {
    const rect = _canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) * W / rect.width,
      y: (clientY - rect.top) * H / rect.height,
    };
  }

  // ── 입력 ──
  function _onPointerDown(e) {
    e.preventDefault();
    _dragging = true;
    _updateAim(e);
  }
  function _onPointerMove(e) {
    if (!_dragging) return;
    e.preventDefault();
    _updateAim(e);
  }
  function _onPointerUp(e) {
    _dragging = false;
  }
  function _updateAim(e) {
    const t = e.touches ? e.touches[0] : e;
    if (!t) return;
    const p = _toLogical(t.clientX, t.clientY);
    const dx = p.x - _player.x;
    const dy = p.y - _player.y;
    let ang = Math.atan2(dy, dx);
    // 위쪽 반구만 허용 (dy < 0). 아래쪽 드래그는 좌/우 끝으로 클램프
    const upRef = -Math.PI / 2;
    let diff = ang - upRef;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    if (diff > AIM_RANGE) diff = AIM_RANGE;
    if (diff < -AIM_RANGE) diff = -AIM_RANGE;
    _aimAngle = upRef + diff;
  }

  // ── 스폰 ──
  function _spawnEnemy() {
    // 화면 위쪽에서 랜덤 X로 등장, 플레이어 방향으로 비스듬히 날아옴
    const x = 60 + Math.random() * (W - 120);
    const y = -20;
    // 플레이어 쪽으로 살짝 유도하되 랜덤 분산
    const tx = _player.x + (Math.random() - 0.5) * 300;
    const ty = _player.y;
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy);
    const speed = ENEMY_SPEED_MIN + Math.random() * (ENEMY_SPEED_MAX - ENEMY_SPEED_MIN);
    _enemies.push({
      x, y,
      vx: dx / len * speed,
      vy: dy / len * speed,
      r: ENEMY_RADIUS,
      pulse: Math.random() * Math.PI * 2,
    });
  }

  function _spawnAd() {
    const x = 80 + Math.random() * (W - 160);
    const y = -30;
    // 광고는 플레이어를 직접 노리지 않음 — 플레이어를 빗겨가는 좌/우 경로로 진행.
    // 화면 하단 좌우 끝(플레이어 X에서 안전 거리 이상 떨어진 지점)을 목표로 설정.
    const SAFE_GAP = PLAYER_R + AD_RADIUS + 60; // 플레이어와 닿지 않는 최소 가로 간격
    // 좌/우 둘 중 가능한 쪽 선택 (가능하면 더 멀리 빗겨가는 쪽)
    const leftTargetMax  = _player.x - SAFE_GAP;
    const rightTargetMin = _player.x + SAFE_GAP;
    let tx;
    if (leftTargetMax < 0 && rightTargetMin > W) {
      // 둘 다 불가능한 극단적 경우 (플레이어가 화면 가운데 있고 화면이 너무 좁을 때) — 그냥 가장 먼 쪽
      tx = _player.x < W / 2 ? W + 50 : -50;
    } else if (leftTargetMax < 0) {
      // 왼쪽 빗기기 불가 → 무조건 오른쪽
      tx = rightTargetMin + Math.random() * (W - rightTargetMin + 80);
    } else if (rightTargetMin > W) {
      // 오른쪽 빗기기 불가 → 무조건 왼쪽
      tx = -80 + Math.random() * (leftTargetMax + 80);
    } else {
      // 양쪽 다 가능 → 스폰 X와 가까운 쪽으로 비스듬히
      const goLeft = (x < _player.x) ? Math.random() < 0.7 : Math.random() < 0.3;
      tx = goLeft
        ? -80 + Math.random() * (leftTargetMax + 80)
        : rightTargetMin + Math.random() * (W - rightTargetMin + 80);
    }
    const ty = H + 50; // 화면 아래로 빠져나감
    const dx = tx - x, dy = ty - y;
    const len = Math.hypot(dx, dy);
    const speed = AD_SPEED_MIN + Math.random() * (AD_SPEED_MAX - AD_SPEED_MIN);
    const ad = (typeof randomAd === 'function') ? randomAd() : null;
    // 이미지 사전 로드 시도
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
      r: AD_RADIUS,
      pulse: Math.random() * Math.PI * 2,
      ad, img,
    });
  }

  // ── 업데이트 ──
  function _update(dt) {
    // 자동 발사
    _fireTimer += dt;
    while (_fireTimer >= FIRE_INTERVAL) {
      _fireTimer -= FIRE_INTERVAL;
      _bullets.push({
        x: _player.x,
        y: _player.y - 8,
        vx: Math.cos(_aimAngle) * BULLET_SPEED,
        vy: Math.sin(_aimAngle) * BULLET_SPEED,
        r: 5,
      });
      _playBeep(720, 0.04, 0.06, 'square');
    }

    // 스폰 — 시간이 갈수록 빈도 증가
    const difficulty = 1 + _elapsed / 10;  // 0초 = 1.0배, 20초 = 3.0배
    _spawnTimer += dt;
    const spawnInterval = Math.max(0.25, 0.85 / difficulty);
    while (_spawnTimer >= spawnInterval) {
      _spawnTimer -= spawnInterval;
      _spawnEnemy();
    }

    _adSpawnTimer += dt;
    const adSpawnInterval = Math.max(2.5, 4.5 / Math.sqrt(difficulty));
    while (_adSpawnTimer >= adSpawnInterval) {
      _adSpawnTimer -= adSpawnInterval;
      _spawnAd();
    }

    // 총알 이동
    for (const b of _bullets) {
      b.x += b.vx * dt;
      b.y += b.vy * dt;
    }
    _bullets = _bullets.filter(b => b.x > -20 && b.x < W + 20 && b.y > -20 && b.y < H + 20);

    // 적 이동
    for (const e of _enemies) {
      e.x += e.vx * dt;
      e.y += e.vy * dt;
      e.pulse += dt * 8;
    }
    // 광고 이동
    for (const a of _ads) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.pulse += dt * 4;
    }

    // 충돌 체크: 총알 vs 적
    for (let i = _enemies.length - 1; i >= 0; i--) {
      const e = _enemies[i];
      let hit = false;
      for (let j = _bullets.length - 1; j >= 0; j--) {
        const b = _bullets[j];
        const dx = b.x - e.x, dy = b.y - e.y;
        if (dx * dx + dy * dy < (b.r + e.r) * (b.r + e.r)) {
          _bullets.splice(j, 1);
          hit = true;
          break;
        }
      }
      if (hit) {
        _enemies.splice(i, 1);
        _playBeep(440, 0.08, 0.1, 'square');
      }
    }

    // 충돌 체크: 총알 vs 광고 (= 게임오버, 광고 클릭 처리)
    for (let i = _ads.length - 1; i >= 0; i--) {
      const a = _ads[i];
      for (let j = 0; j < _bullets.length; j++) {
        const b = _bullets[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy < (b.r + a.r) * (b.r + a.r)) {
          _failByAdClick(a);
          return;
        }
      }
    }

    // 충돌 체크: 적 vs 플레이어 (광고는 플레이어와 충돌해도 무시 — 빗겨가는 경로로 스폰됨)
    for (const e of _enemies) {
      const dx = e.x - _player.x, dy = e.y - _player.y;
      if (dx * dx + dy * dy < (e.r + PLAYER_R) * (e.r + PLAYER_R)) {
        _failByHit();
        return;
      }
    }

    // 화면 밖으로 나간 적/광고 제거 (아래로 빠져나가면 그냥 사라짐)
    _enemies = _enemies.filter(e => e.y < H + 50 && e.x > -50 && e.x < W + 50);
    _ads = _ads.filter(a => a.y < H + 50 && a.x > -50 && a.x < W + 50);

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
    // 격자 (분위기)
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let x = 0; x < W; x += 60) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    for (let y = 0; y < H; y += 60) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }

    // 조준선
    if (_started) {
      const aimLen = 180;
      const ax = _player.x + Math.cos(_aimAngle) * aimLen;
      const ay = _player.y + Math.sin(_aimAngle) * aimLen;
      ctx.strokeStyle = '#00ffcc55';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(_player.x, _player.y);
      ctx.lineTo(ax, ay);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 플레이어 총알
    for (const b of _bullets) {
      ctx.fillStyle = '#00ffcc';
      ctx.shadowColor = '#00ffcc';
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 적 탄막 (노란색 계열)
    for (const e of _enemies) {
      const glow = 0.7 + Math.sin(e.pulse) * 0.3;
      ctx.fillStyle = '#ffdd33';
      ctx.shadowColor = '#ffaa00';
      ctx.shadowBlur = 14 * glow;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
      // 안쪽 코어
      ctx.fillStyle = '#fff8c0';
      ctx.shadowBlur = 0;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * 0.45, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;

    // 광고 탄막 (붉은 테두리 + 광고 이미지)
    for (const a of _ads) {
      const pulse = 0.6 + Math.sin(a.pulse) * 0.4;
      // 외곽 글로우
      ctx.shadowColor = '#ff3344';
      ctx.shadowBlur = 24 * pulse;
      ctx.fillStyle = '#1a0508';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r + 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 이미지 채우기 (원형 클립)
      ctx.save();
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.clip();
      if (a.img && a.img.complete && a.img.naturalWidth > 0) {
        ctx.drawImage(a.img, a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
      } else {
        // 이미지 없을 때 폴백: 링크 아이콘 느낌
        ctx.fillStyle = '#ff6677';
        ctx.fillRect(a.x - a.r, a.y - a.r, a.r * 2, a.r * 2);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 28px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🔗', a.x, a.y);
      }
      ctx.restore();

      // 붉은 테두리 (펄스)
      ctx.strokeStyle = '#ff3344';
      ctx.lineWidth = 3 + pulse * 2;
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.stroke();

      // "AD" 라벨
      ctx.fillStyle = '#ff3344';
      ctx.fillRect(a.x - 14, a.y - a.r - 18, 28, 14);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 10px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AD', a.x, a.y - a.r - 11);
    }

    // 플레이어
    ctx.save();
    ctx.translate(_player.x, _player.y);
    // 본체
    ctx.fillStyle = '#22ddff';
    ctx.shadowColor = '#22ddff';
    ctx.shadowBlur = 20;
    ctx.beginPath();
    ctx.moveTo(0, -PLAYER_R);
    ctx.lineTo(PLAYER_R * 0.85, PLAYER_R * 0.7);
    ctx.lineTo(0, PLAYER_R * 0.3);
    ctx.lineTo(-PLAYER_R * 0.85, PLAYER_R * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    // 코어
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(0, -2, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 카운트다운 중에는 어둡게
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
    if (dt > 0.05) dt = 0.05;  // 큰 dt 클램프

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
    setTimeout(() => { if (_onFail) _onFail('hit'); }, 400);
  }

  function _failByAdClick(adObj) {
    if (_ended) return;
    _ended = true;
    cancelAnimationFrame(_rafId);
    _playBeep(120, 0.5, 0.25, 'sawtooth');
    if (adObj && adObj.ad && adObj.ad.landingUrl) {
      window.open(adObj.ad.landingUrl, '_blank');
    }
    setTimeout(() => { if (_onFail) _onFail('adclick'); }, 400);
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
    _bullets = []; _enemies = []; _ads = [];
    _adImgCache = {};
  }

  // ── 시작 ──
  // 시그니처는 다른 모듈들과 통일: (area, onScore, onSuccess, onFail)
  // shooter는 점수 개념이 없으므로 onScore는 무시
  function start(area, onScore, onSuccess, onFail) {
    _cleanup();
    _ended = false;
    _area = area;
    _onSuccess = onSuccess;
    _onFail = onFail;
    _elapsed = 0;
    _lastTime = 0;
    _fireTimer = 0;
    _spawnTimer = 0;
    _adSpawnTimer = 0;
    _bullets = []; _enemies = []; _ads = [];
    _aimAngle = -Math.PI / 2;
    _countdown = 3;
    _countdownTimer = 0;
    _started = false;

    _player = { x: W / 2, y: PLAYER_Y };

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

    // 타이머 표시
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
      color:#ffffff44;font-size:0.75rem;pointer-events:none;user-select:none;
    `;
    hint.textContent = '드래그로 조준 — 자동 발사. 광고는 절대 쏘지 마세요!';
    _uiOverlay.appendChild(hint);

    // 카운트다운 표시
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
