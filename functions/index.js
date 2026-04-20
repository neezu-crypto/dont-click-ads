'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { initializeApp }      = require('firebase-admin/app');
const { getDatabase }        = require('firebase-admin/database');

initializeApp();

/* ── 관리자 이메일 (소문자 정규화) ── */
const ADMIN_EMAIL = 'skftodwocks2@gmail.com'.toLowerCase().trim();

/* ── 권한 검증 헬퍼 ── */
function assertAdmin(auth) {
  if (!auth || typeof auth.token?.email !== 'string') {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }
  if (auth.token.email.toLowerCase().trim() !== ADMIN_EMAIL) {
    throw new HttpsError('permission-denied', '관리자 권한이 없습니다.');
  }
}

/* ── 입력값 검증 헬퍼 ── */
function assertString(val, field) {
  if (typeof val !== 'string' || !val.trim()) {
    throw new HttpsError('invalid-argument', `${field} 항목이 누락되었거나 올바르지 않습니다.`);
  }
}

const VALID_TYPES = new Set(['all', 'opening', 'tutorial', 'level1']);

/* ════════════════════════════════════════
   addAd — 새 광고 생성
════════════════════════════════════════ */
exports.addAd = onCall(async (request) => {
  assertAdmin(request.auth);

  const { imgUrl, landingUrl, expiresAt, type, active } = request.data;

  assertString(imgUrl,     'imgUrl');
  assertString(landingUrl, 'landingUrl');
  assertString(type,       'type');

  if (!VALID_TYPES.has(type)) {
    throw new HttpsError('invalid-argument',
      `type은 ${[...VALID_TYPES].join(' | ')} 중 하나여야 합니다.`);
  }
  if (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'string') {
    throw new HttpsError('invalid-argument', 'expiresAt은 날짜 문자열이어야 합니다.');
  }

  const db  = getDatabase();
  const ref = db.ref('ads').push();
  await ref.set({
    imgUrl:     imgUrl.trim(),
    landingUrl: landingUrl.trim(),
    expiresAt:  expiresAt || null,
    type,
    active:     active !== false,
    createdAt:  Date.now(),
    updatedAt:  Date.now(),
  });

  return { id: ref.key };
});

/* ════════════════════════════════════════
   updateAd — 광고 수정 (부분 업데이트)
════════════════════════════════════════ */
exports.updateAd = onCall(async (request) => {
  assertAdmin(request.auth);

  const { id, imgUrl, landingUrl, expiresAt, type, active } = request.data;

  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  }

  const updates = { updatedAt: Date.now() };

  if (imgUrl     !== undefined) { assertString(imgUrl,     'imgUrl');     updates.imgUrl     = imgUrl.trim(); }
  if (landingUrl !== undefined) { assertString(landingUrl, 'landingUrl'); updates.landingUrl = landingUrl.trim(); }
  if (type       !== undefined) {
    assertString(type, 'type');
    if (!VALID_TYPES.has(type)) throw new HttpsError('invalid-argument', 'type 값이 올바르지 않습니다.');
    updates.type = type;
  }
  if (expiresAt !== undefined) updates.expiresAt = expiresAt || null;
  if (active    !== undefined) updates.active    = Boolean(active);

  const snap = await getDatabase().ref(`ads/${id}`).once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', '해당 광고를 찾을 수 없습니다.');
  }

  await getDatabase().ref(`ads/${id}`).update(updates);
  return { success: true };
});

/* ════════════════════════════════════════
   deleteAd — 광고 삭제
════════════════════════════════════════ */
exports.deleteAd = onCall(async (request) => {
  assertAdmin(request.auth);

  const { id } = request.data;
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  }

  const snap = await getDatabase().ref(`ads/${id}`).once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', '해당 광고를 찾을 수 없습니다.');
  }

  await getDatabase().ref(`ads/${id}`).remove();
  return { success: true };
});
