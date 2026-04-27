// Top-down Racing mini-game module
const RacingModule = (() => {
  'use strict';

  // ── 트랙 상수 ──
  const TRACK_W = 1200, TRACK_H = 1200;
  const ROAD_W  = 180;  // 도로 폭
  const CAR_W   = 28, CAR_H = 48;
  const NUM_AI  = 7;
  const WIN_POS = 3; // 3등 이내 → 클리어

  // ── 트랙 웨이포인트 (폐곡선) ──
  // 중심선 좌표. 충분한 웨이포인트로 타원+굴곡 트랙을 표현
  const WAYPOINTS = (() => {
    const pts = [];
    const cx = TRACK_W / 2, cy = TRACK_H / 2;
    // 기본 타원 + sin 굴곡으로 흥미로운 트랙
    const N = 64;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      // 외부 타원 rx=440 ry=380, 내부 굴곡 추가
      const rx = 440 + Math.sin(a * 2) * 60 + Math.cos(a * 3) * 40;
      const ry = 380 + Math.cos(a * 2) * 60 + Math.sin(a * 3) * 30;
      pts.push({ x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry });
    }
    return pts;
  })();

  // ── 시작/결승선 ──
  const START_WP = 0;
  const FINISH_LINE = (() => {
    const wp0 = WAYPOINTS[START_WP];
    const wp1 = WAYPOINTS[START_WP + 1];
    const dx = wp1.x - wp0.x, dy = wp1.y - wp0.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len; // 법선
    return { x: wp0.x, y: wp0.y, nx, ny };
  })();

  // ── 차량 색상 ──
  const CAR_COLORS = ['#e8ff00', '#ff4444', '#4488ff', '#00ffaa', '#ff8800', '#cc44ff', '#44ffff', '#ff66aa'];
  const PLAYER_COLOR = CAR_COLORS[0];

  // ── 상태 ──
  let _area, _canvas, _ctx;
  let _onScore, _onSuccess, _onFail;
  let _ended = false;
  let _rafId = null;
  let _lastTime = 0;

  // 카메라
  let _camX = 0, _camY = 0;

  // 플레이어
  let _player = null;

  // AI 차량
  let _aiCars = [];

  // 카운트다운
  let _countdown = 3;
  let _countdownTimer = 0;
  let _racing = false;

  // 터치/마우스 입력
  let _inputDown = false;
  let _inputX = 0, _inputY = 0;

  // UI 요소
  let _uiOverlay = null;
  let _countdownEl = null;
  let _posEl = null;
  let _lapEl = null;

  // ── 차량 생성 ──
  function _createCar(color, wpIdx, laneOffset, isPlayer) {
    const wp = WAYPOINTS[wpIdx % WAYPOINTS.length];
    const wpNext = WAYPOINTS[(wpIdx + 1) % WAYPOINTS.length];
    const dx = wpNext.x - wp.x, dy = wpNext.y - wp.y;
    const angle = Math.atan2(dy, dx) - Math.PI / 2;
    const nx = -dy / Math.hypot(dx, dy);
    const ny = dx / Math.hypot(dx, dy);
    return {
      x: wp.x + nx * laneOffset,
      y: wp.y + ny * laneOffset,
      angle,
      speed: 0,
      maxSpeed: isPlayer ? 320 : 260 + Math.random() * 60,
      accel: isPlayer ? 220 : 160 + Math.random() * 60,
      steer: 0,
      color,
      wpTarget: (wpIdx + 2) % WAYPOINTS.length,
      lapsComplete: 0,
      finished: false,
      finishRank: 0,
      isPlayer,
      offTrack: false,
      driftFx: 0,
      // 결승선 통과 감지용
      prevSide: null,
    };
  }

  function _initCars() {
    // 출발 위치: 4열 2줄, 8등→1등 순서로 배치 (플레이어=8등 = 마지막)
    const startAngle = Math.atan2(
      WAYPOINTS[1].y - WAYPOINTS[0].y,
      WAYPOINTS[1].x - WAYPOINTS[0].x
    );
    const fwdX = Math.cos(startAngle), fwdY = Math.sin(startAngle);
    const perpX = -fwdY, perpY = fwdX;
    const wp0 = WAYPOINTS[0];

    const positions = [];
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 2; col++) {
        positions.push({
          x: wp0.x + perpX * ((col - 0.5) * 70) - fwdX * (row * 90 + 60),
          y: wp0.y + perpY * ((col - 0.5) * 70) - fwdY * (row * 90 + 60),
          angle: startAngle - Math.PI / 2,
        });
      }
    }
    // 0번 = 1등 위치, 7번 = 8등(플레이어)
    _aiCars = [];
    for (let i = 0; i < NUM_AI; i++) {
      const pos = positions[i];
      const car = {
        x: pos.x, y: pos.y,
        angle: pos.angle,
        speed: 0, maxSpeed: 240 + Math.random() * 60,
        accel: 150 + Math.random() * 60,
        steer: 0,
        color: CAR_COLORS[i + 1],
        wpTarget: 1,
        lapsComplete: 0,
        finished: false,
        finishRank: 0,
        isPlayer: false,
        offTrack: false,
        driftFx: 0,
        prevSide: null,
        passedHalf: false,
      };
      _aiCars.push(car);
    }
    const pPos = positions[7];
    _player = {
      x: pPos.x, y: pPos.y,
      angle: pPos.angle,
      speed: 0, maxSpeed: 320,
      accel: 240,
      steer: 0,
      color: PLAYER_COLOR,
      wpTarget: 1,
      lapsComplete: 0,
      finished: false,
      finishRank: 0,
      isPlayer: true,
      offTrack: false,
      driftFx: 0,
      prevSide: null,
      passedHalf: false,
    };
  }

  // ── 트랙 위 여부 판단 ──
  function _nearestWpDist(x, y) {
    let minDist = Infinity;
    for (const wp of WAYPOINTS) {
      const d = Math.hypot(x - wp.x, y - wp.y);
      if (d < minDist) minDist = d;
    }
    return minDist;
  }

  function _isOnTrack(x, y) {
    return _nearestWpDist(x, y) < ROAD_W * 0.65;
  }

  // ── AI 조향 ──
  function _steerAI(car, dt) {
    if (car.finished) return;
    const wp = WAYPOINTS[car.wpTarget];
    const dx = wp.x - car.x, dy = wp.y - car.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 55) {
      const next = (car.wpTarget + 1) % WAYPOINTS.length;
      if (next === 0 && car.lapsComplete === 0 && car.passedHalf) {
        // 한 바퀴 완주
        car.lapsComplete = 1;
        car.finished = true;
        _registerFinish(car);
      }
      car.wpTarget = next;
    }
    // 절반 이상 진행했을 때 플래그 세팅 (역주행 방지)
    if (car.wpTarget > WAYPOINTS.length / 2) car.passedHalf = true;
    const targetAngle = Math.atan2(dy, dx) - Math.PI / 2;
    let diff = targetAngle - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    car.steer = Math.max(-1, Math.min(1, diff * 2));
  }

  // ── 플레이어 조향 ──
  function _steerPlayer(car) {
    if (!_inputDown || !_racing || car.finished) return;
    const canvas = _canvas;
    const rect = canvas.getBoundingClientRect();
    // 화면 좌표 → 월드 좌표
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const scrX = (_inputX - rect.left) * scaleX;
    const scrY = (_inputY - rect.top) * scaleY;
    const worldX = scrX + _camX - canvas.width / 2;
    const worldY = scrY + _camY - canvas.height / 2;
    const dx = worldX - car.x, dy = worldY - car.y;
    const targetAngle = Math.atan2(dy, dx) - Math.PI / 2;
    let diff = targetAngle - car.angle;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    car.steer = Math.max(-1, Math.min(1, diff * 3));
  }

  // ── 차량 물리 업데이트 ──
  function _updateCar(car, dt) {
    if (car.finished) {
      car.speed *= (1 - dt * 2);
      return;
    }
    const onTrack = _isOnTrack(car.x, car.y);
    car.offTrack = !onTrack;
    const friction = onTrack ? 0.015 : 0.06;
    const speedMulti = onTrack ? 1 : 0.5;

    if (car.isPlayer) {
      if (_inputDown && _racing) {
        car.speed = Math.min(car.maxSpeed * speedMulti, car.speed + car.accel * dt);
      } else {
        car.speed = Math.max(0, car.speed - car.accel * dt * 0.8);
      }
      _steerPlayer(car);
    } else {
      if (_racing) {
        const targetSpeed = car.maxSpeed * speedMulti;
        car.speed = Math.min(targetSpeed, car.speed + car.accel * dt);
      }
      _steerAI(car, dt);
    }

    // 드리프트 효과 (속도×조향)
    const driftAmount = Math.abs(car.steer) * (car.speed / car.maxSpeed);
    if (driftAmount > 0.5 && car.speed > 80) {
      car.driftFx = Math.min(1, car.driftFx + dt * 3);
    } else {
      car.driftFx = Math.max(0, car.driftFx - dt * 4);
    }

    // 조향 적용 (속도에 비례)
    const steerRate = 2.8 * (car.speed / (car.maxSpeed || 1));
    car.angle += car.steer * steerRate * dt;

    // 이동
    const prevX = car.x, prevY = car.y;
    car.x += Math.sin(car.angle) * car.speed * dt;
    car.y -= Math.cos(car.angle) * car.speed * dt;

    // 벽 충돌 (트랙 밖 → 속도 감소 + 반발)
    if (!_isOnTrack(car.x, car.y)) {
      car.x = prevX;
      car.y = prevY;
      car.speed *= 0.45;
    }

    // 플레이어 결승선 통과 감지 (wpTarget 기반)
    if (car.isPlayer) {
      const wp = WAYPOINTS[car.wpTarget];
      const dist = Math.hypot(car.x - wp.x, car.y - wp.y);
      if (dist < 55) {
        const next = (car.wpTarget + 1) % WAYPOINTS.length;
        if (next === 0 && car.lapsComplete === 0 && car.passedHalf) {
          car.lapsComplete = 1;
          car.finished = true;
          _registerFinish(car);
        }
        car.wpTarget = next;
      }
      if (car.wpTarget > WAYPOINTS.length / 2) car.passedHalf = true;
    }
  }

  let _finishRankCounter = 0;
  function _registerFinish(car) {
    _finishRankCounter++;
    car.finishRank = _finishRankCounter;
    if (car.isPlayer) {
      _handlePlayerFinish(car.finishRank);
    }
  }

  function _handlePlayerFinish(rank) {
    if (_ended) return;
    _ended = true;
    setTimeout(() => {
      if (rank <= WIN_POS) {
        _onSuccess();
      } else {
        _onFail('lost');
      }
    }, 1200);
  }

  // ── 순위 계산 ──
  function _getRank() {
    if (_player.finished) return _player.finishRank;
    const allCars = [_player, ..._aiCars];
    // 미완주 차량은 웨이포인트 진행도로 비교
    const progress = (car) => {
      if (car.finished) return 999 + car.finishRank * -1;
      const wp = car.wpTarget;
      const wpPrev = (wp - 1 + WAYPOINTS.length) % WAYPOINTS.length;
      const wpPos = WAYPOINTS[wpPrev];
      const dist = Math.hypot(car.x - wpPos.x, car.y - wpPos.y);
      return wp * 1000 - dist;
    };
    const sorted = [...allCars].sort((a, b) => progress(b) - progress(a));
    return sorted.findIndex(c => c.isPlayer) + 1;
  }

  // ── 그리기: 트랙 ──
  function _drawTrack(ctx, camX, camY, W, H) {
    const offX = W / 2 - camX;
    const offY = H / 2 - camY;

    // 배경 (잔디)
    ctx.fillStyle = '#2d5a1b';
    ctx.fillRect(0, 0, W, H);

    // 도로 (외부 → 내부 순서로 그리기)
    const toScreen = (wx, wy) => ({ sx: wx + offX, sy: wy + offY });

    // 도로 경계 외곽 (흰 선 포함)
    ctx.save();
    ctx.beginPath();
    const N = WAYPOINTS.length;
    for (let i = 0; i <= N; i++) {
      const wp = WAYPOINTS[i % N];
      const wpNext = WAYPOINTS[(i + 1) % N];
      const dx = wpNext.x - wp.x, dy = wpNext.y - wp.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len * (ROAD_W * 0.55), ny = dx / len * (ROAD_W * 0.55);
      const s = toScreen(wp.x + nx, wp.y + ny);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    }
    ctx.closePath();
    ctx.fillStyle = '#555';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const wp = WAYPOINTS[i % N];
      const wpNext = WAYPOINTS[(i + 1) % N];
      const dx = wpNext.x - wp.x, dy = wpNext.y - wp.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len * (ROAD_W * 0.55), ny = dx / len * (ROAD_W * 0.55);
      const s = toScreen(wp.x - nx, wp.y - ny);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    }
    ctx.closePath();
    ctx.fillStyle = '#2d5a1b';
    ctx.fill();
    ctx.restore();

    // 도로 표면 재렌더 (아스팔트)
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const wp = WAYPOINTS[i % N];
      const wpNext = WAYPOINTS[(i + 1) % N];
      const dx = wpNext.x - wp.x, dy = wpNext.y - wp.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len * (ROAD_W * 0.50), ny = dx / len * (ROAD_W * 0.50);
      const s = toScreen(wp.x + nx, wp.y + ny);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    }
    ctx.closePath();
    ctx.fillStyle = '#3a3a3a';
    ctx.fill();

    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const wp = WAYPOINTS[i % N];
      const wpNext = WAYPOINTS[(i + 1) % N];
      const dx = wpNext.x - wp.x, dy = wpNext.y - wp.y;
      const len = Math.hypot(dx, dy);
      const nx = -dy / len * (ROAD_W * 0.50), ny = dx / len * (ROAD_W * 0.50);
      const s = toScreen(wp.x - nx, wp.y - ny);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    }
    ctx.closePath();
    ctx.fillStyle = '#2d5a1b';
    ctx.fill();
    ctx.restore();

    // 중앙선 (점선)
    ctx.save();
    ctx.setLineDash([20, 20]);
    ctx.strokeStyle = '#ffff0066';
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const wp = WAYPOINTS[i % N];
      const s = toScreen(wp.x, wp.y);
      if (i === 0) ctx.moveTo(s.sx, s.sy);
      else ctx.lineTo(s.sx, s.sy);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // 결승선
    const fl = FINISH_LINE;
    const flS = toScreen(fl.x, fl.y);
    ctx.save();
    ctx.translate(flS.sx, flS.sy);
    ctx.rotate(Math.atan2(fl.ny, fl.nx) + Math.PI / 2);
    const fLen = ROAD_W * 0.9;
    const sqSize = 12;
    const cols = Math.ceil(fLen / sqSize);
    for (let ci = 0; ci < cols; ci++) {
      for (let ri = 0; ri < 3; ri++) {
        ctx.fillStyle = (ci + ri) % 2 === 0 ? '#fff' : '#000';
        ctx.fillRect(ci * sqSize - fLen / 2, ri * sqSize - sqSize * 1.5, sqSize, sqSize);
      }
    }
    ctx.restore();

    // 나무/장식물
    const trees = [
      { wx: 600, wy: 600 }, { wx: 400, wy: 350 }, { wx: 800, wy: 350 },
      { wx: 300, wy: 700 }, { wx: 900, wy: 700 }, { wx: 600, wy: 900 },
      { wx: 600, wy: 300 }, { wx: 500, wy: 500 }, { wx: 700, wy: 500 },
    ];
    for (const t of trees) {
      const s = toScreen(t.wx, t.wy);
      if (s.sx < -60 || s.sx > W + 60 || s.sy < -60 || s.sy > H + 60) continue;
      ctx.beginPath();
      ctx.arc(s.sx, s.sy, 22, 0, Math.PI * 2);
      ctx.fillStyle = '#1a4010';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(s.sx, s.sy, 16, 0, Math.PI * 2);
      ctx.fillStyle = '#2a6018';
      ctx.fill();
    }
  }

  // ── 그리기: 차량 ──
  function _drawCar(ctx, car, camX, camY, W, H) {
    const sx = car.x - camX + W / 2;
    const sy = car.y - camY + H / 2;
    if (sx < -80 || sx > W + 80 || sy < -80 || sy > H + 80) return;

    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(car.angle);

    // 드리프트 스키드 마크 효과 (그림자로 표현)
    if (car.driftFx > 0.3) {
      ctx.globalAlpha = car.driftFx * 0.4;
      ctx.fillStyle = '#333';
      ctx.fillRect(-CAR_W / 2 - 3, -CAR_H / 2 + 6, 6, CAR_H - 12);
      ctx.fillRect(CAR_W / 2 - 3, -CAR_H / 2 + 6, 6, CAR_H - 12);
      ctx.globalAlpha = 1;
    }

    // 차체 그림자
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = '#000';
    ctx.fillRect(-CAR_W / 2 + 3, -CAR_H / 2 + 3, CAR_W, CAR_H);
    ctx.globalAlpha = 1;

    // 차체
    const grad = ctx.createLinearGradient(-CAR_W / 2, -CAR_H / 2, CAR_W / 2, CAR_H / 2);
    grad.addColorStop(0, car.color);
    grad.addColorStop(1, _darken(car.color, 0.55));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.rect(-CAR_W / 2, -CAR_H / 2, CAR_W, CAR_H);
    ctx.fill();

    // 앞유리
    ctx.fillStyle = 'rgba(160,220,255,0.7)';
    ctx.fillRect(-CAR_W / 2 + 4, -CAR_H / 2 + 6, CAR_W - 8, CAR_H * 0.28);

    // 헤드라이트
    ctx.fillStyle = '#ffffcc';
    ctx.fillRect(-CAR_W / 2 + 3, -CAR_H / 2 + 2, 7, 4);
    ctx.fillRect(CAR_W / 2 - 10, -CAR_H / 2 + 2, 7, 4);

    // 테일라이트
    ctx.fillStyle = '#ff2222';
    ctx.fillRect(-CAR_W / 2 + 3, CAR_H / 2 - 6, 7, 4);
    ctx.fillRect(CAR_W / 2 - 10, CAR_H / 2 - 6, 7, 4);

    // 플레이어 표시
    if (car.isPlayer) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('YOU', 0, -CAR_H / 2 - 8);
    }

    ctx.restore();
  }

  function _darken(hex, factor) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${Math.round(r * factor)},${Math.round(g * factor)},${Math.round(b * factor)})`;
  }

  // ── 메인 루프 ──
  function _loop(ts) {
    if (_ended && _rafId) { cancelAnimationFrame(_rafId); _rafId = null; return; }
    _rafId = requestAnimationFrame(_loop);

    const dt = Math.min((ts - _lastTime) / 1000, 0.05);
    _lastTime = ts;

    // 카운트다운
    if (!_racing) {
      _countdownTimer += dt;
      if (_countdownTimer >= 1) {
        _countdownTimer = 0;
        _countdown--;
        if (_countdown <= 0) {
          _racing = true;
          _showCountdown('GO!');
          setTimeout(() => { if (_countdownEl) _countdownEl.style.display = 'none'; }, 700);
        } else {
          _showCountdown(String(_countdown));
        }
      }
    }

    // 물리 업데이트
    if (_racing) {
      _updateCar(_player, dt);
      for (const ai of _aiCars) _updateCar(ai, dt);
    }

    // 카메라 추적
    _camX += (_player.x - _camX) * Math.min(1, dt * 8);
    _camY += (_player.y - _camY) * Math.min(1, dt * 8);

    // 그리기
    const W = _canvas.width, H = _canvas.height;
    _ctx.clearRect(0, 0, W, H);
    _drawTrack(_ctx, _camX, _camY, W, H);

    // AI 차량 먼저, 플레이어는 위에
    for (const ai of _aiCars) _drawCar(_ctx, ai, _camX, _camY, W, H);
    _drawCar(_ctx, _player, _camX, _camY, W, H);

    // 미니맵
    _drawMinimap(_ctx, W, H);

    // UI 업데이트
    _updateUI();
  }

  function _drawMinimap(ctx, W, H) {
    const mmW = 130, mmH = 130, mmX = W - mmW - 10, mmY = 10;
    const scaleX = mmW / TRACK_W, scaleY = mmH / TRACK_H;

    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = '#111';
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.rect(mmX, mmY, mmW, mmH);
    ctx.fill();
    ctx.stroke();

    // 트랙 중심선
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 7;
    ctx.beginPath();
    for (let i = 0; i <= WAYPOINTS.length; i++) {
      const wp = WAYPOINTS[i % WAYPOINTS.length];
      const sx = mmX + wp.x * scaleX, sy = mmY + wp.y * scaleY;
      if (i === 0) ctx.moveTo(sx, sy); else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.stroke();

    // 차량 점
    const allCars = [..._aiCars, _player];
    for (const c of allCars) {
      const sx = mmX + c.x * scaleX, sy = mmY + c.y * scaleY;
      ctx.beginPath();
      ctx.arc(sx, sy, c.isPlayer ? 5 : 3, 0, Math.PI * 2);
      ctx.fillStyle = c.isPlayer ? '#ffff00' : '#ff4444';
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function _showCountdown(text) {
    if (!_countdownEl) return;
    _countdownEl.style.display = 'flex';
    _countdownEl.textContent = text;
    _countdownEl.style.transform = 'translate(-50%,-50%) scale(1.3)';
    _countdownEl.style.opacity = '1';
    setTimeout(() => {
      if (_countdownEl) {
        _countdownEl.style.transform = 'translate(-50%,-50%) scale(1)';
        _countdownEl.style.opacity = '0.6';
      }
    }, 150);
  }

  function _updateUI() {
    if (_posEl) {
      const rank = _getRank();
      const suffix = rank === 1 ? 'ST' : rank === 2 ? 'ND' : rank === 3 ? 'RD' : 'TH';
      _posEl.textContent = `${rank}${suffix}`;
      _posEl.style.color = rank <= 3 ? '#00ff88' : '#ff4444';
    }
    if (_lapEl) {
      _lapEl.textContent = _player.lapsComplete >= 1 ? 'FINISH' : '1 LAP';
    }
    if (!_racing && _countdownEl && _countdownEl.style.display === 'none') {
      _countdownEl.style.display = 'flex';
      _countdownEl.textContent = String(_countdown);
    }
  }

  // ── 입력 이벤트 ──
  function _onPointerDown(e) {
    e.preventDefault();
    _inputDown = true;
    const pt = e.touches ? e.touches[0] : e;
    _inputX = pt.clientX;
    _inputY = pt.clientY;
  }
  function _onPointerMove(e) {
    e.preventDefault();
    if (!_inputDown) return;
    const pt = e.touches ? e.touches[0] : e;
    _inputX = pt.clientX;
    _inputY = pt.clientY;
  }
  function _onPointerUp(e) {
    e.preventDefault();
    _inputDown = false;
  }

  // ── 공개 API ──
  function start(area, onScore, onSuccess, onFail) {
    _area = area;
    _onScore = onScore;
    _onSuccess = onSuccess;
    _onFail = onFail;
    _ended = false;
    _racing = false;
    _countdown = 3;
    _countdownTimer = 0;
    _lastTime = 0;
    _finishRankCounter = 0;
    _inputDown = false;

    area.innerHTML = '';
    area.style.position = 'relative';
    area.style.overflow = 'hidden';
    area.style.background = '#1a1a1a';

    // 캔버스 생성
    _canvas = document.createElement('canvas');
    _canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;';
    area.appendChild(_canvas);
    _ctx = _canvas.getContext('2d');

    function _resize() {
      _canvas.width  = area.clientWidth  || window.innerWidth;
      _canvas.height = area.clientHeight || window.innerHeight;
    }
    _resize();
    const resizeObs = new ResizeObserver(_resize);
    resizeObs.observe(area);

    // UI 오버레이
    _uiOverlay = document.createElement('div');
    _uiOverlay.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;';
    area.appendChild(_uiOverlay);

    // 카운트다운 표시
    _countdownEl = document.createElement('div');
    _countdownEl.style.cssText = `
      position:absolute;top:50%;left:50%;
      transform:translate(-50%,-50%);
      font-size:5rem;font-weight:900;
      color:#fff;text-shadow:0 0 30px #ff8800,0 0 60px #ff440088;
      display:flex;align-items:center;justify-content:center;
      transition:transform 0.15s,opacity 0.15s;
      z-index:20;pointer-events:none;user-select:none;
    `;
    _countdownEl.textContent = '3';
    _uiOverlay.appendChild(_countdownEl);

    // 순위 표시
    _posEl = document.createElement('div');
    _posEl.style.cssText = `
      position:absolute;top:14px;left:14px;
      font-size:2.2rem;font-weight:900;
      color:#00ff88;text-shadow:0 0 12px #00ff8888;
      pointer-events:none;user-select:none;
    `;
    _uiOverlay.appendChild(_posEl);

    // 랩 표시
    _lapEl = document.createElement('div');
    _lapEl.style.cssText = `
      position:absolute;top:58px;left:14px;
      font-size:1rem;font-weight:700;
      color:#aaa;pointer-events:none;user-select:none;
    `;
    _lapEl.textContent = '1 LAP';
    _uiOverlay.appendChild(_lapEl);

    // 조작 안내
    const hint = document.createElement('div');
    hint.style.cssText = `
      position:absolute;bottom:18px;left:50%;transform:translateX(-50%);
      font-size:0.85rem;color:#aaa;text-align:center;
      pointer-events:none;user-select:none;background:rgba(0,0,0,0.4);
      padding:6px 14px;border-radius:20px;
    `;
    hint.textContent = '화면을 누르고 유지하면 가속 · 방향을 클릭해 조향';
    _uiOverlay.appendChild(hint);
    setTimeout(() => { if (hint.parentNode) hint.style.opacity = '0'; hint.style.transition = 'opacity 1s'; }, 4000);

    // 목표 안내
    const goal = document.createElement('div');
    goal.style.cssText = `
      position:absolute;top:14px;right:150px;
      font-size:0.82rem;font-weight:600;color:#ffdd44;
      text-shadow:0 0 8px #ffdd4488;text-align:right;
      pointer-events:none;user-select:none;
    `;
    goal.innerHTML = '🏁 3등 이내로 결승선 통과!';
    _uiOverlay.appendChild(goal);

    // 속도계
    const speedBar = document.createElement('div');
    speedBar.id = 'racing-speedbar';
    speedBar.style.cssText = `
      position:absolute;bottom:52px;left:14px;
      display:flex;flex-direction:column;gap:3px;
      pointer-events:none;user-select:none;
    `;
    speedBar.innerHTML = `
      <div style="font-size:0.7rem;color:#888;">SPEED</div>
      <div style="width:80px;height:8px;background:#333;border-radius:4px;overflow:hidden;">
        <div id="racing-speedfill" style="height:100%;width:0%;background:linear-gradient(90deg,#00aaff,#00ffaa);border-radius:4px;transition:width 0.1s;"></div>
      </div>
    `;
    _uiOverlay.appendChild(speedBar);

    // 차량 & 트랙 초기화
    _initCars();
    _camX = _player.x;
    _camY = _player.y;

    // 입력
    _canvas.addEventListener('pointerdown', _onPointerDown, { passive: false });
    _canvas.addEventListener('pointermove', _onPointerMove, { passive: false });
    _canvas.addEventListener('pointerup', _onPointerUp, { passive: false });
    _canvas.addEventListener('pointercancel', _onPointerUp, { passive: false });
    _canvas.addEventListener('touchstart', _onPointerDown, { passive: false });
    _canvas.addEventListener('touchmove', _onPointerMove, { passive: false });
    _canvas.addEventListener('touchend', _onPointerUp, { passive: false });

    // 속도계 업데이트
    const speedInterval = setInterval(() => {
      if (_ended) { clearInterval(speedInterval); return; }
      const fill = document.getElementById('racing-speedfill');
      if (fill && _player) fill.style.width = `${(_player.speed / _player.maxSpeed * 100).toFixed(0)}%`;
    }, 100);

    // 루프 시작
    _rafId = requestAnimationFrame((ts) => { _lastTime = ts; _loop(ts); });

    return () => {
      _ended = true;
      if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
      resizeObs.disconnect();
      clearInterval(speedInterval);
      _canvas.removeEventListener('pointerdown', _onPointerDown);
      _canvas.removeEventListener('pointermove', _onPointerMove);
      _canvas.removeEventListener('pointerup', _onPointerUp);
      _canvas.removeEventListener('pointercancel', _onPointerUp);
      _canvas.removeEventListener('touchstart', _onPointerDown);
      _canvas.removeEventListener('touchmove', _onPointerMove);
      _canvas.removeEventListener('touchend', _onPointerUp);
    };
  }

  return { start };
})();
