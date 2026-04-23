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

/* ════════════════════════════════════════
   approveInquiry — 광고 신청 승인
   → /adInquiries/{id} 읽어서 /ads에 자동 등록
════════════════════════════════════════ */
exports.approveInquiry = onCall(async (request) => {
  assertAdmin(request.auth);

  const { id } = request.data;
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  }

  const db   = getDatabase();
  const snap = await db.ref(`adInquiries/${id}`).once('value');
  if (!snap.exists()) throw new HttpsError('not-found', '신청을 찾을 수 없습니다.');

  const inq = snap.val();
  if (inq.status === 'approved') {
    throw new HttpsError('already-exists', '이미 승인된 신청입니다.');
  }

  const soopId     = String(inq.soopId).trim().toLowerCase();
  const imgUrl     = `https://stimg.sooplive.com/LOGO/${soopId.slice(0, 2)}/${soopId}/${soopId}.jpg`;
  const landingUrl = `https://www.sooplive.com/station/${soopId}`;

  const days       = Number(inq.days) || 1;
  const expiresAt  = new Date(inq.createdAt + days * 86400000).toISOString().slice(0, 10);

  const adRef = db.ref('ads').push();
  await adRef.set({
    imgUrl,
    landingUrl,
    expiresAt,
    type:      'all',
    active:    true,
    nickname:  inq.nickname || '',
    soopId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  await db.ref(`adInquiries/${id}`).update({
    status:     'approved',
    approvedAt: Date.now(),
    adId:       adRef.key,
  });

  return { success: true, adId: adRef.key };
});

/* ════════════════════════════════════════
   rejectInquiry — 광고 신청 거절
════════════════════════════════════════ */
exports.rejectInquiry = onCall(async (request) => {
  assertAdmin(request.auth);

  const { id, reason } = request.data;
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  }

  const db   = getDatabase();
  const snap = await db.ref(`adInquiries/${id}`).once('value');
  if (!snap.exists()) throw new HttpsError('not-found', '신청을 찾을 수 없습니다.');

  await db.ref(`adInquiries/${id}`).update({
    status:     'rejected',
    rejectedAt: Date.now(),
    reason:     (typeof reason === 'string' && reason.trim()) ? reason.trim() : null,
  });

  return { success: true };
});

/* ════════════════════════════════════════
   deleteInquiry — 광고 신청 삭제
════════════════════════════════════════ */
exports.deleteInquiry = onCall(async (request) => {
  assertAdmin(request.auth);

  const { id } = request.data;
  if (typeof id !== 'string' || !id.trim()) {
    throw new HttpsError('invalid-argument', 'id가 필요합니다.');
  }

  const db   = getDatabase();
  const snap = await db.ref(`adInquiries/${id}`).once('value');
  if (!snap.exists()) throw new HttpsError('not-found', '신청을 찾을 수 없습니다.');

  await db.ref(`adInquiries/${id}`).remove();
  return { success: true };
});

/* ════════════════════════════════════════
   setQuizStage — 퀴즈 스테이지 이미지/정답 설정 (관리자 전용)
════════════════════════════════════════ */
exports.setQuizStage = onCall(async (request) => {
  assertAdmin(request.auth);

  const { imageUrl, answer } = request.data;
  assertString(imageUrl, 'imageUrl');
  assertString(answer,   'answer');

  await getDatabase().ref('quizStage').set({
    imageUrl:  imageUrl.trim(),
    answer:    answer.trim(),
    updatedAt: Date.now(),
  });

  return { success: true };
});

/* ════════════════════════════════════════
   getQuizStage — 퀴즈 스테이지 조회 (관리자 전용)
════════════════════════════════════════ */
exports.getQuizStage = onCall(async (request) => {
  assertAdmin(request.auth);

  const snap = await getDatabase().ref('quizStage').once('value');
  if (!snap.exists()) return { imageUrl: '', answer: '' };

  const { imageUrl, answer } = snap.val();
  return { imageUrl: imageUrl || '', answer: answer || '' };
});

/* ════════════════════════════════════════
   checkQuizAnswer — 퀴즈 정답 확인 (플레이어용, 정답 비공개)
════════════════════════════════════════ */
exports.checkQuizAnswer = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  }

  const { answer } = request.data;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new HttpsError('invalid-argument', '정답을 입력해주세요.');
  }

  const snap = await getDatabase().ref('quizStage/answer').once('value');
  if (!snap.exists()) {
    throw new HttpsError('not-found', '퀴즈가 설정되지 않았습니다.');
  }

  const stored  = snap.val().trim();
  const correct = stored.toLowerCase() === answer.trim().toLowerCase();
  return { correct, answer: correct ? null : stored };
});
