// Fortress artillery mini-game module
const FortressModule = (() => {
  'use strict';

  // ── 월드 / 뷰포트 ──
  const WORLD_W  = 1400;
  const WORLD_H  = 460;
  const VIEW_W   = 860;
  const VIEW_H   = 460;
  const N_SEGS   = 71;                        // terrain 점 개수 (인덱스 0~70)
  const SEG_W    = WORLD_W / (N_SEGS - 1);   // ≈ 20 px

  // ── 물리 ──
  const GRAVITY   = 0.22;
  const MAX_POWER = 17;
  const DRAG_MAX  = 110;  // 최대 파워까지의 드래그 거리 (world px)

  // ── 포탑 ──
  const TURRET_X   = 70;
  const TURRET_R   = 16;
  const BARREL_LEN = 26;

  // ── 타겟 ──
  const BULLET_R    = 5;
  const GREEN_R     = 20;
  const TOTAL_GREEN = 3;
  const TOGGLE_MS   = 2000;  // 초록 ↔ 광고 전환 주기 (ms)

  // ── 상태 ──
  let _area, _canvas, _ctx;
  let _onScore, _onSuccess, _onFail;
  let _ended = false;
  let _raf   = null;

  let _terrain   = [];  // terrain[i] = Y at x = i * SEG_W
  let _targets   = [];  // [{x, cy, r, type, hit}]
  let _turretCY  = 0;   // turret center Y (world)

  let _dragging  = false;
  let _dragWX    = 0;   // drag 현재 world X
  let _dragWY    = 0;   // drag 현재 world Y
  let _aimAngle  = -Math.PI / 4;

  let _bullet    = null;   // { x, y, vx, vy }
  let _phase     = 'aim';  // 'aim' | 'flight' | 'cooldown'
  let _phaseMsg  = '';
  let _cooldownTimer = null;

  let _explosion   = null;  // { x, y, t, maxT }
  let _muzzleFlash = null;  // { x, y, t }

  let _camX    = 0;
  let _greenHit = 0;

  // ── 지형 생성 ────────────────────────────────────────────

  function _genTerrain() {
    const nCtrl = 13;
    const ctrl  = [];
    for (let i = 0; i < nCtrl; i++) {
      // 플레이어 영역(왼쪽 2개): 평탄하게
      ctrl.push(i < 2 ? WORLD_H * 0.70 : WORLD_H * (0.42 + Math.random() * 0.32));
    }
    // Catmull-Rom spline
    _terrain = [];
    for (let i = 0; i < N_SEGS; i++) {
      const t  = (i / (N_SEGS - 1)) * (nCtrl - 1);
      const i1 = Math.floor(t);
      const f  = t - i1;
      const p0 = ctrl[Math.max(0, i1 - 1)];
      const p1 = ctrl[i1];
      const p2 = ctrl[Math.min(nCtrl - 1, i1 + 1)];
      const p3 = ctrl[Math.min(nCtrl - 1, i1 + 2)];
      const h  = 0.5 * (2*p1 + (-p0+p2)*f + (2*p0-5*p1+4*p2-p3)*f*f + (-p0+3*p1-3*p2+p3)*f*f*f);
      _terrain.push(Math.max(160, Math.min(WORLD_H - 28, h)));
    }
  }

  function _terrainY(wx) {
    const seg = wx / SEG_W;
    const i0  = Math.floor(seg);
    if (i0 <= 0)              return _terrain[0];
    if (i0 >= N_SEGS - 1)    return _terrain[N_SEGS - 1];
    return _terrain[i0] * (1 - (seg - i0)) + _terrain[i0 + 1] * (seg - i0);
  }

  // ── 타겟 배치 ────────────────────────────────────────────

  function _placeTargets() {
    _targets = [];
    const minX = 450, maxX = WORLD_W - 90;
    const xs   = [];
    let tries  = 0;
    while (xs.length < TOTAL_GREEN && tries < 1000) {
      tries++;
      const wx = minX + Math.random() * (maxX - minX);
      if (xs.every(x => Math.abs(x - wx) > 115)) xs.push(wx);
    }

    const now = Date.now();
    xs.forEach((wx, i) => {
      _targets.push({
        x:           wx,
        cy:          _terrainY(wx) - GREEN_R,
        r:           GREEN_R,
        hit:         false,
        isAd:        false,
        // 각 타겟마다 위상 오프셋 — 처음엔 모두 초록, 1~2초 후 순차적으로 AD로 전환
        phaseOffset: now - Math.floor((i / TOTAL_GREEN) * TOGGLE_MS + 200),
      });
    });
  }

  // 매 프레임 타겟 상태(초록/AD) 업데이트
  function _updateTargetStates() {
    const now = Date.now();
    _targets.forEach(t => {
      if (!t.hit) t.isAd = Math.floor((now - t.phaseOffset) / TOGGLE_MS) % 2 === 1;
    });
  }

  // ── 드로우 함수 ───────────────────────────────────────────

  function _drawSky() {
    const g = _ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#07090f');
    g.addColorStop(1, '#0d1828');
    _ctx.fillStyle = g;
    _ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    // Stars (deterministic)
    _ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (let i = 0; i < 55; i++) {
      const sx = ((i * 137 + 29) % 1000) / 1000 * VIEW_W;
      const sy = ((i * 71  + 13) % 1000) / 1000 * (VIEW_H * 0.55);
      const sr = 0.7 + (i % 3) * 0.3;
      _ctx.beginPath();
      _ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      _ctx.fill();
    }
  }

  function _drawTerrain() {
    const ctx = _ctx;
    ctx.save();
    // Fill polygon
    ctx.beginPath();
    ctx.moveTo(0, WORLD_H);
    for (let i = 0; i < N_SEGS; i++) ctx.lineTo(i * SEG_W, _terrain[i]);
    ctx.lineTo(WORLD_W, WORLD_H);
    ctx.closePath();
    const g = ctx.createLinearGradient(0, 160, 0, WORLD_H);
    g.addColorStop(0, '#2a5218');
    g.addColorStop(0.4, '#1e3d10');
    g.addColorStop(1,   '#0e1f08');
    ctx.fillStyle = g;
    ctx.fill();
    // Grass edge
    ctx.beginPath();
    ctx.moveTo(0, _terrain[0]);
    for (let i = 1; i < N_SEGS; i++) ctx.lineTo(i * SEG_W, _terrain[i]);
    ctx.strokeStyle = '#66cc33';
    ctx.lineWidth   = 3;
    ctx.stroke();
    ctx.restore();
  }

  function _drawTurret() {
    const ctx   = _ctx;
    const angle = _aimAngle;
    ctx.save();
    // Shadow
    ctx.beginPath();
    ctx.ellipse(TURRET_X, _turretCY + TURRET_R + 3, TURRET_R * 1.1, 5, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();
    // Body
    ctx.beginPath();
    ctx.arc(TURRET_X, _turretCY, TURRET_R, 0, Math.PI * 2);
    const bg = ctx.createRadialGradient(TURRET_X - 4, _turretCY - 4, 2, TURRET_X, _turretCY, TURRET_R);
    bg.addColorStop(0, '#88bbff');
    bg.addColorStop(1, '#1a5599');
    ctx.fillStyle = bg;
    ctx.fill();
    ctx.strokeStyle = '#aaddff';
    ctx.lineWidth   = 2;
    ctx.stroke();
    // Barrel
    ctx.beginPath();
    ctx.moveTo(TURRET_X, _turretCY);
    ctx.lineTo(TURRET_X + Math.cos(angle) * BARREL_LEN, _turretCY + Math.sin(angle) * BARREL_LEN);
    ctx.strokeStyle = '#cceeff';
    ctx.lineWidth   = 7;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();
  }

  function _drawTarget(t) {
    if (t.hit) return;
    const ctx = _ctx;

    // 전환까지 남은 시간 계산 (경고 글로우용)
    const now         = Date.now();
    const elapsed     = (now - t.phaseOffset) % TOGGLE_MS;
    const timeToSwitch = TOGGLE_MS - elapsed;
    const nearSwitch  = timeToSwitch < 500; // 0.5초 전 경고

    ctx.save();

    // 전환 임박 시 외곽 경고 링
    if (nearSwitch) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 80);
      ctx.beginPath();
      ctx.arc(t.x, t.cy, t.r + 6 + pulse * 4, 0, Math.PI * 2);
      ctx.strokeStyle = t.isAd ? 'rgba(0,255,170,0.6)' : 'rgba(255,80,0,0.6)';
      ctx.lineWidth   = 2.5;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(t.x, t.cy, t.r, 0, Math.PI * 2);

    if (!t.isAd) {
      // 초록 타겟
      ctx.shadowColor = '#00ffaa';
      ctx.shadowBlur  = 10;
      const g = ctx.createRadialGradient(t.x - 5, t.cy - 5, 2, t.x, t.cy, t.r);
      g.addColorStop(0, '#aaffcc');
      g.addColorStop(1, '#00cc77');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#00ffaa';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.shadowBlur   = 0;
      ctx.fillStyle    = '#003322';
      ctx.font         = `bold ${Math.round(t.r * 0.7)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('G', t.x, t.cy);
    } else {
      // 광고 타겟
      ctx.shadowColor = '#ff4400';
      ctx.shadowBlur  = 10;
      const g = ctx.createRadialGradient(t.x - 5, t.cy - 5, 2, t.x, t.cy, t.r);
      g.addColorStop(0, '#ff8844');
      g.addColorStop(1, '#cc2200');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.strokeStyle = '#ff6600';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.shadowBlur   = 0;
      ctx.fillStyle    = '#fff';
      ctx.font         = `bold ${Math.round(t.r * 0.52)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AD', t.x, t.cy);
    }
    ctx.restore();
  }

  function _drawBullet() {
    if (!_bullet) return;
    const ctx = _ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(_bullet.x, _bullet.y, BULLET_R, 0, Math.PI * 2);
    ctx.fillStyle   = '#ffe44d';
    ctx.shadowColor = '#ffaa00';
    ctx.shadowBlur  = 10;
    ctx.fill();
    ctx.restore();
  }

  function _drawTrajectoryPreview() {
    if (!_dragging) return;
    const { angle, power } = _aimParams();
    if (power < 1) return;

    let px  = TURRET_X   + Math.cos(angle) * (TURRET_R + 4);
    let py  = _turretCY  + Math.sin(angle) * (TURRET_R + 4);
    let pvx = Math.cos(angle) * power;
    let pvy = Math.sin(angle) * power;

    const ctx = _ctx;
    ctx.save();
    ctx.setLineDash([4, 7]);
    ctx.strokeStyle = 'rgba(255,255,180,0.45)';
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, py);

    for (let step = 0; step < 180; step++) {
      pvy += GRAVITY;
      px  += pvx;
      py  += pvy;
      if (py > _terrainY(px) || px < 0 || px > WORLD_W || py > WORLD_H) break;
      if (step % 2 === 1) ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // 파워 게이지 (포탑 주변 호)
    const pFrac = Math.min(power / MAX_POWER, 1);
    ctx.beginPath();
    ctx.arc(TURRET_X, _turretCY, TURRET_R + 7, angle - 0.35, angle + 0.35);
    ctx.strokeStyle = `hsl(${Math.round((1 - pFrac) * 120)},90%,55%)`;
    ctx.lineWidth   = 5;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.restore();
  }

  function _drawExplosion() {
    if (!_explosion) return;
    const { x, y, t, maxT } = _explosion;
    const frac  = t / maxT;
    const r     = 10 + frac * 38;
    const alpha = 1 - frac;
    const ctx   = _ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,${Math.round(180 * (1-frac))},0,${alpha})`;
    ctx.lineWidth   = 3;
    ctx.shadowColor = '#ff8800';
    ctx.shadowBlur  = 18;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, r * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,240,80,${alpha * 0.6})`;
    ctx.fill();
    ctx.restore();
    _explosion.t++;
    if (_explosion.t >= maxT) _explosion = null;
  }

  function _drawMuzzleFlash() {
    if (!_muzzleFlash) return;
    const { x, y, t } = _muzzleFlash;
    const alpha = 1 - t / 7;
    const r     = 7 + t * 2.5;
    const ctx   = _ctx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle   = `rgba(255,220,50,${alpha})`;
    ctx.shadowColor = '#ffaa00';
    ctx.shadowBlur  = 22;
    ctx.fill();
    ctx.restore();
    _muzzleFlash.t++;
    if (_muzzleFlash.t >= 7) _muzzleFlash = null;
  }

  function _drawHUD() {
    const ctx      = _ctx;
    const remaining = _targets.filter(t => !t.hit).length;
    const adNow     = _targets.filter(t => !t.hit && t.isAd).length;

    ctx.save();
    ctx.textBaseline = 'top';
    ctx.font      = 'bold 15px sans-serif';
    // 명중 카운터
    ctx.fillStyle = '#00ffaa';
    ctx.fillText(`\u25CF ${_greenHit}/${TOTAL_GREEN} 맞힘`, 12, 10);
    // 현재 AD 상태 타겟 수 경고
    if (adNow > 0) {
      ctx.fillStyle = '#ff8844';
      ctx.fillText(`\u26A0 ${adNow}개 AD 상태!`, 12, 32);
    } else {
      ctx.fillStyle = '#888';
      ctx.fillText(`남은 타겟 ${remaining}개`, 12, 32);
    }

    // 조준 힌트
    if (_phase === 'aim' && !_dragging) {
      ctx.font      = '13px sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'center';
      ctx.fillText('포탑을 드래그해서 조준 \u2192 손을 떼면 발사', VIEW_W / 2, VIEW_H - 24);
    }

    // 단계 메시지
    if (_phaseMsg) {
      ctx.font      = 'bold 26px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffcc00';
      ctx.shadowColor = '#ffcc00';
      ctx.shadowBlur  = 14;
      ctx.fillText(_phaseMsg, VIEW_W / 2, VIEW_H / 2 - 18);
    }
    ctx.restore();
  }

  // ── 물리 / 게임 로직 ─────────────────────────────────────

  function _aimParams() {
    const dx    = _dragWX - TURRET_X;
    const dy    = _dragWY - _turretCY;
    const dist  = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);
    const power = Math.min(dist / DRAG_MAX, 1) * MAX_POWER;
    return { angle, power };
  }

  function _fireBullet() {
    const { angle, power } = _aimParams();
    if (power < 1) { _dragging = false; return; }
    _aimAngle = angle;
    const bx = TURRET_X  + Math.cos(angle) * (TURRET_R + 5);
    const by = _turretCY + Math.sin(angle) * (TURRET_R + 5);
    _bullet = { x: bx, y: by, vx: Math.cos(angle) * power, vy: Math.sin(angle) * power };
    _muzzleFlash = { x: bx, y: by, t: 0 };
    if (typeof playCannonFireSound === 'function') playCannonFireSound();
    _phase    = 'flight';
    _phaseMsg = '';
    _dragging = false;
  }

  function _stepBullet() {
    if (!_bullet) return;
    _bullet.vy += GRAVITY;
    _bullet.x  += _bullet.vx;
    _bullet.y  += _bullet.vy;

    // 지형 충돌
    if (_bullet.y >= _terrainY(_bullet.x)) {
      _explosion = { x: _bullet.x, y: _terrainY(_bullet.x), t: 0, maxT: 18 };
      _endFlight(null);
      return;
    }
    // 화면 밖
    if (_bullet.x < 0 || _bullet.x > WORLD_W || _bullet.y > WORLD_H) {
      _endFlight(null);
      return;
    }
    // 타겟 충돌
    for (const t of _targets) {
      if (t.hit) continue;
      if (Math.hypot(_bullet.x - t.x, _bullet.y - t.cy) < t.r + BULLET_R) {
        _explosion = { x: t.x, y: t.cy, t: 0, maxT: 22 };
        _endFlight(t);
        return;
      }
    }
  }

  function _endFlight(hitTarget) {
    _bullet = null;
    _phase  = 'cooldown';

    if (hitTarget) {
      hitTarget.hit = true;
      if (!hitTarget.isAd) {
        // 초록 상태 명중 → 득점
        _greenHit++;
        if (typeof _onScore === 'function') _onScore(100);
        if (typeof playFortressHitSound === 'function') playFortressHitSound();

        if (_greenHit >= TOTAL_GREEN) {
          _phaseMsg = '클리어!';
          _cooldownTimer = setTimeout(() => {
            if (!_ended) { _ended = true; _cleanup(); _onSuccess(); }
          }, 1500);
          return;
        }
        _phaseMsg = '+100점!';
      } else {
        // AD 상태 명중 → 광고 오픈 + 게임오버
        _phaseMsg = '광고를 맞혔습니다!';
        const ad = (typeof randomAd === 'function') ? randomAd('all') : null;
        if (ad) window.open(ad.landingUrl, '_blank');
        if (typeof recordAdClick === 'function') recordAdClick();
        if (typeof playFailSound === 'function') playFailSound();
        _cooldownTimer = setTimeout(() => {
          if (!_ended) { _ended = true; _cleanup(); _onFail('ad-click'); }
        }, 1500);
        return;
      }
    } else {
      _phaseMsg = '빗나갔습니다!';
    }

    // 1.5초 후 다시 조준 페이즈
    _cooldownTimer = setTimeout(() => {
      if (!_ended) { _phase = 'aim'; _phaseMsg = ''; }
    }, 1500);
  }

  // ── 카메라 ────────────────────────────────────────────────

  function _updateCamera() {
    let tx;
    if (_phase === 'flight' && _bullet) {
      tx = _bullet.x - VIEW_W / 2;
    } else {
      tx = TURRET_X - VIEW_W * 0.25;
    }
    tx = Math.max(0, Math.min(WORLD_W - VIEW_W, tx));
    _camX += (tx - _camX) * 0.07;
  }

  // ── 좌표 변환 ─────────────────────────────────────────────

  function _worldCoords(clientX, clientY) {
    if (!_canvas) return { x: 0, y: 0 };
    const rect = _canvas.getBoundingClientRect();
    const sx   = _canvas.width  / rect.width;
    const sy   = _canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * sx + _camX,
      y: (clientY - rect.top)  * sy,
    };
  }

  function _nearTurret(wx, wy) {
    return Math.hypot(wx - TURRET_X, wy - _turretCY) < TURRET_R * 3.5;
  }

  // ── 입력 핸들러 ───────────────────────────────────────────

  function _onCanvasDown(e) {
    if (_ended || _phase !== 'aim') return;
    const p = _worldCoords(e.clientX, e.clientY);
    if (_nearTurret(p.x, p.y)) {
      _dragging = true;
      _dragWX   = p.x;
      _dragWY   = p.y;
    }
  }

  function _onDocMove(e) {
    if (!_dragging) return;
    const p = _worldCoords(e.clientX, e.clientY);
    _dragWX = p.x;
    _dragWY = p.y;
  }

  function _onDocUp() {
    if (!_dragging) return;
    _fireBullet();
  }

  function _onTouchStart(e) {
    e.preventDefault();
    if (_ended || _phase !== 'aim' || !e.touches.length) return;
    const t = e.touches[0];
    const p = _worldCoords(t.clientX, t.clientY);
    if (_nearTurret(p.x, p.y)) {
      _dragging = true;
      _dragWX   = p.x;
      _dragWY   = p.y;
    }
  }

  function _onTouchMove(e) {
    e.preventDefault();
    if (!_dragging || !e.touches.length) return;
    const t = e.touches[0];
    const p = _worldCoords(t.clientX, t.clientY);
    _dragWX = p.x;
    _dragWY = p.y;
  }

  function _onTouchEnd(e) {
    e.preventDefault();
    if (!_dragging) return;
    _fireBullet();
  }

  // ── 메인 루프 ─────────────────────────────────────────────

  function _loop() {
    if (_ended) return;

    _updateCamera();
    _updateTargetStates();
    if (_phase === 'flight') _stepBullet();

    const ctx = _ctx;
    _drawSky();

    // 카메라 변환 적용
    ctx.save();
    ctx.translate(-_camX, 0);

    _drawTerrain();
    _targets.forEach(_drawTarget);
    _drawTurret();
    _drawTrajectoryPreview();
    if (_bullet) _drawBullet();
    _drawExplosion();
    _drawMuzzleFlash();

    ctx.restore();

    _drawHUD();

    _raf = requestAnimationFrame(_loop);
  }

  // ── 정리 / 공개 API ──────────────────────────────────────

  function _cleanup() {
    _ended = true;
    if (_raf)           { cancelAnimationFrame(_raf);    _raf           = null; }
    if (_cooldownTimer) { clearTimeout(_cooldownTimer);  _cooldownTimer = null; }
    if (_canvas) {
      _canvas.removeEventListener('mousedown',  _onCanvasDown);
      _canvas.removeEventListener('touchstart', _onTouchStart);
      _canvas.removeEventListener('touchmove',  _onTouchMove);
      _canvas.removeEventListener('touchend',   _onTouchEnd);
    }
    document.removeEventListener('mousemove', _onDocMove);
    document.removeEventListener('mouseup',   _onDocUp);
    if (_area) {
      if (_area.parentElement) _area.parentElement.style.width = '';
      _area.style.height = '';
    }
  }

  function start(area, onScore, onSuccess, onFail) {
    _cleanup();
    _ended        = false;
    _area         = area;
    _onScore      = onScore;
    _onSuccess    = onSuccess;
    _onFail       = onFail;
    _phase        = 'aim';
    _greenHit     = 0;
    _dragging     = false;
    _bullet       = null;
    _explosion    = null;
    _muzzleFlash  = null;
    _phaseMsg     = '';
    _aimAngle     = -Math.PI / 4;
    _camX         = 0;

    _genTerrain();
    _turretCY = _terrainY(TURRET_X) - TURRET_R;
    _placeTargets();

    area.innerHTML = '';
    const _wrap   = area.parentElement;
    const availW  = Math.min(VIEW_W, Math.floor(window.innerWidth * 0.96));
    const _scaleR = availW / VIEW_W;
    if (_wrap) _wrap.style.width = availW + 'px';
    area.style.width  = '';                               // CSS width:100% 사용
    area.style.height = Math.round(VIEW_H * _scaleR) + 'px';

    _canvas = document.createElement('canvas');
    _canvas.width  = VIEW_W;
    _canvas.height = VIEW_H;
    _canvas.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;' +
      'touch-action:none;border-radius:14px;';
    area.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    _canvas.addEventListener('mousedown',  _onCanvasDown);
    _canvas.addEventListener('touchstart', _onTouchStart, { passive: false });
    _canvas.addEventListener('touchmove',  _onTouchMove,  { passive: false });
    _canvas.addEventListener('touchend',   _onTouchEnd,   { passive: false });
    document.addEventListener('mousemove', _onDocMove);
    document.addEventListener('mouseup',   _onDocUp);

    _loop();
    return _cleanup;
  }

  return { start };
})();
