// 실시간 의견 모으기 — 세 화면(학생 · 교사 · 결과)이 함께 쓰는 코드
'use strict';
window.LivePoll = (() => {
  const cfg = window.LIVEPOLL_CONFIG || {};
  const DEMO = !(cfg.supabaseUrl && cfg.supabaseAnonKey);

  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 응답 유형과 각 유형에서 고를 수 있는 결과 화면
  const TYPES = {
    choice: { label: '객관식', hint: '하나만 고르기', options: true, views: ['bar', 'pie', 'ranking', 'list'] },
    multi:  { label: '복수 선택', hint: '여러 개 고르기', options: true, views: ['bar', 'pie', 'ranking', 'list'] },
    ox:     { label: 'O / X', hint: 'O 또는 X', views: ['bar', 'pie', 'list'] },
    rating: { label: '별점', hint: '1~5점 주기', views: ['bar', 'list'] },
    word:   { label: '단어 입력', hint: '한두 단어 → 워드클라우드', views: ['wordcloud', 'ranking', 'cards', 'list'] },
    short:  { label: '짧은 답변', hint: '한 문장으로 답하기', views: ['cards', 'wordcloud', 'list'] },
    card:   { label: '의견 카드', hint: '긴 의견 + 친구 의견에 투표', views: ['cards', 'list', 'wordcloud'] },
    rank:   { label: '순위 정하기', hint: '선택지의 순서 정하기', options: true, views: ['ranking', 'bar', 'list'] },
  };
  const TEXT_TYPES = ['word', 'short', 'card'];
  const TEXT_LIMIT = { word: 30, short: 150, card: 400 };
  const VIEWS = { bar: '막대그래프', pie: '원형 그래프', ranking: '순위', wordcloud: '워드클라우드', cards: '의견 카드', list: '응답 목록' };
  const COLORS = ['#2d6cdf', '#e07a2f', '#15755b', '#b7417a', '#7a5bd6', '#b08a12', '#1f8ea3', '#8a6a4f'];

  const ERRORS = {
    NOT_FOUND: 'PIN을 다시 확인해 주세요. 해당 활동이 없어요.',
    CLOSED: '선생님이 응답 받기를 마감했어요.',
    NEED_ID: '학번을 입력해 주세요.',
    NEED_NAME: '이름을 입력해 주세요.',
    EMPTY: '답을 입력하거나 골라 주세요.',
    BAD_ANSWER: '답 형식이 올바르지 않아요.',
    TOO_MANY: '이 활동에는 더 이상 보낼 수 없어요. (한 사람당 최대 20개)',
    NO_VOTING: '이 활동은 투표가 꺼져 있어요.',
  };
  function friendly(err) {
    const msg = (err && err.message) || String(err);
    for (const code in ERRORS) if (msg.includes(code)) return new Error(ERRORS[code]);
    if (/Invalid login/i.test(msg)) return new Error('이메일 또는 비밀번호가 맞지 않아요.');
    if (/Email not confirmed/i.test(msg)) return new Error('가입 확인 메일의 링크를 먼저 눌러 주세요.');
    if (/Failed to fetch|NetworkError/i.test(msg)) return new Error('인터넷 연결을 확인해 주세요.');
    return new Error(msg);
  }

  function getStore(kind, key) { try { return window[kind].getItem(key); } catch { return null; } }
  function setStore(kind, key, value) { try { window[kind].setItem(key, value); } catch { /* 저장 불가 환경 */ } }

  // 기기(데모 모드에서는 탭)마다 하나씩 생기는 익명 키 — 중복 응답·중복 투표를 막는 데 사용
  let memoryKey = null;
  function clientKey() {
    const kind = DEMO ? 'sessionStorage' : 'localStorage';
    let k = getStore(kind, 'livepoll-client') || memoryKey;
    if (!k) {
      k = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
      setStore(kind, 'livepoll-client', k);
    }
    return (memoryKey = k);
  }
  function randomPin() {
    const n = new Uint32Array(1); crypto.getRandomValues(n);
    return String(100000 + (n[0] % 900000));
  }

  function optionsOf(a) {
    if (a.response_type === 'ox') return ['O', 'X'];
    if (a.response_type === 'rating') return ['★ 1', '★ 2', '★ 3', '★ 4', '★ 5'];
    return Array.isArray(a.options) ? a.options : [];
  }

  // 학생 답을 검사하고 정리 (schema.sql 의 submit_response 와 같은 규칙)
  function cleanAnswer(a, ans) {
    const t = a.response_type, n = optionsOf(a).length;
    const isIdx = v => Number.isInteger(v) && v >= 0 && v < n;
    ans = ans || {};
    if (t === 'choice' || t === 'ox') { if (!isIdx(ans.choice)) throw new Error('EMPTY'); return { choice: ans.choice }; }
    if (t === 'rating') { if (!Number.isInteger(ans.value) || ans.value < 1 || ans.value > 5) throw new Error('EMPTY'); return { value: ans.value }; }
    if (t === 'multi') {
      const c = Array.isArray(ans.choices) ? ans.choices : [];
      if (!c.length) throw new Error('EMPTY');
      if (!c.every(isIdx) || new Set(c).size !== c.length) throw new Error('BAD_ANSWER');
      return { choices: [...c].sort((x, y) => x - y) };
    }
    if (t === 'rank') {
      const o = Array.isArray(ans.order) ? ans.order : [];
      if (o.length !== n || !o.every(isIdx) || new Set(o).size !== n) throw new Error('BAD_ANSWER');
      return { order: o };
    }
    const text = String(ans.text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_LIMIT[t] || 150);
    if (!text) throw new Error('EMPTY');
    return { text };
  }

  const PUBLIC_FIELDS = ['id', 'pin', 'class_name', 'title', 'question', 'response_type', 'options', 'result_view',
    'collect_student_no', 'collect_name', 'identity_mode', 'results_visible', 'allow_voting', 'allow_multiple', 'status'];
  const publicActivity = a => Object.fromEntries(PUBLIC_FIELDS.map(k => [k, a[k]]));
  const clip = (s, n) => { const v = String(s ?? '').trim().slice(0, n); return v || null; };

  // ───────────── 데모 모드: 이 브라우저 안에서만 (localStorage + BroadcastChannel) ─────────────
  function localApi() {
    const KEY = 'livepoll-demo-v1';
    const bc = typeof BroadcastChannel === 'function' ? new BroadcastChannel('livepoll-demo') : null;
    const load = () => {
      try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.activities) return d; } catch { /* 비어 있음 */ }
      return { activities: [], responses: [], votes: [] };
    };
    const save = d => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch { /* 저장 불가 */ } };
    const byPin = (d, pin) => d.activities.find(a => a.pin === pin);
    const fail = code => { throw new Error(code); };
    const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
    const api = {
      demo: true,
      async getTeacher() { return { id: 'demo', email: '데모 교사' }; },
      async signIn() {}, async signUp() { return true; }, async signOut() {},
      async createActivity(fields) {
        const d = load(); let pin;
        do pin = randomPin(); while (byPin(d, pin));
        const a = { ...fields, id: uid(), teacher_id: 'demo', pin, status: 'open', created_at: new Date().toISOString() };
        d.activities.unshift(a); save(d); return a;
      },
      async myActivities() {
        const d = load();
        return d.activities.map(a => ({ ...a, response_count: d.responses.filter(r => r.activity_id === a.id).length }));
      },
      async updateActivity(a, patch) {
        const d = load(); const x = d.activities.find(y => y.id === a.id);
        if (x) Object.assign(x, patch); save(d); api.notify(a.pin);
      },
      async deleteActivity(a) {
        const d = load(); const ids = new Set(d.responses.filter(r => r.activity_id === a.id).map(r => r.id));
        d.activities = d.activities.filter(x => x.id !== a.id);
        d.responses = d.responses.filter(r => !ids.has(r.id));
        d.votes = d.votes.filter(v => !ids.has(v.response_id));
        save(d); api.notify(a.pin);
      },
      async joinActivity(pin) { const a = byPin(load(), pin); return a ? publicActivity(a) : null; },
      async submitResponse(pin, f) {
        const d = load(); const a = byPin(d, pin);
        if (!a) fail('NOT_FOUND');
        if (a.status !== 'open') fail('CLOSED');
        const anon = a.identity_mode === 'anonymous';
        const no = !anon && a.collect_student_no ? clip(f.student_no, 20) : null;
        const name = !anon && a.collect_name ? clip(f.student_name, 30) : null;
        if (!anon && a.collect_student_no && !no) fail('NEED_ID');
        if (!anon && a.collect_name && !name) fail('NEED_NAME');
        const answer = cleanAnswer(a, f.answer), key = clientKey();
        const mine = d.responses.filter(r => r.activity_id === a.id && r.client_key === key);
        if (!a.allow_multiple && mine.length) Object.assign(mine[0], { answer, student_no: no, student_name: name });
        else {
          if (mine.length >= 20) fail('TOO_MANY');
          d.responses.push({ id: uid(), activity_id: a.id, client_key: key, student_no: no, student_name: name, answer, hidden: false, created_at: new Date().toISOString() });
        }
        save(d); api.notify(pin);
      },
      async getResults(pin, asStudent) {
        const d = load(); const a = byPin(d, pin);
        if (!a) return null;
        const owner = !asStudent && a.teacher_id === 'demo';
        const activity = { ...publicActivity(a), is_owner: owner };
        if (!owner && !a.results_visible) return { activity, responses: null };
        const key = clientKey();
        const responses = d.responses
          .filter(r => r.activity_id === a.id && (owner || !r.hidden))
          .map(r => ({
            id: r.id, answer: r.answer, created_at: r.created_at, hidden: owner ? r.hidden : false,
            author: owner ? ([r.student_no, r.student_name].filter(Boolean).join(' ') || null)
              : (a.identity_mode === 'public' ? r.student_name : null),
            votes: d.votes.filter(v => v.response_id === r.id).length,
            voted: d.votes.some(v => v.response_id === r.id && v.client_key === key),
          }));
        return { activity, responses };
      },
      async setHidden(pin, id, hidden) {
        const d = load(); const r = d.responses.find(x => x.id === id);
        if (r) r.hidden = hidden; save(d); api.notify(pin);
      },
      async vote(pin, id) {
        const d = load(); const a = byPin(d, pin);
        if (!a) fail('NOT_FOUND');
        if (!a.allow_voting || !a.results_visible) fail('NO_VOTING');
        if (a.status !== 'open') fail('CLOSED');
        const r = d.responses.find(x => x.id === id && x.activity_id === a.id && !x.hidden);
        if (!r) fail('NOT_FOUND');
        const key = clientKey(), i = d.votes.findIndex(v => v.response_id === id && v.client_key === key);
        if (i >= 0) d.votes.splice(i, 1); else d.votes.push({ response_id: id, client_key: key });
        save(d); api.notify(pin);
      },
      subscribe(pin, cb) {
        const onMsg = e => { if (e.data === pin) cb(); };
        const onStorage = e => { if (e.key === KEY) cb(); };
        bc?.addEventListener('message', onMsg);
        addEventListener('storage', onStorage);
        const t = setInterval(cb, 3000);
        return () => { clearInterval(t); bc?.removeEventListener('message', onMsg); removeEventListener('storage', onStorage); };
      },
      notify(pin) { bc?.postMessage(pin); },
    };
    return api;
  }

  // ───────────── Supabase 모드: 여러 기기에서 실시간 ─────────────
  function supabaseApi() {
    if (!window.supabase) throw new Error('Supabase 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.');
    const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
    const channels = {};
    const check = ({ data, error }) => { if (error) throw friendly(error); return data; };
    const rpc = async (fn, args) => check(await sb.rpc(fn, args));
    const channel = pin => channels[pin] || (channels[pin] = sb.channel('livepoll-' + pin));
    const api = {
      demo: false,
      async getTeacher() {
        const { data } = await sb.auth.getSession();
        const u = data.session && data.session.user;
        return u ? { id: u.id, email: u.email } : null;
      },
      async signIn(email, password) { check(await sb.auth.signInWithPassword({ email, password })); },
      async signUp(email, password) { const data = check(await sb.auth.signUp({ email, password })); return !!data.session; },
      async signOut() { await sb.auth.signOut(); },
      async createActivity(fields) {
        for (let i = 0; i < 8; i++) {
          const { data, error } = await sb.from('activities').insert({ ...fields, pin: randomPin() }).select().single();
          if (!error) return data;
          if (error.code !== '23505') throw friendly(error); // 23505 = PIN 중복 → 다시 시도
        }
        throw new Error('PIN을 만들지 못했어요. 다시 시도해 주세요.');
      },
      async myActivities() {
        const data = check(await sb.from('activities').select('*, responses(count)').order('created_at', { ascending: false }));
        return data.map(a => ({ ...a, response_count: (a.responses && a.responses[0] && a.responses[0].count) || 0 }));
      },
      async updateActivity(a, patch) { check(await sb.from('activities').update(patch).eq('id', a.id)); api.notify(a.pin); },
      async deleteActivity(a) { check(await sb.from('activities').delete().eq('id', a.id)); api.notify(a.pin); },
      joinActivity: pin => rpc('join_activity', { p_pin: pin }),
      async submitResponse(pin, f) {
        await rpc('submit_response', { p_pin: pin, p_client_key: clientKey(), p_student_no: f.student_no || null, p_student_name: f.student_name || null, p_answer: f.answer });
        api.notify(pin);
      },
      getResults: (pin, asStudent) => rpc('get_results', { p_pin: pin, p_client_key: clientKey(), p_as_student: !!asStudent }),
      async setHidden(pin, id, hidden) { check(await sb.from('responses').update({ hidden }).eq('id', id)); api.notify(pin); },
      async vote(pin, id) { await rpc('vote_response', { p_pin: pin, p_response_id: id, p_client_key: clientKey() }); api.notify(pin); },
      subscribe(pin, cb) {
        // 실시간 신호(Broadcast)로 바로 새로고침하고, 혹시 신호를 놓쳐도 4초마다 다시 확인
        const ch = channel(pin).on('broadcast', { event: 'changed' }, () => cb()).subscribe();
        const t = setInterval(cb, 4000);
        return () => { clearInterval(t); sb.removeChannel(ch); delete channels[pin]; };
      },
      notify(pin) { channel(pin).send({ type: 'broadcast', event: 'changed', payload: {} }).catch(() => {}); },
    };
    return api;
  }

  // ───────────── 결과 계산 ─────────────
  const STOP = new Set('a an the and or but so is am are was were be been to of in on at for with as by it its this that these those i you he she we they my your our their me him her us them do does did think not no yes can will would should could have has had there here what who when where why how very really just also too than then from about into if because like'.split(' '));
  function wordItems(a, rs) {
    const m = new Map();
    const add = (key, label) => { const e = m.get(key) || { label, value: 0 }; e.value++; m.set(key, e); };
    for (const r of rs) {
      const text = String((r.answer && r.answer.text) || '').trim();
      if (!text) continue;
      if (a.response_type === 'word') add(text.toLowerCase().replace(/[.,!?;:"'’]+/g, '').trim() || text, text);
      else for (const w of text.toLowerCase().match(/[a-z가-힣]+(?:['’][a-z]+)?/g) || []) if (w.length > 1 && !STOP.has(w)) add(w, w);
    }
    return [...m.values()].sort((x, y) => y.value - x.value);
  }
  function tally(a, rs) {
    const opts = optionsOf(a), n = opts.length, counts = opts.map(() => 0);
    for (const r of rs) {
      const ans = r.answer || {};
      if (a.response_type === 'multi') (ans.choices || []).forEach(i => { if (counts[i] != null) counts[i]++; });
      else if (a.response_type === 'rating') { if (counts[ans.value - 1] != null) counts[ans.value - 1]++; }
      else if (a.response_type === 'rank') (ans.order || []).forEach((i, pos) => { if (counts[i] != null) counts[i] += n - pos; });
      else if (counts[ans.choice] != null) counts[ans.choice]++;
    }
    return opts.map((label, i) => ({ label, value: counts[i], color: COLORS[i % COLORS.length] }));
  }
  const isTally = a => !TEXT_TYPES.includes(a.response_type);
  function itemsFor(a, rs) {
    if (isTally(a)) return tally(a, rs);
    return wordItems(a, rs).slice(0, 20).map((it, i) => ({ ...it, color: COLORS[i % COLORS.length] }));
  }
  // 퍼센트의 기준: 순위 점수·단어 빈도는 전체 합계, 나머지는 응답자 수
  const denom = (a, rs, items) => (a.response_type === 'rank' || !isTally(a)) ? items.reduce((s, i) => s + i.value, 0) : rs.length;
  const unit = a => a.response_type === 'rank' ? '점' : isTally(a) ? '명' : '번';

  function formatAnswer(a, ans) {
    const opts = optionsOf(a); ans = ans || {};
    switch (a.response_type) {
      case 'choice': case 'ox': return opts[ans.choice] ?? '';
      case 'multi': return (ans.choices || []).map(i => opts[i]).join(', ');
      case 'rating': return '★'.repeat(ans.value || 0) + '☆'.repeat(5 - (ans.value || 0));
      case 'rank': return (ans.order || []).map((i, k) => `${k + 1}. ${opts[i]}`).join('   ');
      default: return ans.text || '';
    }
  }

  // ───────────── 결과 그리기 ─────────────
  function barRows(a, rs, items, ranked) {
    const max = Math.max(1, ...items.map(i => i.value)), total = denom(a, rs, items) || 1;
    const medal = k => ['🥇', '🥈', '🥉'][k] || k + 1;
    return items.map((it, k) => `
      <div class="${ranked ? 'rank-row' : 'bar-row'}">
        ${ranked ? `<div class="medal">${medal(k)}</div>` : ''}
        <div class="bar-label">${esc(it.label)}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${(it.value / max) * 100}%;background:${it.color}"></div></div>
        <div class="bar-value">${it.value}${unit(a)} <small>${Math.round((it.value / total) * 100)}%</small></div>
      </div>`).join('');
  }
  const views = {
    bar(a, rs) {
      const items = itemsFor(a, rs);
      let extra = '';
      if (a.response_type === 'rating' && rs.length) {
        const avg = rs.reduce((s, r) => s + ((r.answer && r.answer.value) || 0), 0) / rs.length;
        extra = `<p class="big-count">평균 ★ ${avg.toFixed(1)}</p>`;
      }
      return extra + `<div class="bars">${barRows(a, rs, items, false)}</div>`;
    },
    ranking(a, rs) {
      const items = itemsFor(a, rs).sort((x, y) => y.value - x.value).slice(0, 10);
      return `<div class="bars">${barRows(a, rs, items, true)}</div>`;
    },
    pie(a, rs) {
      const items = itemsFor(a, rs).filter(i => i.value > 0), total = items.reduce((s, i) => s + i.value, 0) || 1;
      let at = 0;
      const stops = items.map(i => { const from = at; at += (i.value / total) * 360; return `${i.color} ${from}deg ${at}deg`; });
      return `<div class="pie-wrap">
        <div class="pie" role="img" aria-label="원형 그래프" style="background:conic-gradient(${stops.join(',') || '#eceae4 0deg 360deg'})"></div>
        <ul class="legend">${items.map(i => `<li><span class="sw" style="background:${i.color}"></span>${esc(i.label)} · ${Math.round((i.value / total) * 100)}% <span class="muted">(${i.value}${unit(a)})</span></li>`).join('')}</ul>
      </div>`;
    },
    wordcloud(a, rs) {
      const items = (isTally(a) ? tally(a, rs).filter(i => i.value) : wordItems(a, rs)).slice(0, 60);
      if (!items.length) return '<p class="empty">표시할 단어가 없어요.</p>';
      const max = items[0].value, out = [];
      items.forEach((it, i) => (i % 2 ? out.push(it) : out.unshift(it))); // 큰 단어가 가운데로
      return `<div class="cloud">${out.map(it => {
        const size = 0.95 + 3.1 * Math.sqrt(it.value / max);
        const color = COLORS[items.indexOf(it) % COLORS.length];
        return `<span style="font-size:${size.toFixed(2)}rem;color:${color}" title="${it.value}번">${esc(it.label)}</span>`;
      }).join('')}</div>`;
    },
    cards(a, rs, all, o) {
      const list = (o.owner ? all : rs).slice();
      list.sort(a.allow_voting ? (x, y) => y.votes - x.votes || x.created_at.localeCompare(y.created_at) : (x, y) => y.created_at.localeCompare(x.created_at));
      return `<div class="cards">${list.map(r => `
        <div class="card ${r.hidden ? 'is-hidden' : ''}">
          <div class="text">${esc(formatAnswer(a, r.answer))}</div>
          <div class="foot">
            <span>${o.showNames && r.author ? esc(r.author) : ''}${r.hidden ? ' (숨김)' : ''}</span>
            <span class="row">
              ${o.owner ? `<button class="small" data-act="hide" data-id="${esc(r.id)}" data-hidden="${r.hidden ? 1 : 0}">${r.hidden ? '보이기' : '숨기기'}</button>` : ''}
              ${a.allow_voting ? (o.onVote && !r.hidden
                ? `<button class="vote ${r.voted ? 'on' : ''}" data-act="vote" data-id="${esc(r.id)}" aria-pressed="${!!r.voted}">${r.voted ? '♥' : '♡'} ${r.votes}</button>`
                : `<span class="vote">♥ ${r.votes}</span>`) : ''}
            </span>
          </div>
        </div>`).join('')}</div>`;
    },
    list(a, rs, all, o) {
      const list = (o.owner ? all : rs).slice().sort((x, y) => y.created_at.localeCompare(x.created_at));
      const time = s => new Date(s).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
      return `<ul class="list">${list.map(r => `
        <li class="${r.hidden ? 'is-hidden' : ''}">
          <span class="ans">${esc(formatAnswer(a, r.answer))}</span>
          ${o.showNames && r.author ? `<span class="who">${esc(r.author)}</span>` : ''}
          <time>${time(r.created_at)}</time>
          ${o.owner ? `<button class="small" data-act="hide" data-id="${esc(r.id)}" data-hidden="${r.hidden ? 1 : 0}">${r.hidden ? '보이기' : '숨기기'}</button>` : ''}
        </li>`).join('')}</ul>`;
    },
  };

  // el 안에 결과를 그립니다. opts: { owner, showNames, onVote(id), onHide(id, hidden) }
  function renderResults(el, a, all, view, opts = {}) {
    const key = JSON.stringify([a, all, view, opts.showNames, !!opts.owner]);
    if (el._lpKey === key) return; // 바뀐 것이 없으면 다시 그리지 않음(깜빡임 방지)
    el._lpKey = key;
    const rs = all.filter(r => !r.hidden);
    if (!view || !TYPES[a.response_type].views.includes(view)) view = TYPES[a.response_type].views[0];
    el.innerHTML = (opts.owner ? all : rs).length
      ? views[view](a, rs, all, opts)
      : '<p class="empty">아직 응답이 없어요. 답을 기다리는 중…</p>';
    el.onclick = e => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'vote' && opts.onVote) opts.onVote(b.dataset.id);
      if (b.dataset.act === 'hide' && opts.onHide) opts.onHide(b.dataset.id, b.dataset.hidden !== '1');
    };
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
  }
  function demoBanner(el) {
    if (DEMO && el) el.innerHTML = '<div class="note warn"><b>데모 모드</b> — 지금은 이 컴퓨터의 브라우저 안에서만 작동해요. 같은 브라우저에서 탭을 여러 개 열어 시험해 볼 수 있어요. 여러 크롬북에서 쓰려면 <code>config.js</code>에 Supabase 정보를 넣으세요. (사용방법.txt 참고)</div>';
  }

  let api;
  try { api = DEMO ? localApi() : supabaseApi(); } catch (e) { api = null; setTimeout(() => alert(e.message)); }

  return { DEMO, api, $, esc, TYPES, TEXT_TYPES, TEXT_LIMIT, VIEWS, ERRORS, friendly, optionsOf, cleanAnswer, formatAnswer, renderResults, toast, demoBanner, getStore, setStore };
})();
