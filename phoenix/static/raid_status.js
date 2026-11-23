// =========================================================
// [raid_status.js] 일별 기록 현황
// =========================================================
let selectedDate = '';
let selectedTime = '';
let dayRaids = [];
let editableItems = [];
let castleBonusMap = {};   // 공성 기록의 성세금 아이템 key -> { bonusPrice, includedItems }

window.onload = async () => {
    const user = ClanApp.initPage('/raid-status', () => {
        renderTimeGrid();
        renderSlotDetails();
    });
    if (!user) return;

    const now = new Date();
    selectedDate = ClanApp.formatYMD(now);
    selectedTime = ClanApp.getDefaultRaidTime(now);
    updateDateDisplay();

    await ClanApp.loadMeta();
    $id('taxLabel').textContent = `혈비 ${ClanApp.taxRate}%`;
    await loadDateRaids();
};

// ---------------------------------------------------------
// 날짜 / 시간 선택
// ---------------------------------------------------------
function updateDateDisplay() {
    if (!ClanApp.getRaidTimes(selectedDate).includes(selectedTime)) {
        selectedTime = ClanApp.getDefaultRaidTime(new Date());
    }
    $id('displaySelectedDate').textContent = ClanApp.formatHeaderLabel(selectedDate, selectedTime);
    $id('statusDatePicker').value = selectedDate;
}

function changeDate(dateStr) {
    selectedDate = dateStr;
    updateDateDisplay();
    loadDateRaids();
}

function onDateInputChange() {
    const val = $id('statusDatePicker').value;
    if (val) changeDate(val);
}

function moveDay(offset) {
    changeDate(ClanApp.shiftDate(selectedDate, offset));
}

function setToday() {
    selectedTime = ClanApp.getDefaultRaidTime(new Date());
    changeDate(ClanApp.today());
}

function selectRaidTime(t) {
    selectedTime = t;
    updateDateDisplay();
    renderTimeGrid();
    syncEditableItemsFromRecord();
    renderSlotDetails();
}

// ---------------------------------------------------------
// 데이터
// ---------------------------------------------------------
// 성세금포함 아이템 금액은 지정 일자의 성세금 아이템 풀에 합산된다.
// 이 날짜에 성세금 아이템이 있을 때만 전체 기록을 불러와 합산 대상을 계산한다.
async function loadCastleBonusMap() {
    castleBonusMap = {};
    const hasTax = dayRaids.some(r => ClanApp.extractItemDetails(r).some(it => ClanApp.isCastleTaxItem(it.name)));
    if (!hasTax) return;
    castleBonusMap = ClanApp.buildCastleTaxBonusMap(await ClanApp.fetchRaids());
}

async function loadDateRaids() {
    dayRaids = await ClanApp.fetchRaids({ date: selectedDate });
    await loadCastleBonusMap();
    updateDaySummaryKPI();
    renderTimeGrid();
    syncEditableItemsFromRecord();
    renderSlotDetails();
}

function getCurrentRecord() {
    return dayRaids.find(r => r.raid_time === selectedTime) || null;
}

function syncEditableItemsFromRecord() {
    editableItems = ClanApp.extractItemDetails(getCurrentRecord());
}

function bonusOf(rec, idx) {
    return rec ? castleBonusMap[`${rec.id}_${idx}`] || null : null;
}

// ---------------------------------------------------------
// 렌더링
// ---------------------------------------------------------
function updateDaySummaryKPI() {
    const names = dayRaids.flatMap(r => ClanApp.extractItemDetails(r).map(it => it.name));
    $id('sumDropCount').textContent = `${names.length}개`;
    $id('sumDropList').innerHTML = names.length === 0
        ? `<span class="summary-none">없음</span>`
        : ClanApp.countChips(names, 'summary-drop-chip');
}

function renderTimeGrid() {
    $id('statusTimeGrid').innerHTML = ClanApp.getRaidTimes(selectedDate).map(t => {
        const rec = dayRaids.find(r => r.raid_time === t);
        const pCount = rec ? ClanApp.extractParticipants(rec).length : 0;
        const hasRecord = pCount > 0 || (rec ? ClanApp.extractItemDetails(rec).length > 0 : false);
        return `
            <button type="button"
                    class="common-time-btn ${hasRecord ? 'has-record' : ''} ${t === selectedTime ? 'active' : ''}"${ClanApp.slotAttr(t)}
                    onclick="selectRaidTime('${t}')">
                <span>${t}</span>
                <span class="common-time-sub">${hasRecord ? `${pCount}명` : '기록없음'}</span>
            </button>`;
    }).join('');
}

function getEffectiveItemPrice(item) {
    if (item.sale_type === '이벤트') return 0;
    const saved = Number(item.price || 0);
    return saved > 0 ? saved : Number(ClanApp.priceMap[item.name] || 0);
}

// 일별현황 아이템 구분 배지 (템보유현황과 동일한 색상)
function getItemStatusBadge(item, rec, itemIdx) {
    const winner = (item.winner || '').trim();
    let label = item.alliance === '피닉스' ? '피닉스 판매대기' : '연합분배대기';
    let tone = item.alliance === '피닉스' ? 'pink' : 'amber';

    if (item.event_item) {
        [label, tone] = ['이벤트템', 'purple'];
    } else if (item.clan_owned) {
        [label, tone] = [winner ? `연합(${winner})` : '혈비귀속', 'teal'];
    } else if (item.sale_type === '연합') {
        const where = (item.alliance && item.alliance !== '피닉스') ? item.alliance : winner;
        [label, tone] = [where ? `연합(${where})` : '연합', 'teal'];
    } else if (item.sale_type === '내판' || item.sale_type === '외판') {
        label = `${item.sale_type} · ${ClanApp.distProgress(rec, item, itemIdx).label}`;
        tone = ClanApp.HOLD_TONE[item.sale_type];
    } else if (['성세금포함', '분배금혈귀', '이벤트'].includes(item.sale_type)) {
        [label, tone] = [item.sale_type, ClanApp.HOLD_TONE[item.sale_type]];
    }
    return ClanApp.badge(label, tone, 'badge-sm item-status-tag');
}

function renderSlotDetails() {
    const rec = getCurrentRecord();
    const parties = (rec && rec.parties) || [];
    const pCount = ClanApp.extractParticipants(rec).length;
    $id('slotParticipantCount').textContent = `총 ${parties.length}파티 (${pCount}명)`;

    // 분배대기(보유중)는 금액 미표시·합계 제외, 분배금은 내판/외판 판매대금에서만 계산
    const includedTotal = rec
        ? Object.keys(castleBonusMap).filter(k => k.startsWith(`${rec.id}_`)).reduce((acc, k) => acc + castleBonusMap[k].bonusPrice, 0)
        : 0;
    const totalItemPrice = editableItems.reduce((acc, it) => acc + (it.sale_type === '보유중' ? 0 : getEffectiveItemPrice(it)), 0) + includedTotal;
    const distributablePrice = editableItems.reduce((acc, it, i) => {
        if (it.sale_type !== '내판' && it.sale_type !== '외판') return acc;
        const bonus = ClanApp.isCastleTaxItem(it.name) ? bonusOf(rec, i) : null;
        return acc + getEffectiveItemPrice(it) + (bonus ? bonus.bonusPrice : 0);
    }, 0);
    const netPool = ClanApp.netOf(distributablePrice);
    const perMemberShare = (pCount > 0 && netPool > 0) ? Math.floor(netPool / pCount) : 0;

    $id('slotItemTotalBadge').textContent = `총 ${totalItemPrice.toLocaleString()} (단위:아데나)`;

    const partyContainer = $id('slotPartyList');
    if (parties.length === 0) {
        partyContainer.innerHTML = `<div class="empty-party-msg">해당 보스탐에 등록된 파티 기록이 없습니다.</div>`;
    } else {
        partyContainer.innerHTML = parties.map(p => {
            const names = [{ id: p.leader, isLeader: true }]
                .concat(ClanApp.uniqueMembers(p.leader, p.members).map(m => ({ id: m, isLeader: false })));
            const rows = names.map(n => `
                <div class="party-person-row">
                    <span class="${n.isLeader ? 'party-leader-name' : 'party-member-name'}">${ClanApp.escapeHtml(n.id)}</span>
                    <span class="party-person-share">${perMemberShare.toLocaleString()}</span>
                    ${ClanApp.isAdminModeOn ? `<button type="button" class="btn-person-del" title="삭제" onclick="deleteMember(${ClanApp.jsArg(n.id)})">✕</button>` : ''}
                </div>`).join('');
            return `<div class="party-row-item"><div class="party-member-stack">${rows}</div></div>`;
        }).join('');
    }

    renderPartyTargetOptions(parties);
    renderItemDetailsSection(rec);
}

function renderPartyTargetOptions(parties) {
    const sel = $id('addPartyTarget');
    const prev = sel.value;
    sel.innerHTML = `<option value="">새 파티 만들기</option>` + parties.map(p =>
        `<option value="${ClanApp.escapeHtml(p.leader)}">${ClanApp.escapeHtml(p.leader)} 파티에 추가</option>`).join('');
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

function renderItemDetailsSection(rec) {
    const itemContainer = $id('slotItemList');
    if (editableItems.length === 0) {
        itemContainer.innerHTML = `<div class="empty-party-msg">드랍된 아이템이 없습니다.</div>`;
        return;
    }

    const priceSpan = (v) => `<span class="item-matched-price">${Number(v).toLocaleString()}</span>`;
    itemContainer.innerHTML = editableItems.map((item, idx) => {
        const delBtn = ClanApp.isAdminModeOn
            ? `<button type="button" class="btn-sm btn-sm-red btn-tiny" onclick="removeDropItemRow(${idx})">삭제</button>`
            : '';
        const bonus = ClanApp.isCastleTaxItem(item.name) ? bonusOf(rec, idx) : null;
        const includedRows = bonus ? bonus.includedItems.map(inc => `
            <div class="item-row-card">
                <div class="item-view-line">
                    <span class="item-badge-name">↳ 🎁 ${ClanApp.itemNameHtml(inc.name)}
                        <span class="included-from">(${inc.raid_date.slice(2)} ${ClanApp.escapeHtml(inc.raid_time)} 획득)</span></span>
                    ${ClanApp.badge('성세금포함', 'indigo', 'badge-sm item-status-tag')}
                    ${inc.price > 0 ? priceSpan(inc.price) : ''}
                </div>
            </div>`).join('') : '';

        return `
            <div class="item-row-card">
                <div class="item-view-line">
                    <span class="item-badge-name">🎁 ${ClanApp.itemNameHtml(item.name)}</span>
                    ${getItemStatusBadge(item, rec, idx)}
                    ${item.sale_type === '보유중' ? '' : priceSpan(getEffectiveItemPrice(item))}
                    ${delBtn}
                </div>
            </div>
            ${includedRows}`;
    }).join('');
}

// ---------------------------------------------------------
// 관리자 편집
// ---------------------------------------------------------
async function addDropItemRow() {
    if (!ClanApp.isAdminModeOn) return;
    const input = $id('newDropItemName');
    const resolved = ClanApp.resolveItemTokens(input.value);
    if (resolved.length === 0) return alert('추가할 아이템 이름을 입력해 주세요.');
    const bad = resolved.find(r => !r.isMatched);
    if (bad) return alert(`[${bad.raw}] 아이템은 아이템 목록에 없습니다.` + (bad.suggestion ? `\n혹시 [${bad.suggestion}] 인가요?` : ''));

    const ok = await ClanApp.saveRaid({
        raid_date: selectedDate,
        raid_time: selectedTime,
        parties: [],
        add_items: resolved.map(r => r.name).join(' '),
        requester_role: ClanApp.role,
        requester_id: ClanApp.user.active_id
    }, '아이템 추가 실패');
    if (ok) {
        input.value = '';
        await loadDateRaids();
    }
}

async function removeDropItemRow(idx) {
    if (!ClanApp.isAdminModeOn) return;
    const rec = getCurrentRecord();
    const target = editableItems[idx];
    if (!rec || !target) return;
    if (!confirm(`[${target.name}] 아이템을 삭제하시겠습니까?`)) return;

    if (await ClanApp.saveItemDetails(rec.id, editableItems.filter((_, i) => i !== idx), '삭제 실패')) {
        await loadDateRaids();
    }
}

async function deleteMember(name) {
    if (!ClanApp.isAdminModeOn) return;
    if (!confirm(`[${name}] 님을 이 보스탐 참여 명단에서 삭제하시겠습니까?`)) return;
    const params = new URLSearchParams({ date: selectedDate, time: selectedTime, name, role: ClanApp.role });
    if (await ClanApp.del(`/api/raids/member?${params.toString()}`)) await loadDateRaids();
}

async function addPartyMembers() {
    if (!ClanApp.isAdminModeOn) return;
    const input = $id('addMemberInput');
    const tokens = ClanApp.splitTokens(input.value);
    if (tokens.length === 0) return alert('추가할 아이디를 입력해 주세요.');

    const names = [];
    for (const tok of tokens) {
        const main = ClanApp.aliasMap[tok.toLowerCase()];
        if (!main) return alert(`[${tok}] 아이디는 등록되지 않은 회원입니다.`);
        if (!names.includes(main)) names.push(main);
    }

    const rec = getCurrentRecord();
    const parties = (rec && rec.parties) || [];
    const targetLeader = $id('addPartyTarget').value;
    let partyToSave;

    if (!targetLeader) {
        const used = new Set(ClanApp.participantIds(rec));
        const dup = names.find(n => used.has(n));
        if (dup) return alert(`[${dup}] 님은 이미 이 보스탐에 등록되어 있습니다.`);
        if (names.length > 8) return alert('1파티에는 최대 8명까지만 들어갈 수 있습니다.');
        partyToSave = { leader: names[0], members: names.slice(1) };
    } else {
        const party = parties.find(p => p.leader === targetLeader);
        if (!party) return alert('대상 파티를 찾을 수 없습니다.');
        const inParty = new Set([party.leader].concat(party.members || []));
        const others = new Set(ClanApp.participantIds({ parties: parties.filter(p => p.leader !== targetLeader) }));
        const dup = names.find(n => inParty.has(n) || others.has(n));
        if (dup) return alert(`[${dup}] 님은 이미 이 보스탐에 등록되어 있습니다.`);
        const members = ClanApp.uniqueMembers(party.leader, (party.members || []).concat(names));
        if (1 + members.length > 8) return alert('1파티에는 최대 8명까지만 들어갈 수 있습니다.');
        partyToSave = { leader: party.leader, members };
    }

    const ok = await ClanApp.saveRaid({
        raid_date: selectedDate,
        raid_time: selectedTime,
        parties: [partyToSave],
        requester_role: ClanApp.role,
        requester_id: ClanApp.user.active_id
    }, '추가 실패');
    if (ok) {
        input.value = '';
        await loadDateRaids();
    }
}

async function deleteEntireRaidSlot() {
    if (!ClanApp.isAdminModeOn) return;
    const rec = getCurrentRecord();
    if (!rec) return alert('삭제할 보스탐 기록이 없습니다.');
    if (!confirm(`${selectedDate} ${selectedTime} 보스탐 전체 기록을 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/raids/${rec.id}?${ClanApp.roleParam()}`)) await loadDateRaids();
}

function downloadExcelRange(kind) {
    ClanApp.exportExcel(kind, selectedDate);
}
