// ─────────────────────────────────────────────────────────────
// Supabase 연결 설정
//
// · 비워 두면 '데모 모드'로 작동합니다.
//   (이 컴퓨터의 브라우저 안에서만 작동 — 탭 여러 개로 시험해 볼 수 있어요.)
// · 아래 두 값을 채우면 여러 크롬북에서 실시간으로 함께 사용할 수 있습니다.
//   값은 Supabase → Project Settings → API 에서 복사합니다.
//   (anon public 키는 공개되어도 괜찮은 키입니다. service_role 키는 절대 넣지 마세요.)
// ─────────────────────────────────────────────────────────────
window.LIVEPOLL_CONFIG = {
  supabaseUrl: '',      // 예: 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',  // 예: 'eyJhbGciOi...'
};
