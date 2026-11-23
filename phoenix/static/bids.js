// =========================================================
// [bids.js] 아이템 입찰
//  - 우선권자 = 아이템이 드랍된 보스탐 참여자
//  - 우선권 시간 안에 우선권자 입찰 없음 → 우선권 시간이 끝나면 자동으로 전체 혈원 입찰
//  - 우선권 시간 안에 우선권자가 입찰하면 우선권자끼리 진행 (자동으로 열리지 않음)
//  - 관리자는 언제든 '전체 혈원 입찰 열기' 가능 / 등록 때 처음부터 전체 혈원 입찰 가능
// =========================================================
const HOUR = 60 * 60 * 1000;
let bids = [];
let pickerItems = [];       // 입찰 등록용 아이템 후보
let bidTab = 'open';
let clockOffset = 0;        // 서버 시각 - 내 PC 시각 (ms)
let createMode = 'priority'; // 등록 방식: priority(우선권 입찰) | all(처음부터 전체 혈원)

window.onload = async () => {
    const user = ClanApp.initPage('/bids', () => {
        renderBids();
        if (ClanApp.isAdminModeOn && pickerItems.length === 0) loadRaidsForPicker();
    });
    if (!user) return;

    $id('bidRaidMonth').value = ClanApp.formatYM();
    resetCreateForm();
    await ClanApp.loadMeta();
    await loadBids();
    if (ClanApp.isAdminModeOn) await loadRaidsForPicker();

    // 1분마다 새로고침 (우선권 마감 · 종료 시간 반영)
    setInterval(loadBids, 60 * 1000);
};

const now = () => Date.now() + clockOffset;
const esc = (v) => ClanApp.escapeHtml(v);

function fmtDateTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}월 ${d.getDate()}일 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtRemain(ms) {
    if (ms <= 0) return '0분';
    const h = Math.floor(ms / HOUR);
    const m = Math.floor((ms % HOUR) / 60000);
    if (h >= 24) return `${Math.floor(h / 24)}일 ${h % 24}시간`;
    return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

// datetime-local 값 <-> Date
function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------
// 입찰 상태 계산 (서버 규칙과 동일)
//  - 우선권 시간 안에 우선권자 입찰이 없으면 → 우선권 시간이 끝나는 순간 자동으로 전체 혈원
//  - 관리자는 언제든 전체 혈원 입찰을 열 수 있음 (open_to_all)
// ---------------------------------------------------------
function bidState(b) {
    const t = now();
    const start = Date.parse(b.start_at);
    const end = Date.parse(b.end_at);
    const priorityHours = Number(b.priority_hours || 0);
    const priorityEnd = start + priorityHours * HOUR;
    const entries = b.entries || [];
    const priorityBidInWindow = entries.some(e => e.is_priority && Date.parse(e.created_at) < priorityEnd);
    const autoOpen = t >= priorityEnd && !priorityBidInWindow;
    const openAll = Boolean(b.open_to_all) || autoOpen;
    const allFromStart = Boolean(b.open_to_all) && priorityHours === 0;
    const me = ClanApp.user.active_id;
    const isPriorityMember = (b.priority_members || []).includes(me);
    const myEntry = entries.find(e => e.member_id === me);

    let phase;
    if (b.status === '확정') phase = 'done';
    else if (b.status === '취소') phase = 'cancel';
    else if (t < start) phase = 'before';
    else if (t >= end) phase = 'closed';
    else if (openAll) phase = 'all';
    else if (t < priorityEnd) phase = 'priority';
    else phase = 'priorityOnly';          // 우선권 시간 안에 우선권자가 입찰 → 우선권자끼리

    const live = b.status === '진행' && t >= start && t < end;
    return {
        phase, start, end, priorityEnd, entries, openAll, autoOpen, allFromStart, isPriorityMember, myEntry,
        canApply: live && !myEntry && (isPriorityMember || openAll),
        canCancel: live && Boolean(myEntry)
    };
}

const PHASE_BADGE = {
    before: ['시작 전', 'gray'],
    priority: ['우선권자 입찰 중', 'blue'],
    all: ['전체 혈원 입찰 중', 'green'],
    priorityOnly: ['우선권자 입찰 (우선권자끼리)', 'sky'],
    closed: ['입찰 마감 · 확정 대기', 'pink'],
    done: ['구매 확정', 'gray'],
    cancel: ['취소됨', 'rose']
};

function tabOf(b) {
    if (b.status === '확정') return 'done';
    if (b.status === '취소') return 'cancel';
    return now() >= Date.parse(b.end_at) ? 'closed' : 'open';
}

// ---------------------------------------------------------
// 목록
// ---------------------------------------------------------
async function loadBids() {
    const data = await ClanApp.getJSON('/api/bids', null);
    if (!data) {
        $id('bidList').innerHTML = `<div class="empty-party-msg">입찰 목록을 불러오지 못했습니다.</div>`;
        return;
    }
    if (data.server_now) clockOffset = Date.parse(data.server_now) - Date.now();
    bids = data.bids || [];
    renderBids();
}

function setBidTab(tab) {
    bidTab = tab;
    ClanApp.setActiveTab('bidTabs', tab);
    renderBids();
}

function renderBids() {
    const counts = { open: 0, closed: 0, done: 0 };
    bids.forEach(b => { const k = tabOf(b); if (k in counts) counts[k]++; });
    $id('cntOpen').textContent = counts.open;
    $id('cntClosed').textContent = counts.closed;
    $id('cntDone').textContent = counts.done;
    $id('bidCountLabel').textContent = `진행 ${counts.open}건`;

    const list = bidTab === 'all' ? bids : bids.filter(b => tabOf(b) === bidTab);
    $id('bidList').innerHTML = list.length
        ? list.map(bidCardHtml).join('')
        : `<div class="empty-party-msg">해당하는 입찰이 없습니다.</div>`;
}

function timelineHtml(b, s) {
    const t = now();
    let remain = '';
    if (s.phase === 'before') remain = `시작까지 ${fmtRemain(s.start - t)}`;
    else if (s.phase === 'priority') remain = `우선권 마감까지 ${fmtRemain(s.priorityEnd - t)}`;
    else if (['all', 'priorityOnly'].includes(s.phase)) remain = `종료까지 ${fmtRemain(s.end - t)}`;
    const step = (label, ts, active) => `<span class="tl-step ${active ? 'active' : ''}"><em>${label}</em>${fmtDateTime(ts)}</span>`;
    return `
        <div class="bid-timeline">
            ${step('시작', s.start, s.phase === 'before')}
            ${s.allFromStart ? '' : step('우선권 마감', s.priorityEnd, s.phase === 'priority')}
            ${step('종료', s.end, ['all', 'priorityOnly'].includes(s.phase))}
            ${remain ? `<span class="tl-remain">⏱ ${remain}</span>` : ''}
        </div>`;
}

function myActionHtml(b, s) {
    if (s.canCancel) {
        return `<button type="button" class="btn-sm btn-sm-dark" onclick="cancelApply(${b.id})">입찰 취소</button>
                <span class="my-note c-money">✔ 입찰했습니다</span>`;
    }
    if (s.canApply) {
        return `<button type="button" class="btn-sm btn-sm-green bid-apply-btn" onclick="applyBid(${b.id})">🙋 입찰</button>
                <span class="my-note c-muted">${(s.isPriorityMember && !s.openAll) ? '우선권자로 입찰합니다' : '전체 혈원 입찰'}</span>`;
    }
    let reason = '';
    if (s.phase === 'before') reason = '아직 시작 전입니다';
    else if (['closed', 'done', 'cancel'].includes(s.phase)) reason = s.myEntry ? '입찰했던 아이템입니다' : '';
    else if (!s.isPriorityMember && !s.openAll) {
        reason = s.phase === 'priority'
            ? `지금은 해당 보스탐 참여자만 입찰할 수 있습니다 (${fmtDateTime(s.priorityEnd)}까지)`
            : '우선권자가 입찰해서 우선권자끼리 진행됩니다';
    }
    return reason ? `<span class="my-note c-muted">${reason}</span>` : '';
}

function adminActionHtml(b, s) {
    if (!ClanApp.isAdminModeOn) return '';
    if (b.status !== '진행') {
        return `<div class="bid-admin"><span></span><button type="button" class="btn-row-del" onclick="deleteBid(${b.id})">기록 삭제</button></div>`;
    }
    const ended = now() >= s.end;
    let hint = '';
    let disabled = ended;
    if (s.allFromStart) { hint = '처음부터 전체 혈원'; disabled = true; }
    else if (s.autoOpen) { hint = '우선권 시간 종료 · 자동으로 열림'; disabled = true; }
    else if (b.open_to_all && s.entries.some(e => !e.is_priority)) { hint = '일반 혈원 입찰자가 있어 닫을 수 없음'; disabled = true; }
    else if (ended) hint = '입찰 종료됨';
    else if (!b.open_to_all) hint = s.phase === 'priority' ? `우선권 마감(${fmtDateTime(s.priorityEnd)}) 전에도 직접 열 수 있음` : '우선권자끼리 진행 중 · 직접 열 수 있음';

    return `
        <div class="bid-admin">
            <label class="open-all-check ${disabled ? 'disabled' : ''}">
                <input type="checkbox" ${s.openAll ? 'checked' : ''} ${disabled ? 'disabled' : ''}
                       onchange="toggleOpenAll(${b.id}, this.checked)">
                전체 혈원 입찰 열기 ${hint ? `<small>(${hint})</small>` : ''}
            </label>
            <button type="button" class="btn-row-del" onclick="cancelBid(${b.id})">입찰 취소</button>
        </div>`;
}

function entryRowHtml(b, s, e, i) {
    const isWinner = b.winner === e.member_id;
    // 전체 혈원 입찰이면 우선권 구분 없이 표시
    const kindBadge = s.openAll ? '' : (e.is_priority ? ClanApp.badge('우선권', 'blue', 'badge-sm') : ClanApp.badge('일반', 'gray', 'badge-sm'));
    const confirmBtn = (ClanApp.isAdminModeOn && b.status === '진행')
        ? `<button type="button" class="btn-sm btn-sm-blue btn-xs" onclick="confirmBid(${b.id}, ${ClanApp.jsArg(e.member_id)})">구매자 확정</button>`
        : '';
    return `
        <li class="${isWinner ? 'winner' : ''}">
            <span class="entry-no">${i + 1}</span>
            <span class="entry-name">${esc(e.member_id)}</span>
            ${kindBadge}
            ${isWinner ? ClanApp.badge('구매 확정', 'green', 'badge-sm') : ''}
            <span class="entry-time">${fmtDateTime(Date.parse(e.created_at))}</span>
            ${confirmBtn}
        </li>`;
}

function bidCardHtml(b) {
    const s = bidState(b);
    const [phaseLabel, tone] = PHASE_BADGE[s.phase];
    const applied = new Set(s.entries.map(e => e.member_id));
    const priorityChips = (b.priority_members || []).map(id =>
        `<span class="member-chip ${applied.has(id) ? 'applied' : ''}">${applied.has(id) ? '🙋 ' : ''}${esc(id)}</span>`).join('')
        || '<span class="c-dim">참여자 없음</span>';
    const entryRows = s.entries.map((e, i) => entryRowHtml(b, s, e, i)).join('');
    const priorityLabel = s.allFromStart
        ? `보스탐 참여자 ${(b.priority_members || []).length}명 (처음부터 전체 혈원 입찰 · 우선권 없음)`
        : `우선권자 (보스탐 참여자 ${(b.priority_members || []).length}명)`;

    return `
        <article class="bid-card phase-${s.phase}">
            <div class="bid-card-head">
                <span class="bid-item-name">🎁 ${ClanApp.itemNameHtml(b.item_name)}</span>
                ${ClanApp.badge(phaseLabel, tone)}
                <span class="bid-price">${Number(b.price || 0).toLocaleString()}<small> 아데나</small></span>
            </div>
            <div class="bid-sub">
                드랍 ${ClanApp.formatHeaderLabel(b.raid_date, b.raid_time)}
                ${b.winner ? ` · 구매자 <b class="c-mint">${esc(b.winner)}</b>` : ''}
                ${b.memo ? ` · ${esc(b.memo)}` : ''}
            </div>
            ${timelineHtml(b, s)}
            <div class="bid-section">
                <div class="bid-section-label">${priorityLabel}</div>
                <div class="member-chip-list">${priorityChips}</div>
            </div>
            <div class="bid-section">
                <div class="bid-section-label">입찰자 ${s.entries.length}명 (입찰 순)</div>
                ${entryRows ? `<ol class="entry-list">${entryRows}</ol>` : '<div class="c-dim entry-empty">아직 입찰자가 없습니다.</div>'}
            </div>
            <div class="bid-my-action">${myActionHtml(b, s)}</div>
            ${adminActionHtml(b, s)}
        </article>`;
}

// ---------------------------------------------------------
// 혈원 신청 / 취소
// ---------------------------------------------------------
async function applyBid(id) {
    const b = bids.find(x => x.id === id);
    if (!b || !confirm(`[${ClanApp.getItemAlias(b.item_name)}] ${Number(b.price || 0).toLocaleString()} 아데나 에 입찰하시겠습니까?`)) return;
    if (await ClanApp.send(`/api/bids/${id}/apply`, { body: { member_id: ClanApp.user.active_id }, failMsg: '입찰 실패' })) {
        await loadBids();
    }
}

async function cancelApply(id) {
    if (!confirm('입찰을 취소하시겠습니까?')) return;
    const qs = new URLSearchParams({ member_id: ClanApp.user.active_id });
    if (await ClanApp.del(`/api/bids/${id}/apply?${qs}`, '입찰 취소 실패')) await loadBids();
}

// ---------------------------------------------------------
// 관리자
// ---------------------------------------------------------
async function toggleOpenAll(id, open) {
    const b = bids.find(x => x.id === id);
    const hasPriority = b && (b.entries || []).some(e => e.is_priority);
    const msg = open
        ? (hasPriority ? '이미 우선권자 입찰이 있습니다. 그래도 전체 혈원에게 입찰을 열겠습니까?' : '전체 혈원에게 입찰을 열겠습니까?')
        : '전체 혈원 입찰을 다시 닫겠습니까? (우선권자만 입찰)';
    if (!confirm(msg)) return renderBids();
    await ClanApp.send(`/api/bids/${id}/open-all`, { body: { open, requester_role: ClanApp.role }, failMsg: '변경 실패' });
    await loadBids();
}

async function confirmBid(id, winner) {
    const b = bids.find(x => x.id === id);
    if (!b || !winner) return;
    if (!confirm(`[${winner}] 님을 구매자로 확정하시겠습니까?\n템보유현황에 [피닉스 · 내판 · ${winner} · ${Number(b.price || 0).toLocaleString()}]으로 반영됩니다.\n(수령완료일은 아이템을 건넨 분이 템보유현황에서 지정)`)) return;
    if (await ClanApp.send(`/api/bids/${id}/confirm`, { body: { winner, requester_role: ClanApp.role }, failMsg: '확정 실패' })) {
        await loadBids();
        await loadRaidsForPicker();
    }
}

async function cancelBid(id) {
    if (!confirm('이 입찰을 취소하시겠습니까? (입찰 기록은 남습니다)')) return;
    if (await ClanApp.send(`/api/bids/${id}/cancel?${ClanApp.roleParam('requester_role')}`, { failMsg: '취소 실패' })) {
        await loadBids();
        await loadRaidsForPicker();
    }
}

async function deleteBid(id) {
    if (!confirm('입찰 기록을 완전히 삭제하시겠습니까?')) return;
    if (await ClanApp.del(`/api/bids/${id}?${ClanApp.roleParam('requester_role')}`)) await loadBids();
}

// ---------------------------------------------------------
// 입찰 등록 (관리자)
// ---------------------------------------------------------
function resetCreateForm() {
    const start = new Date();
    start.setSeconds(0, 0);
    $id('bidStartAt').value = toLocalInput(start);
    $id('bidEndAt').value = toLocalInput(new Date(start.getTime() + 24 * HOUR));
    $id('bidPriorityHours').value = 12;
    $id('bidPrice').value = '';
    $id('bidMemo').value = '';
    setCreateMode('priority');
}

// 등록 방식 버튼: 우선권 입찰 / 처음부터 전체 혈원 입찰
function setCreateMode(mode) {
    createMode = mode;
    ClanApp.setActiveTab('bidModeTabs', mode);
    $id('bidPriorityHours').disabled = mode === 'all';
    $id('priorityHoursField').classList.toggle('is-off', mode === 'all');
    updatePriorityPreview();
}

async function loadRaidsForPicker() {
    if (!ClanApp.isAdminModeOn) return;
    const raids = await ClanApp.fetchRaids({ month: $id('bidRaidMonth').value || ClanApp.formatYM() });
    const openKeys = new Set(bids.filter(b => b.status === '진행').map(b => `${b.raid_id}_${b.item_idx}`));

    pickerItems = [];
    raids.forEach(r => {
        ClanApp.extractItemDetails(r).forEach((it, idx) => {
            if (it.sale_type !== '보유중' || it.event_item || it.clan_owned || ClanApp.isCastleTaxItem(it.name)) return;
            if (openKeys.has(`${r.id}_${idx}`)) return;
            pickerItems.push({ raid: r, idx, item: it });
        });
    });

    const sel = $id('bidItemSelect');
    sel.innerHTML = `<option value="">${pickerItems.length ? '아이템을 선택하세요' : '입찰 가능한 아이템이 없습니다'}</option>` +
        pickerItems.map((p, i) => `<option value="${i}">${ClanApp.toShortDate(p.raid.raid_date)} ${esc(p.raid.raid_time)} · ${esc(ClanApp.getItemAlias(p.item.name))}` +
            `${p.item.alliance === '피닉스' ? ' (피닉스 판매대기)' : ''} · 내판가 ${Number(p.item.policy_price || 0).toLocaleString()}</option>`).join('');
    onBidItemChange();
}

function onBidItemChange() {
    const p = pickerItems[Number($id('bidItemSelect').value)];
    const box = $id('bidItemInfo');
    if (!p || $id('bidItemSelect').value === '') {
        box.classList.add('hidden');
        return;
    }
    $id('bidPrice').value = p.item.policy_price || p.item.price || '';
    const members = ClanApp.participantIds(p.raid);
    box.innerHTML = `
        <div><b>${ClanApp.itemNameHtml(p.item.name)}</b> · 드랍 <b>${ClanApp.formatHeaderLabel(p.raid.raid_date, p.raid.raid_time)}</b></div>
        <div class="bid-section-label">우선권자 = 이 보스탐 참여자 ${members.length}명</div>
        <div class="member-chip-list">${members.map(m => `<span class="member-chip">${esc(m)}</span>`).join('') || '<span class="c-dim">참여자 기록 없음 (처음부터 전체 혈원 입찰 추천)</span>'}</div>`;
    box.classList.remove('hidden');
}

function readFormTimes() {
    const start = new Date($id('bidStartAt').value);
    const end = new Date($id('bidEndAt').value);
    const hours = createMode === 'all' ? 0 : Number($id('bidPriorityHours').value || 0);
    return { start, end, hours, priorityEnd: new Date(start.getTime() + hours * HOUR) };
}

function updatePriorityPreview() {
    const { start, end, hours, priorityEnd } = readFormTimes();
    const el = $id('bidPriorityPreview');
    if (isNaN(start) || isNaN(end)) { el.textContent = ''; return; }
    if (createMode === 'all') {
        el.textContent = `처음부터 전체 혈원 입찰 · ${fmtDateTime(start)} ~ ${fmtDateTime(end)}`;
        return;
    }
    const warn = priorityEnd > end ? ' ⚠️ 우선권 시간이 종료 시간을 넘습니다' : '';
    el.textContent = `우선권 마감: ${fmtDateTime(priorityEnd)} (${hours}시간, 우선권자 입찰이 없으면 자동으로 전체 혈원) · 종료: ${fmtDateTime(end)}${warn}`;
}

async function createBid() {
    if (!ClanApp.isAdminModeOn) return;
    const p = pickerItems[Number($id('bidItemSelect').value)];
    if (!p || $id('bidItemSelect').value === '') return alert('입찰할 아이템을 선택해 주세요.');
    const { start, end, hours, priorityEnd } = readFormTimes();
    if (isNaN(start) || isNaN(end) || end <= start) return alert('종료 시간은 시작 시간보다 뒤여야 합니다.');
    if (priorityEnd > end) return alert('우선권 시간이 입찰 종료 시간을 넘어갑니다.');

    const ok = await ClanApp.send('/api/bids', {
        body: {
            raid_id: p.raid.id,
            item_idx: p.idx,
            item_name: p.item.name,
            price: Number($id('bidPrice').value || 0),
            start_at: start.toISOString(),
            end_at: end.toISOString(),
            priority_hours: hours,
            open_to_all: createMode === 'all',
            memo: $id('bidMemo').value.trim(),
            requester_role: ClanApp.role,
            requester_id: ClanApp.user.active_id
        },
        failMsg: '입찰 등록 실패'
    });
    if (ok) {
        resetCreateForm();
        await loadBids();
        await loadRaidsForPicker();
        setBidTab('open');
    }
}
