// =========================================================
// [raid_record.js] 보스탐 참여 기록 입력
// =========================================================
let selectedDate = '';
let selectedHour = '';
let currentDayRaids = [];
let previewParties = [];

window.onload = async () => {
    const user = ClanApp.initPage('/raid-record', () => {
        renderHourGrid();
        syncSelectedSlotRecord();
    });
    if (!user) return;

    await ClanApp.loadMeta();
    const now = new Date();
    selectedDate = ClanApp.formatYMD(now);
    selectedHour = ClanApp.getDefaultRaidTime(now);
    updateDateTimeLabel();
    await fetchDayRaids();
};

function getCurrentRecord() {
    return currentDayRaids.find(x => x.raid_time === selectedHour) || null;
}

// 사용자에게 받은 단어를 인라인 onclick 인자로 넣을 때
const arg = (v) => ClanApp.jsArg(v);

// ---------------------------------------------------------
// 드랍 아이템 입력
// ---------------------------------------------------------
function resolveDropItems() {
    return ClanApp.resolveItemTokens($id('droppedItemsInput').value);
}

function handleDropMatch() {
    const box = $id('dropMatchBox');
    const items = resolveDropItems();
    if (items.length === 0) {
        box.innerHTML = `<div class="empty-party-msg">드랍 아이템을 입력하면 아이템 목록과 매칭됩니다.</div>`;
        return;
    }
    box.innerHTML = items.map(item => {
        if (item.isMatched) return `<span class="member-badge registered">${ClanApp.itemNameHtml(item.name)}</span>`;
        const sug = item.suggestion ? `<span class="suggest-arrow">→ ${ClanApp.itemNameHtml(item.suggestion)}?</span>` : '';
        return `<span class="member-badge unregistered" onclick="applyDropSuggestion(${arg(item.raw)}, ${arg(item.suggestion || '')})">❌ ${ClanApp.escapeHtml(item.raw)} ${sug}</span>`;
    }).join('');
}

function applyDropSuggestion(wrongWord, suggestion) {
    if (!suggestion) return alert(`[${wrongWord}] 아이템은 아이템 목록에 없습니다. 직접 수정해 주세요.`);
    const input = $id('droppedItemsInput');
    input.value = ClanApp.splitTokens(input.value).map(t => (t === wrongWord ? suggestion : t)).join(' ');
    handleDropMatch();
}

function clearDropInput() {
    $id('droppedItemsInput').value = '';
    handleDropMatch();
}

// ---------------------------------------------------------
// 날짜 / 시간 선택
// ---------------------------------------------------------
function selectDateOffset(offset) {
    $id('btnYesterday').classList.toggle('active', offset === -1);
    $id('btnToday').classList.toggle('active', offset === 0);
    selectedDate = ClanApp.shiftDate(ClanApp.today(), offset);
    if (!ClanApp.getRaidTimes(selectedDate).includes(selectedHour)) {
        selectedHour = ClanApp.getDefaultRaidTime(new Date());
    }
    updateDateTimeLabel();
    fetchDayRaids();
}

function updateDateTimeLabel() {
    $id('selectedDateTimeText').textContent = ClanApp.formatHeaderLabel(selectedDate, selectedHour);
}

async function fetchDayRaids() {
    currentDayRaids = await ClanApp.fetchRaids({ date: selectedDate });
    renderHourGrid();
    syncSelectedSlotRecord();
}

function renderHourGrid() {
    const recordedSet = new Set(currentDayRaids.map(r => r.raid_time));
    const statusText = { open: '입력가능', expired: '마감', future: '대기' };

    $id('hourGrid').innerHTML = ClanApp.getRaidTimes(selectedDate).map(hr => {
        const status = ClanApp.getSlotStatus(selectedDate, hr);
        return `
            <button type="button"
                    class="common-time-btn hour-btn ${status} ${recordedSet.has(hr) ? 'recorded' : ''} ${hr === selectedHour ? 'active' : ''}"${ClanApp.slotAttr(hr)}
                    onclick="selectHour('${hr}')">
                <span>${hr}</span>
                <span class="common-time-sub">${statusText[status] || '대기'}</span>
            </button>`;
    }).join('');

    updateInputLockUI();
}

function selectHour(hr) {
    selectedHour = hr;
    updateDateTimeLabel();
    renderHourGrid();
    syncSelectedSlotRecord();
}

function updateInputLockUI() {
    const editable = ClanApp.isAdminModeOn || ClanApp.getSlotStatus(selectedDate, selectedHour) === 'open';
    $id('limitWarningBox').classList.toggle('show', !editable);
    ['participantTextarea', 'droppedItemsInput', 'submitDropBtn', 'submitRaidBtn'].forEach(id => { $id(id).disabled = !editable; });
}

function syncSelectedSlotRecord() {
    renderRecordedParties();
    handleRealtimeMatch();
    handleDropMatch();
}

// ---------------------------------------------------------
// 참여자 입력 실시간 매칭
// ---------------------------------------------------------
function findSuggestedMember(token) {
    const lower = token.toLowerCase();
    const hit = ClanApp.members.find(m => {
        const id = (m.active_id || '').toLowerCase();
        return id && (id.includes(lower) || lower.includes(id));
    });
    return hit ? hit.active_id : null;
}

function handleRealtimeMatch() {
    const box = $id('matchResultBox');
    const myActiveId = ClanApp.user ? ClanApp.user.active_id : '';
    const lines = $id('participantTextarea').value.split(/\n+/).map(l => l.trim()).filter(Boolean);

    previewParties = [];
    if (lines.length === 0) {
        box.innerHTML = `<div class="empty-party-msg">참여자 아이디를 입력하면 매칭 결과가 표시됩니다.</div>`;
        return;
    }

    const usedIds = new Set(ClanApp.participantIds(getCurrentRecord()));
    const rowHtmlList = [];

    lines.forEach((line, lineIdx) => {
        const resolved = [];
        const seenInParty = new Set();
        ClanApp.splitTokens(line).forEach(tok => {
            const matchedMain = ClanApp.aliasMap[tok.toLowerCase()] || null;
            const name = matchedMain || tok;
            if (seenInParty.has(name)) return;
            seenInParty.add(name);
            resolved.push({ raw: tok, name, isMatched: Boolean(matchedMain), suggestion: matchedMain ? null : findSuggestedMember(tok) });
        });
        if (resolved.length === 0) return;

        // 본인 아이디는 자동으로 맨 앞(파티장)
        const myIndex = resolved.findIndex(item => item.name === myActiveId);
        if (myIndex > 0) resolved.unshift(resolved.splice(myIndex, 1)[0]);

        resolved.forEach(item => {
            item.isDup = usedIds.has(item.name);
            usedIds.add(item.name);
        });

        const count = resolved.length;
        const isOverLimit = count > 8;
        previewParties.push({
            leader: resolved[0].name,
            members: resolved.slice(1).map(m => m.name),
            count,
            isOverLimit,
            hasUnregistered: resolved.some(r => !r.isMatched),
            hasDuplicate: resolved.some(r => r.isDup)
        });

        const badgesHtml = resolved.map((item, idx) => {
            const safeName = ClanApp.escapeHtml(item.name);
            if (!item.isMatched) {
                const sugHtml = item.suggestion ? `<span class="suggest-arrow">→ ${ClanApp.escapeHtml(item.suggestion)}?</span>` : '';
                return `<span class="member-badge unregistered" onclick="applySuggestion(${lineIdx}, ${arg(item.raw)}, ${arg(item.suggestion || '')})">❌ ${ClanApp.escapeHtml(item.raw)} ${sugHtml}</span>`;
            }
            if (item.isDup) {
                return `<span class="member-badge duplicate" onclick="removeDuplicate(${lineIdx}, ${arg(item.name)})">🚫 ${safeName} 중복 ✕</span>`;
            }
            return `<span class="member-badge ${idx === 0 ? 'leader' : 'registered'}">${safeName}</span>`;
        }).join('');

        const limitLabel = isOverLimit
            ? `<span class="party-limit-status over-limit">⚠️ 8명 초과 (${count}/8명)</span>`
            : `<span class="party-limit-status">(${count}/8명)</span>`;
        rowHtmlList.push(`<div class="preview-party-row">${badgesHtml}${limitLabel}</div>`);
    });

    box.innerHTML = rowHtmlList.join('');
}

function applySuggestion(lineIdx, wrongWord, suggestion) {
    if (!suggestion) return alert(`[${wrongWord}] 아이디는 등록되지 않은 회원입니다. 직접 수정해 주세요.`);
    const textarea = $id('participantTextarea');
    const lines = textarea.value.split(/\n/);
    if (lines[lineIdx]) {
        lines[lineIdx] = lines[lineIdx].replace(wrongWord, suggestion);
        textarea.value = lines.join('\n');
        handleRealtimeMatch();
    }
}

function removeDuplicate(lineIdx, name) {
    const textarea = $id('participantTextarea');
    const lines = textarea.value.split(/\n+/).map(l => l.trim()).filter(Boolean);
    if (!lines[lineIdx]) return;

    const remain = ClanApp.splitTokens(lines[lineIdx]).filter(tok => (ClanApp.aliasMap[tok.toLowerCase()] || tok) !== name);
    if (remain.length > 0) lines[lineIdx] = remain.join(' ');
    else lines.splice(lineIdx, 1);

    textarea.value = lines.join('\n');
    handleRealtimeMatch();
}

function clearParticipantInput() {
    $id('participantTextarea').value = '';
    handleRealtimeMatch();
}

// ---------------------------------------------------------
// 저장
// ---------------------------------------------------------
function requesterRole() {
    return ClanApp.isAdminModeOn ? ClanApp.role : '일반회원';
}

async function submitRaidRecord() {
    handleRealtimeMatch();
    const myActiveId = ClanApp.user.active_id;

    if (previewParties.length === 0) return alert('참여자 아이디를 입력해 주세요.');
    if (previewParties.some(p => p.hasUnregistered)) return alert('미등록 회원(빨간색 표시)이 포함되어 있습니다. 오타를 수정해 주세요.');
    if (previewParties.some(p => p.hasDuplicate)) return alert('이미 등록되었거나 다른 줄에 중복 입력된 아이디가 있습니다. (중복 표시된 아이디를 삭제해 주세요)');
    const overParty = previewParties.find(p => p.isOverLimit);
    if (overParty) return alert(`1파티에는 최대 8명까지만 들어갈 수 있습니다.\n([${overParty.leader}] 파티 현재 ${overParty.count}명)`);
    if (!ClanApp.isAdminModeOn && previewParties.some(p => p.leader !== myActiveId)) {
        return alert(`본인 아이디(${myActiveId})를 포함하여 입력해 주세요. (본인이 자동으로 파티장으로 등록됩니다)`);
    }

    const ok = await ClanApp.saveRaid({
        raid_date: selectedDate,
        raid_time: selectedHour,
        parties: previewParties.map(p => ({ leader: p.leader, members: ClanApp.uniqueMembers(p.leader, p.members) })),
        requester_role: requesterRole(),
        requester_id: myActiveId
    });
    if (ok) {
        clearParticipantInput();
        await fetchDayRaids();
        alert('보스탐 파티 기록이 등록되었습니다.');
    }
}

async function submitDropItems() {
    const dropItems = resolveDropItems();
    if (dropItems.length === 0) return alert('드랍 아이템을 입력해 주세요.');
    if (dropItems.some(i => !i.isMatched)) return alert('아이템 목록에 없는 드랍 아이템(빨간색 표시)이 있습니다. 터치해서 수정해 주세요.');

    const ok = await ClanApp.saveRaid({
        raid_date: selectedDate,
        raid_time: selectedHour,
        parties: [],
        add_items: dropItems.map(i => i.name).join(' '),
        requester_role: requesterRole(),
        requester_id: ClanApp.user.active_id
    });
    if (ok) {
        clearDropInput();
        await fetchDayRaids();
        alert('드랍 아이템이 등록되었습니다.');
    }
}

// ---------------------------------------------------------
// 등록된 파티 / 아이템 목록
// ---------------------------------------------------------
function renderRecordedParties() {
    const rec = getCurrentRecord();
    const parties = (rec && rec.parties) || [];
    $id('partyCountBadge').textContent = `총 ${parties.length}파티 (${ClanApp.extractParticipants(rec).length}명)`;

    const itemNames = ClanApp.extractItemDetails(rec).map(i => i.name);
    $id('recordedItemBox').innerHTML = `<div class="recorded-item-title">🎁 드랍 아이템 (${itemNames.length}개)</div>` + (itemNames.length === 0
        ? `<div class="empty-party-msg">등록된 드랍 아이템이 없습니다.</div>`
        : `<div class="recorded-item-chips">${ClanApp.countChips(itemNames, 'recorded-item-chip')}</div>`);

    const listEl = $id('recordedPartyList');
    if (parties.length === 0) {
        listEl.innerHTML = `<div class="empty-party-msg">아직 등록된 파티가 없습니다.</div>`;
        return;
    }

    listEl.innerHTML = parties.map(p => `
        <div class="party-row-item">
            <div class="party-inline-flow">
                <span class="party-leader-name">${ClanApp.escapeHtml(p.leader)}</span>
                ${ClanApp.uniqueMembers(p.leader, p.members).map(m => `<span class="party-member-name">${ClanApp.escapeHtml(m)}</span>`).join('')}
            </div>
            ${ClanApp.isAdminModeOn ? `<button type="button" class="btn-row-del" onclick="deletePartyRow(${arg(p.leader)})">삭제</button>` : ''}
        </div>`).join('');
}

async function deletePartyRow(leaderId) {
    if (!ClanApp.isAdminModeOn) return;
    if (!confirm(`[${leaderId}] 파티 줄을 삭제하시겠습니까?`)) return;
    const params = new URLSearchParams({ date: selectedDate, time: selectedHour, leader: leaderId, role: ClanApp.role });
    if (await ClanApp.del(`/api/raids/party?${params.toString()}`)) await fetchDayRaids();
}
