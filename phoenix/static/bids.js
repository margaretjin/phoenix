// =========================================================
// [bids.js] 아이템 입찰
//  - 우선권자 = 아이템이 드랍된 보스탐 참여자
//  - 우선권 시간 안에 우선권자 입찰 없음 → 관리자가 '전체 혈원 입찰 열기' 체크 가능
//  - 우선권자가 신청하면 전체 열기 체크박스는 잠김
// =========================================================
const HOUR = 60 * 60 * 1000;
let bids = [];
let pickerItems = [];       // 입찰 등록용 아이템 후보
let bidTab = 'open';
let clockOffset = 0;        // 서버 시각 - 내 PC 시각 (ms)

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
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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
// ---------------------------------------------------------
function bidState(b) {
    const t = now();
    const start = Date.parse(b.start_at);
    const end = Date.parse(b.end_at);
    const priorityEnd = start + Number(b.priority_hours || 0) * HOUR;
    const entries = b.entries || [];
    const hasPriorityEntry = entries.some(e => e.is_priority);
    const me = ClanApp.user.active_id;
    const isPriorityMember = (b.priority_members || []).includes(me);
    const myEntry = entries.find(e => e.member_id === me);

    let phase;
    if (b.status === '확정') phase = 'done';
    else if (b.status === '취소') phase = 'cancel';
    else if (t < start) phase = 'before';
    else if (t >= end) phase = 'closed';
    else if (t < priorityEnd) phase = 'priority';
    else if (b.open_to_all) phase = 'all';
    else if (hasPriorityEntry) phase = 'priorityDone';
    else phase = 'waitOpen';

    const live = b.status === '진행' && t >= start && t < end;
    return {
        phase, start, end, priorityEnd, entries, hasPriorityEntry, isPriorityMember, myEntry,
        canApply: live && !myEntry && (isPriorityMember || b.open_to_all),
        canCancel: live && Boolean(myEntry),
        canOpenAll: b.status === '진행' && t >= priorityEnd && t < end && !hasPriorityEntry
    };
}

const PHASE_BADGE = {
    before: ['시작 전', 'gray'],
    priority: ['우선권자 입찰 중', 'blue'],
    all: ['전체 혈원 입찰 중', 'green'],
    priorityDone: ['우선권자 입찰 완료', 'sky'],
    waitOpen: ['우선권 마감 · 전체 열기 대기', 'amber'],
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
    else if (['all', 'priorityDone', 'waitOpen'].includes(s.phase)) remain = `종료까지 ${fmtRemain(s.end - t)}`;
    const step = (label, ts, active) => `<span class="tl-step ${active ? 'active' : ''}"><em>${label}</em>${fmtDateTime(ts)}</span>`;
    return `
        <div class="bid-timeline">
            ${step('시작', s.start, s.phase === 'before')}
            ${step('우선권 마감', s.priorityEnd, s.phase === 'priority')}
            ${step('종료', s.end, ['all', 'priorityDone', 'waitOpen'].includes(s.phase))}
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
                <span class="my-note c-muted">${(s.isPriorityMember && !b.open_to_all) ? '우선권자로 입찰합니다' : '전체 혈원 입찰'}</span>`;
    }
    let reason = '';
    if (s.phase === 'before') reason = '아직 시작 전입니다';
    else if (['closed', 'done', 'cancel'].includes(s.phase)) reason = s.myEntry ? '입찰했던 아이템입니다' : '';
    else if (!s.isPriorityMember && !b.open_to_all) {
        reason = s.phase === 'priority' ? '지금은 해당 보스탐 참여자만 입찰할 수 있습니다' : '전체 혈원 입찰이 열리면 입찰할 수 있습니다';
    }
    return reason ? `<span class="my-note c-muted">${reason}</span>` : '';
}

function adminActionHtml(b, s) {
    if (!ClanApp.isAdminModeOn || b.status !== '진행') {
        return (ClanApp.isAdminModeOn && b.status !== '진행')
            ? `<div class="bid-admin"><button type="button" class="btn-row-del" onclick="deleteBid(${b.id})">기록 삭제</button></div>`
            : '';
    }
    let openHint = '';
    if (b.open_to_all) openHint = '열림';
    else if (s.hasPriorityEntry) openHint = '우선권자가 입찰해서 열 수 없음';
    else if (now() < s.priorityEnd) openHint = `우선권 마감(${fmtDateTime(s.priorityEnd)}) 후 가능`;
    else if (now() >= s.end) openHint = '입찰 종료됨';

    const openDisabled = b.open_to_all
        ? s.entries.some(e => !e.is_priority)          // 일반 입찰자가 있으면 닫기 불가
        : !s.canOpenAll;
    const winnerOptions = s.entries.map((e, i) =>
        `<option value="${esc(e.member_id)}">${i + 1}. ${esc(e.member_id)}${e.is_priority ? ' (우선권)' : ''}</option>`).join('');

    return `
        <div class="bid-admin">
            <label class="open-all-check ${openDisabled ? 'disabled' : ''}">
                <input type="checkbox" ${b.open_to_all ? 'checked' : ''} ${openDisabled ? 'disabled' : ''}
                       onchange="toggleOpenAll(${b.id}, this.checked)">
                전체 혈원 입찰 열기 ${openHint ? `<small>(${openHint})</small>` : ''}
            </label>
            <div class="row-actions">
                <select id="winnerSel_${b.id}" class="tbl-select winner-select" ${s.entries.length ? '' : 'disabled'}>
                    ${winnerOptions || '<option value="">입찰자 없음</option>'}
                </select>
                <button type="button" class="btn-sm btn-sm-blue btn-xs" ${s.entries.length ? '' : 'disabled'} onclick="confirmBid(${b.id})">구매자 확정</button>
                <button type="button" class="btn-row-del" onclick="cancelBid(${b.id})">입찰 취소</button>
            </div>
        </div>`;
}

function bidCardHtml(b) {
    const s = bidState(b);
    const [phaseLabel, tone] = PHASE_BADGE[s.phase];
    const applied = new Set(s.entries.map(e => e.member_id));
    const priorityChips = (b.priority_members || []).map(id =>
        `<span class="member-chip ${applied.has(id) ? 'applied' : ''}">${applied.has(id) ? '🙋 ' : ''}${esc(id)}</span>`).join('')
        || '<span class="c-dim">참여자 없음</span>';
    const entryRows = s.entries.map((e, i) => `
        <li class="${b.winner === e.member_id ? 'winner' : ''}">
            <span class="entry-no">${i + 1}</span>
            <span class="entry-name">${esc(e.member_id)}</span>
            ${e.is_priority ? ClanApp.badge('우선권', 'blue', 'badge-sm') : ClanApp.badge('일반', 'gray', 'badge-sm')}
            <span class="entry-time">${fmtDateTime(Date.parse(e.created_at))}</span>
            ${b.winner === e.member_id ? ClanApp.badge('구매 확정', 'green', 'badge-sm') : ''}
        </li>`).join('');

    return `
        <article class="bid-card phase-${s.phase}">
            <div class="bid-card-head">
                <span class="bid-item-name">🎁 ${ClanApp.itemNameHtml(b.item_name)}</span>
                ${ClanApp.badge(phaseLabel, tone)}
                <span class="bid-price">${Number(b.price || 0).toLocaleString()}<small> 아데나</small></span>
            </div>
            <div class="bid-sub">
                드랍 ${ClanApp.toShortDate(b.raid_date)} ${esc(b.raid_time)}
                ${b.winner ? ` · 구매자 <b class="c-mint">${esc(b.winner)}</b>` : ''}
                ${b.memo ? ` · ${esc(b.memo)}` : ''}
            </div>
            ${timelineHtml(b, s)}
            <div class="bid-section">
                <div class="bid-section-label">우선권자 (보스탐 참여자 ${(b.priority_members || []).length}명)</div>
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
    const msg = open ? '전체 혈원에게 입찰을 열겠습니까?' : '전체 혈원 입찰을 다시 닫겠습니까?';
    if (!confirm(msg)) return renderBids();
    await ClanApp.send(`/api/bids/${id}/open-all`, { body: { open, requester_role: ClanApp.role }, failMsg: '변경 실패' });
    await loadBids();
}

async function confirmBid(id) {
    const b = bids.find(x => x.id === id);
    const winner = ($id(`winnerSel_${id}`) || {}).value;
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
        <div class="member-chip-list">${members.map(m => `<span class="member-chip">${esc(m)}</span>`).join('') || '<span class="c-dim">참여자 기록 없음 (바로 전체 열기 가능)</span>'}</div>`;
    box.classList.remove('hidden');
}

function readFormTimes() {
    const start = new Date($id('bidStartAt').value);
    const end = new Date($id('bidEndAt').value);
    const hours = Number($id('bidPriorityHours').value || 0);
    return { start, end, hours, priorityEnd: new Date(start.getTime() + hours * HOUR) };
}

function updatePriorityPreview() {
    const { start, end, hours, priorityEnd } = readFormTimes();
    const el = $id('bidPriorityPreview');
    if (isNaN(start) || isNaN(end)) { el.textContent = ''; return; }
    const warn = priorityEnd > end ? ' ⚠️ 우선권 시간이 종료 시간을 넘습니다' : '';
    el.textContent = `우선권 마감: ${fmtDateTime(priorityEnd)} (${hours}시간) · 종료: ${fmtDateTime(end)}${warn}`;
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