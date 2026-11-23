// =========================================================
// [distribution.js] 보스탐 분배관리
// =========================================================
let allRaids = [];
let checkedEntries = [];
let editingDistDateKeys = new Set();
let unlockedRowKeys = new Set();
let expandedItemRowKeys = new Set();
let memberInputDrafts = {};
let memberStatusFilter = 'wait';
let selectedKpiDistDate = '';
let mergedRowsCache = [];      // 현재 화면의 참여자 행 (rowIdx 기준)

window.onload = async () => {
    const user = ClanApp.initPage('/distribution', renderAllDistViews);
    if (!user) return;

    const now = new Date();
    $id('distMonthFilter').value = ClanApp.formatYM(now);
    $id('distDateFilter').value = ClanApp.formatYMD(now);

    await ClanApp.loadMeta();
    await loadAllRaidsForDistribution();
};

const shortDate = (d) => ClanApp.toShortDate(d);
const isRealDate = (v) => v && v !== 'all' && v !== 'unconfirmed';

// 참여자의 분배 상태를 구버전(memberId) 키에도 반영 (다른 화면 호환용)
function syncRaidLegacyMemberKey(raid, distMap, memberId, latestInfo) {
    const details = ClanApp.extractItemDetails(raid);
    let allCheckedDone = true;
    let hasAnyChecked = false;

    details.forEach((it, idx) => {
        if (!it.dist_checked || it.sale_type === '성세금포함') return;
        hasAnyChecked = true;
        const dDate = (it.dist_date || '').trim();
        const dateKey = dDate ? `${memberId}__date_${dDate}` : '';
        const itemKey = `${memberId}__item_${idx}`;
        let st;
        if (dateKey && distMap[dateKey]) st = distMap[dateKey].status;
        else if (distMap[itemKey]) st = distMap[itemKey].status;
        else st = ClanApp.getDistInfo(raid, idx, dDate, memberId).status;
        if (st !== '분배완료') allCheckedDone = false;
    });

    distMap[memberId] = (hasAnyChecked && allCheckedDone)
        ? { ...latestInfo, status: '분배완료' }
        : { status: '분배대기', method: latestInfo.method || '본인수령', proxy_name: latestInfo.proxy_name || memberId, paid_date: '' };
}

// ---------------------------------------------------------
// 필터 UI
// ---------------------------------------------------------
function onPeriodModeChange() {
    const mode = $id('distPeriodMode').value;
    $id('distAllBox').classList.toggle('hidden', mode !== 'all');
    $id('distMonthBox').classList.toggle('hidden', mode !== 'month');
    $id('distDateBox').classList.toggle('hidden', mode !== 'week' && mode !== 'day');
    $id('distDateLabel').textContent = mode === 'week' ? '주간 시작일' : '혈분배일 선택';
    updateTopWeekHint();
    selectedKpiDistDate = '';
    renderAllDistViews();
}

function onTopMonthOrDateFilterChange() {
    updateTopWeekHint();
    selectedKpiDistDate = '';
    renderAllDistViews();
}

function updateTopWeekHint() {
    const isWeek = $id('distPeriodMode').value === 'week';
    const dVal = $id('distDateFilter').value || ClanApp.today();
    $id('topWeekRangeHint').textContent = isWeek ? `(${ClanApp.getPlusSevenDaysRange(dVal).shortLabel})` : '';
}

function setItemStatusFilter(statusVal) {
    $id('distStatusFilter').value = statusVal;
    ClanApp.setActiveTab('itemStatusTabs', statusVal);
    renderAllDistViews();
}

function setMemberStatusFilter(statusVal) {
    memberStatusFilter = statusVal;
    ClanApp.setActiveTab('memberStatusTabs', statusVal);
    renderMergedParticipantsTable();
}

// ---------------------------------------------------------
// 데이터
// ---------------------------------------------------------
async function loadAllRaidsForDistribution() {
    allRaids = await ClanApp.fetchRaids();
    buildCheckedEntries();
    renderAllDistViews();
}

function buildCheckedEntries() {
    checkedEntries = ClanApp.buildDistEntries(allRaids);
}

function getPeriodFilteredEntries() {
    const mode = $id('distPeriodMode').value;
    const mVal = $id('distMonthFilter').value || ClanApp.formatYM();
    const dVal = $id('distDateFilter').value || ClanApp.today();
    const kw = $id('distItemSearch').value.trim().toLowerCase();
    const todayStr = ClanApp.today();
    const week = mode === 'week' ? ClanApp.getPlusSevenDaysRange(dVal) : null;

    return checkedEntries.filter(entry => {
        const effDate = entry.dist_date || entry.castle_tax_date || todayStr;
        if (mode === 'month' && !effDate.startsWith(mVal)) return false;
        if (week && (effDate < week.start || effDate > week.end)) return false;
        if (mode === 'day' && effDate !== dVal) return false;
        if (kw && !ClanApp.itemMatches(entry.name, kw) && !entry.participants.some(p => p.id.toLowerCase().includes(kw))) return false;
        return true;
    });
}

function getStatusFilteredEntries() {
    const statusFilter = $id('distStatusFilter').value;
    const list = getPeriodFilteredEntries();
    return statusFilter === 'all' ? list : list.filter(e => e.item_state === statusFilter);
}

function getKpiBaseEntries() {
    return getPeriodFilteredEntries().filter(e => !e.is_castle_tax_included);
}

function getSelectedKpiDateEntries() {
    const periodList = getKpiBaseEntries();
    if (selectedKpiDistDate === 'all') return periodList;
    if (selectedKpiDistDate === 'unconfirmed') return periodList.filter(e => !e.dist_date);
    return periodList.filter(e => e.dist_date === selectedKpiDistDate);
}

function getEffectiveFallbackDate() {
    return isRealDate(selectedKpiDistDate) ? selectedKpiDistDate : ClanApp.today();
}

// ---------------------------------------------------------
// 렌더링
// ---------------------------------------------------------
function renderAllDistViews() {
    renderDistDateSelectorChips();
    renderCheckedItemsTable();
    renderSixKpiSummary();
    renderMergedParticipantsTable();
}

function renderDistDateSelectorChips() {
    const periodList = getKpiBaseEntries();
    const dateCountMap = new Map();
    const dateHasWaitMap = new Map();
    let unconfirmedCount = 0;

    periodList.forEach(e => {
        if (e.dist_date) {
            dateCountMap.set(e.dist_date, (dateCountMap.get(e.dist_date) || 0) + 1);
            if (!e.is_done) dateHasWaitMap.set(e.dist_date, true);
        } else {
            unconfirmedCount++;
        }
    });

    const sortedDates = [...dateCountMap.keys()].sort((a, b) => b.localeCompare(a));
    const isValidSelection = selectedKpiDistDate === 'all'
        || (selectedKpiDistDate === 'unconfirmed' && unconfirmedCount > 0)
        || dateCountMap.has(selectedKpiDistDate);

    if (!selectedKpiDistDate || !isValidSelection) {
        selectedKpiDistDate = sortedDates.find(d => dateHasWaitMap.get(d))
            || sortedDates[0]
            || (unconfirmedCount > 0 ? 'unconfirmed' : 'all');
    }

    $id('distDateCountHint').textContent = `조회 기간 내 혈분배일 총 ${sortedDates.length}회 (아이템 ${periodList.length}건)`;

    const chip = (val, label, cnt) => `
        <button type="button" class="dist-date-chip ${selectedKpiDistDate === val ? 'active' : ''}" onclick="selectKpiDistDateChip('${val}')">
            <span>${label}</span><span class="chip-cnt">${cnt}건</span>
        </button>`;

    const chipsHtml = sortedDates.map(d => chip(d, shortDate(d), dateCountMap.get(d)));
    if (unconfirmedCount > 0) chipsHtml.push(chip('unconfirmed', '미확정(분배대기)', unconfirmedCount));
    chipsHtml.push(chip('all', '전체보기', periodList.length));
    $id('distDateChipContainer').innerHTML = chipsHtml.join('');
}

function selectKpiDistDateChip(targetVal) {
    selectedKpiDistDate = targetVal;
    expandedItemRowKeys.clear();
    renderDistDateSelectorChips();
    renderSixKpiSummary();
    renderMergedParticipantsTable();
}

function itemStatusBadge(entry, pCount) {
    if (!entry.dist_date) return ClanApp.badge('분배대기', 'amber');
    if (entry.is_done) return ClanApp.badge(`분배완료(${entry.done_count}/${pCount})`, 'gray');
    return ClanApp.badge(`분배중(${entry.done_count}/${pCount})`, 'blue');
}

function saveCancelButtons(saveCall, cancelHtml) {
    return `<div class="row-actions">
                <button type="button" class="btn-sm btn-sm-green btn-xs" onclick="${saveCall}">저장</button>
                ${cancelHtml}
            </div>`;
}

function renderCheckedItemsTable() {
    const list = getStatusFilteredEntries();
    const tbody = $id('checkedItemTableBody');
    const isAdmin = ClanApp.isAdminModeOn;
    const defaultInputDate = getEffectiveFallbackDate();

    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 9 : 8}" class="empty-party-msg">해당 조건의 분배 아이템 내역이 없습니다.</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(entry => {
        const pCount = entry.participants.length;
        const key = ClanApp.jsArg(entry.key);
        const lead = `
            <td class="checked-item-slot">${shortDate(entry.raid_date)} ${ClanApp.escapeHtml(entry.raid_time)}</td>`;

        // 성세금포함 아이템은 '성세금 합산'으로 표시 (중복 분배 방지)
        if (entry.is_castle_tax_included) {
            const ctLabel = entry.castle_tax_date ? `성세금 합산(${shortDate(entry.castle_tax_date)})` : '성세금 합산';
            const isEditingCt = isAdmin && editingDistDateKeys.has(entry.key);
            const ctTarget = checkedEntries.find(e => e.key === entry.target_key);
            const ctDistDate = (ctTarget && ctTarget.dist_date) || entry.dist_date || '';
            const ctDateCell = isEditingCt
                ? `<input type="date" id="chkCtDate_${entry.key}" class="tbl-input paid-date-input-compact" value="${ctDistDate || ClanApp.today()}">`
                : (ctDistDate ? `<span class="txt-date">${shortDate(ctDistDate)}</span>` : '미확정');
            const ctAdminCell = !isAdmin ? '' : `<td>${isEditingCt
                ? saveCancelButtons(`saveCastleTaxIncludedDate(${key})`, `<button type="button" class="btn-row-del" onclick="cancelDistDateEdit(${key})">취소</button>`)
                : `<button type="button" class="btn-row-edit" onclick="enableDistDateEdit(${key})">수정</button>`}</td>`;
            return `
                <tr>
                    ${lead}
                    <td class="checked-item-name">${ClanApp.itemNameHtml(entry.name)}</td>
                    <td class="checked-item-price">${entry.price.toLocaleString()}</td>
                    <td class="c-indigo">${entry.info_net.toLocaleString()}</td>
                    <td class="c-indigo">${entry.info_share > 0 ? entry.info_share.toLocaleString() : '-'}</td>
                    <td class="checked-item-pcount">${pCount}명</td>
                    <td>${ClanApp.badge(ctLabel, 'indigo')}</td>
                    <td>${ctDateCell}</td>
                    ${ctAdminCell}
                </tr>`;
        }

        const hasDistDate = Boolean((entry.dist_date || '').trim());
        const bonusSubHtml = entry.included_items.length > 0
            ? `<span class="sub-note c-indigo">(+성세금포함 ${entry.included_items.length}건: +${entry.bonus_price.toLocaleString()})</span>`
            : '';
        const confirmedDate = hasDistDate ? `<span class="txt-date">${shortDate(entry.dist_date)}</span>` : '미확정';

        let dateCell = confirmedDate;
        let adminCell = '';
        if (isAdmin) {
            if (hasDistDate && !editingDistDateKeys.has(entry.key)) {
                adminCell = `<td><button type="button" class="btn-row-edit" onclick="enableDistDateEdit(${key})">수정</button></td>`;
            } else {
                dateCell = `<input type="date" id="chkDistDate_${entry.key}" class="tbl-input paid-date-input-compact" value="${entry.dist_date || defaultInputDate}">`;
                adminCell = `<td>${saveCancelButtons(`saveCheckedItemDistDate(${key})`,
                    hasDistDate ? `<button type="button" class="btn-row-del" onclick="clearCheckedItemDistDate(${key})">초기화</button>` : '')}</td>`;
            }
        }

        return `
            <tr>
                ${lead}
                <td class="checked-item-name">${ClanApp.itemNameHtml(entry.name)}${bonusSubHtml}</td>
                <td class="checked-item-price">${entry.price.toLocaleString()}</td>
                <td class="checked-item-net-price">${entry.net_pool.toLocaleString()}</td>
                <td class="c-gold">${entry.per_share.toLocaleString()}</td>
                <td class="checked-item-pcount">${pCount}명</td>
                <td>${itemStatusBadge(entry, pCount)}</td>
                <td>${dateCell}</td>
                ${adminCell}
            </tr>`;
    }).join('');
}

function cancelDistDateEdit(key) {
    editingDistDateKeys.delete(key);
    renderCheckedItemsTable();
}

function enableDistDateEdit(key) {
    if (!ClanApp.isAdminModeOn) return;
    editingDistDateKeys.add(key);
    renderCheckedItemsTable();
}

// 아이템 1개의 혈분배일(dist_date) 저장 / 초기화
async function saveEntryDistDate(entry, distDate, failMsg, editKey = entry.key) {
    const details = entry.full_details_ref.map((it, idx) =>
        (idx === entry.item_idx ? { ...it, dist_date: distDate, dist_checked: true } : it));
    if (await ClanApp.saveItemDetails(entry.raid_id, details, failMsg)) {
        editingDistDateKeys.delete(editKey);
        await loadAllRaidsForDistribution();
    }
}

// 성세금합산 행: 고른 날짜를 합산 대상 성세금 아이템의 혈분배일로 저장
async function saveCastleTaxIncludedDate(key) {
    if (!ClanApp.isAdminModeOn) return;
    const entry = checkedEntries.find(e => e.key === key);
    if (!entry) return;
    const target = checkedEntries.find(e => e.key === entry.target_key) || entry;
    const el = $id(`chkCtDate_${key}`);
    const distDate = (el && el.value) ? el.value : ClanApp.today();
    selectedKpiDistDate = distDate;
    await saveEntryDistDate(target, distDate, '저장 실패', key);
}

async function saveCheckedItemDistDate(key) {
    if (!ClanApp.isAdminModeOn) return;
    const entry = checkedEntries.find(e => e.key === key);
    if (!entry) return;
    const el = $id(`chkDistDate_${key}`);
    const distDate = (el && el.value) ? el.value : ClanApp.today();
    selectedKpiDistDate = distDate;
    await saveEntryDistDate(entry, distDate, '저장 실패');
}

async function clearCheckedItemDistDate(key) {
    if (!ClanApp.isAdminModeOn) return;
    const entry = checkedEntries.find(e => e.key === key);
    if (!entry) return;
    if (!confirm(`[${entry.name}] 아이템의 혈분배일 설정을 초기화하시겠습니까?`)) return;
    await saveEntryDistDate(entry, '', '혈분배일 초기화 실패');
}

function renderSixKpiSummary() {
    const entries = getSelectedKpiDateEntries();

    let selectedLabel = '전체보기';
    if (selectedKpiDistDate === 'unconfirmed') selectedLabel = '미확정(분배대기)';
    else if (isRealDate(selectedKpiDistDate)) selectedLabel = shortDate(selectedKpiDistDate);
    $id('kpiSelectedDateText').textContent = selectedLabel;

    $id('kpiGrossSalesTotal').textContent = entries.reduce((acc, e) => acc + Number(e.price || 0), 0).toLocaleString();
    $id('kpiNetPoolTotal').textContent = entries.reduce((acc, e) => acc + Number(e.net_pool || 0), 0).toLocaleString();
    $id('kpiDistItemsList').innerHTML = entries.length === 0
        ? '해당 기준 아이템 없음'
        : ClanApp.countChips(entries.map(e => e.name), 'kpi-item-name');

    const waitSet = new Set();
    const doneSet = new Set();
    entries.forEach(entry => {
        entry.participants.forEach(p => {
            const info = ClanApp.getDistInfo(entry.raid_ref, entry.item_idx, entry.dist_date, p.id);
            (entry.dist_date && info.status === '분배완료' ? doneSet : waitSet).add(p.id);
        });
    });
    const pureDone = [...doneSet].filter(id => !waitSet.has(id)).length;
    $id('kpiDoneCount').textContent = `${pureDone}명`;
    $id('kpiWaitCount').textContent = `${waitSet.size}명`;
}

// 참여자 × 혈분배일 × (대기/완료) 단위로 합친 행 목록
function buildMergedParticipantsList() {
    const fallbackDate = getEffectiveFallbackDate();
    const todayStr = ClanApp.today();
    const rowGroupMap = new Map();

    getSelectedKpiDateEntries().forEach(entry => {
        const distDateKey = entry.dist_date || 'unconfirmed';
        entry.participants.forEach(p => {
            const pDist = ClanApp.getDistInfo(entry.raid_ref, entry.item_idx, entry.dist_date, p.id);
            const isItemDone = Boolean(entry.dist_date && pDist.status === '분배완료');
            const rowKey = `${p.id}__${distDateKey}__${isItemDone ? 'done' : 'wait'}`;

            if (!rowGroupMap.has(rowKey)) {
                const method = pDist.method || '본인수령';
                rowGroupMap.set(rowKey, {
                    rowKey,
                    id: p.id,
                    distDate: entry.dist_date || '',
                    effectiveDistDate: entry.dist_date || fallbackDate,
                    isLeader: p.isLeader,
                    isDoneGroup: isItemDone,
                    itemDetails: [],
                    totalShare: 0,
                    method,
                    proxy_name: pDist.proxy_name || (method === '혈귀속' ? '피닉스혈' : p.id),
                    paid_date: isItemDone ? (pDist.paid_date || todayStr) : todayStr
                });
            }

            const mData = rowGroupMap.get(rowKey);
            if (p.isLeader) mData.isLeader = true;
            mData.itemDetails.push({ name: entry.name, share: entry.per_share, raid_id: entry.raid_id, item_idx: entry.item_idx });
            mData.totalShare += entry.per_share;
            if (pDist.method) mData.method = pDist.method;
            if (pDist.proxy_name) mData.proxy_name = pDist.proxy_name;
            if (isItemDone && pDist.paid_date) mData.paid_date = pDist.paid_date;
        });
    });

    return [...rowGroupMap.values()].sort((a, b) =>
        (b.distDate || '').localeCompare(a.distDate || '') || a.id.localeCompare(b.id, 'ko'));
}

function toggleMemberItemsExpand(rowKey) {
    if (expandedItemRowKeys.has(rowKey)) expandedItemRowKeys.delete(rowKey);
    else expandedItemRowKeys.add(rowKey);
    renderMergedParticipantsTable();
}

function buildMemberSplitItemsHtml(memberRow) {
    const maxInitialShow = 8;
    const totalCount = memberRow.itemDetails.length;
    const isExpanded = expandedItemRowKeys.has(memberRow.rowKey);
    const visibleList = (totalCount > maxInitialShow && !isExpanded)
        ? memberRow.itemDetails.slice(0, maxInitialShow)
        : memberRow.itemDetails;

    const moreBtnHtml = totalCount > maxInitialShow
        ? `<button type="button" class="btn-items-more" onclick="toggleMemberItemsExpand(${ClanApp.jsArg(memberRow.rowKey)})">
               ${isExpanded ? '▲ 접기' : `▼ +${totalCount - maxInitialShow}개 더보기 (전체 ${totalCount}개)`}
           </button>`
        : '';

    return `
        <div class="item-split-container">
            <div class="item-split-grid-4">
                ${visibleList.map(it => `
                    <div class="item-split-unit">
                        <span class="item-split-top">${ClanApp.itemNameHtml(it.name)}</span>
                        <span class="item-split-bottom">${it.share.toLocaleString()}</span>
                    </div>`).join('')}
            </div>
            ${moreBtnHtml}
        </div>`;
}

function defaultReceiverOf(method, proxyName, memberId) {
    if (method === '혈귀속') return proxyName || '피닉스혈';
    if (method === '대리수령') return proxyName || '';
    return proxyName || memberId;
}

function renderMergedParticipantsTable() {
    const tbody = $id('distParticipantTableBody');
    const todayStr = ClanApp.today();
    const topItemKw = $id('distItemSearch').value.trim().toLowerCase();
    const memberKw = $id('participantSearchInput').value.trim().toLowerCase();
    const itemsMatch = (m, kw) => m.itemDetails.some(it => ClanApp.itemMatches(it.name, kw));

    mergedRowsCache = buildMergedParticipantsList().filter(m => {
        if (memberStatusFilter === 'wait' && m.isDoneGroup) return false;
        if (memberStatusFilter === 'done' && !m.isDoneGroup) return false;
        if (topItemKw && !m.id.toLowerCase().includes(topItemKw) && !itemsMatch(m, topItemKw)) return false;
        if (memberKw) {
            const draft = memberInputDrafts[m.rowKey] || {};
            const proxyStr = (draft.proxy_name || m.proxy_name || '').toLowerCase();
            const methodStr = (draft.method || m.method || '').toLowerCase();
            if (!m.id.toLowerCase().includes(memberKw) && !itemsMatch(m, memberKw)
                && !proxyStr.includes(memberKw) && !methodStr.includes(memberKw)) return false;
        }
        return true;
    });

    if (mergedRowsCache.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="empty-party-msg">선택한 혈분배일 기준에 해당하는 참여자 내역이 없습니다.</td></tr>`;
        return;
    }

    const isAdmin = ClanApp.isAdminModeOn;

    tbody.innerHTML = mergedRowsCache.map((m, rowIdx) => {
        const draft = memberInputDrafts[m.rowKey] || {
            method: m.method || '본인수령',
            proxy_name: defaultReceiverOf(m.method, m.proxy_name, m.id),
            paid_date: m.paid_date || todayStr
        };
        memberInputDrafts[m.rowKey] = draft;

        const isDone = m.isDoneGroup;
        const isLocked = isDone && !unlockedRowKeys.has(m.rowKey);
        const nameCell = `<span class="${m.isLeader ? 'party-leader-name' : 'party-member-name'}">${ClanApp.escapeHtml(m.id)}</span>`;
        const distDateBadge = m.distDate ? `<span class="txt-date">${shortDate(m.distDate)}</span>` : `<span class="c-muted">미확정</span>`;
        const statusBadge = isDone ? ClanApp.badge('분배완료', 'gray') : ClanApp.badge('분배대기', 'amber');
        const lead = `
            <td>${nameCell}</td>
            <td>${distDateBadge}</td>
            <td>${buildMemberSplitItemsHtml(m)}</td>
            <td class="c-gold">${m.totalShare.toLocaleString()}</td>
            <td>${statusBadge}</td>`;

        if (!isAdmin) {
            const receiverDisplay = draft.proxy_name || (draft.method === '혈귀속' ? '피닉스혈' : m.id);
            return `<tr>${lead}
                <td>${ClanApp.escapeHtml(draft.method)}</td>
                <td>${ClanApp.escapeHtml(receiverDisplay)}</td>
                <td>${isDone ? shortDate(draft.paid_date) : '-'}</td>
            </tr>`;
        }

        const dis = isLocked ? 'disabled' : '';
        const rightAction = isLocked
            ? `<button type="button" class="btn-row-edit" onclick="unlockMemberRow(${rowIdx})">수정</button>`
            : `<div class="row-actions">
                   <button type="button" class="btn-sm btn-sm-green btn-xs" onclick="saveMergedMemberRow(${rowIdx})">저장</button>
                   ${isDone ? `<button type="button" class="btn-row-del" onclick="resetMergedMemberRow(${rowIdx})">초기화</button>` : ''}
               </div>`;
        const placeholder = draft.method === '혈귀속' ? '피닉스혈' : (draft.method === '대리수령' ? '대리인' : '본캐/쫄');
        const inputVal = draft.proxy_name || (draft.method === '혈귀속' ? '피닉스혈' : (draft.method === '대리수령' ? '' : m.id));
        const opt = (v) => `<option value="${v}" ${draft.method === v || (v === '본인수령' && !['대리수령', '혈귀속'].includes(draft.method)) ? 'selected' : ''}>${v}</option>`;

        return `<tr>${lead}
            <td>
                <select id="memMethod_${rowIdx}" class="tbl-select method-select" ${dis} onchange="onMethodSelectChange(${rowIdx}, this.value)">
                    ${opt('본인수령')}${opt('대리수령')}${opt('혈귀속')}
                </select>
            </td>
            <td>
                <div class="suggest-wrap">
                    <input type="text" id="memProxy_${rowIdx}" class="tbl-input receiver-input-compact" autocomplete="off"
                           value="${ClanApp.escapeHtml(inputVal)}" placeholder="${placeholder}" ${dis}
                           onfocus="onReceiverInputSearch(${rowIdx})" oninput="onReceiverInputSearch(${rowIdx})"
                           onkeydown="onReceiverKeydown(event, ${rowIdx})">
                    <div id="memProxySuggest_${rowIdx}" class="suggest-list hidden"></div>
                </div>
            </td>
            <td>
                <div class="paid-date-action-cell">
                    <input type="date" id="memPaidDate_${rowIdx}" class="tbl-input paid-date-input-compact"
                           value="${draft.paid_date}" ${dis} onchange="draftOf(${rowIdx}).paid_date = this.value">
                    <span class="action-slot-box">${rightAction}</span>
                </div>
            </td>
        </tr>`;
    }).join('');
}

// ---------------------------------------------------------
// 수령 아이디 입력 / 자동완성
// ---------------------------------------------------------
function draftOf(rowIdx) {
    const m = mergedRowsCache[rowIdx];
    if (!memberInputDrafts[m.rowKey]) {
        memberInputDrafts[m.rowKey] = { method: '본인수령', proxy_name: m.id, paid_date: ClanApp.today() };
    }
    return memberInputDrafts[m.rowKey];
}

function onReceiverInputSearch(rowIdx) {
    const m = mergedRowsCache[rowIdx];
    const inputEl = $id(`memProxy_${rowIdx}`);
    const box = $id(`memProxySuggest_${rowIdx}`);
    if (!m || !inputEl || !box) return;

    const val = inputEl.value.trim();
    draftOf(rowIdx).proxy_name = val;

    const method = ($id(`memMethod_${rowIdx}`) || {}).value || '본인수령';
    const q = val.toLowerCase();
    let candidates = [];

    if (method === '본인수령') {
        const ownList = ClanApp.subMap[m.id] || [{ charId: m.id, labelInfo: '본캐', searchKey: m.id.toLowerCase() }];
        if (!q || q === m.id.toLowerCase()) {
            candidates = ownList;
        } else {
            const ownMatches = ownList.filter(e => e.searchKey.includes(q));
            candidates = ownMatches.length > 0 ? ownMatches : ClanApp.searchChars(q, 10);
        }
    } else if (method === '대리수령') {
        candidates = ClanApp.searchChars(q, 12);
    }

    ClanApp.suggest.open(box, candidates, (charId) => {
        inputEl.value = charId;
        draftOf(rowIdx).proxy_name = charId;
    });
}

function onReceiverKeydown(event, rowIdx) {
    ClanApp.suggest.handleKey(event, $id(`memProxySuggest_${rowIdx}`));
    if (event.key === 'Enter') event.preventDefault();
}

function onMethodSelectChange(rowIdx, val) {
    const m = mergedRowsCache[rowIdx];
    const draft = draftOf(rowIdx);
    draft.method = val;

    const proxyInput = $id(`memProxy_${rowIdx}`);
    if (!proxyInput) return;

    if (val === '혈귀속') {
        draft.proxy_name = '피닉스혈';
        proxyInput.value = '피닉스혈';
        proxyInput.placeholder = '피닉스혈';
        ClanApp.suggest.close($id(`memProxySuggest_${rowIdx}`));
    } else if (val === '대리수령') {
        draft.proxy_name = '';
        proxyInput.value = '';
        proxyInput.placeholder = '대리인';
        proxyInput.focus();
    } else {
        draft.proxy_name = m.id;
        proxyInput.value = m.id;
        proxyInput.placeholder = '본캐/쫄';
        onReceiverInputSearch(rowIdx);
    }
}

function unlockMemberRow(rowIdx) {
    if (!ClanApp.isAdminModeOn) return;
    unlockedRowKeys.add(mergedRowsCache[rowIdx].rowKey);
    renderMergedParticipantsTable();
}

// ---------------------------------------------------------
// 분배 완료 / 초기화 저장
// ---------------------------------------------------------
function groupItemsByRaid(itemDetails) {
    const map = new Map();
    itemDetails.forEach(it => {
        if (!map.has(it.raid_id)) map.set(it.raid_id, []);
        map.get(it.raid_id).push(it.item_idx);
    });
    return map;
}

// 한 참여자의 여러 아이템 분배정보를 보스탐 기록별로 저장
async function writeMemberDist(memberRow, info, distDate, fillDistDate) {
    for (const [rId, itemIdxs] of groupItemsByRaid(memberRow.itemDetails).entries()) {
        const raid = allRaids.find(r => r.id === rId);
        if (!raid) continue;

        const distMap = JSON.parse(JSON.stringify(raid.distributions || {}));
        if (distDate) distMap[`${memberRow.id}__date_${distDate}`] = info;
        itemIdxs.forEach(idx => { distMap[`${memberRow.id}__item_${idx}`] = info; });
        syncRaidLegacyMemberKey(raid, distMap, memberRow.id, info);

        if (!(await ClanApp.saveDistributions(rId, distMap))) return false;
        if (fillDistDate) await ensureRaidItemsDistDateFilled(raid, itemIdxs, distDate);
    }
    return true;
}

async function saveMergedMemberRow(rowIdx) {
    if (!ClanApp.isAdminModeOn) return;
    const targetRow = mergedRowsCache[rowIdx];
    if (!targetRow) return;

    const memberId = targetRow.id;
    const targetDistDate = targetRow.distDate || targetRow.effectiveDistDate || getEffectiveFallbackDate();
    const method = ($id(`memMethod_${rowIdx}`) || {}).value || '본인수령';
    const rawReceiver = (($id(`memProxy_${rowIdx}`) || {}).value || '').trim();
    const paidDate = ($id(`memPaidDate_${rowIdx}`) || {}).value || ClanApp.today();

    let proxyName = rawReceiver || memberId;
    if (method === '혈귀속') proxyName = rawReceiver || '피닉스혈';
    else if (method === '대리수령') proxyName = rawReceiver;
    if (method === '대리수령' && !proxyName) {
        return alert('대리수령을 선택한 경우 대리수령 아이디를 입력해 주세요.');
    }

    const doneInfo = { status: '분배완료', method, proxy_name: proxyName, paid_date: paidDate };
    memberInputDrafts[targetRow.rowKey] = { method, proxy_name: proxyName, paid_date: paidDate };

    await writeMemberDist(targetRow, doneInfo, targetDistDate, true);
    unlockedRowKeys.delete(targetRow.rowKey);
    await loadAllRaidsForDistribution();
}

async function resetMergedMemberRow(rowIdx) {
    if (!ClanApp.isAdminModeOn) return;
    const targetRow = mergedRowsCache[rowIdx];
    if (!targetRow) return;

    const memberId = targetRow.id;
    const targetDistDate = targetRow.distDate || '';
    if (!confirm(`[${memberId}] 참여자의 (${targetDistDate ? shortDate(targetDistDate) : '해당'}) 혈분배일 완료 상태를 초기화하시겠습니까?`)) return;

    const waitInfo = { status: '분배대기', method: '본인수령', proxy_name: memberId, paid_date: '' };
    await writeMemberDist(targetRow, waitInfo, targetDistDate, false);
    unlockedRowKeys.delete(targetRow.rowKey);
    await loadAllRaidsForDistribution();
}

async function markAllMergedParticipantsDone() {
    if (!ClanApp.isAdminModeOn) return;
    const targetEntries = getSelectedKpiDateEntries();
    if (targetEntries.length === 0) return alert('선택한 혈분배일에 분배 처리할 대상 아이템이 없습니다.');

    const selectedDistDate = getEffectiveFallbackDate();
    const todayStr = ClanApp.today();
    const labelStr = selectedKpiDistDate === 'all' ? '현재 조회된 전체 혈분배일' : `혈분배일 [${shortDate(selectedDistDate)}]`;
    if (!confirm(`${labelStr}의 모든 미분배 참여자를 [분배완료] 처리하시겠습니까?`)) return;

    const raidItemsMap = new Map();
    targetEntries.forEach(e => {
        if (!raidItemsMap.has(e.raid_id)) raidItemsMap.set(e.raid_id, []);
        raidItemsMap.get(e.raid_id).push({ idx: e.item_idx, distDate: e.dist_date || selectedDistDate });
    });

    for (const [rId, itemObjs] of raidItemsMap.entries()) {
        const raid = allRaids.find(r => r.id === rId);
        if (!raid) continue;

        const distMap = JSON.parse(JSON.stringify(raid.distributions || {}));
        ClanApp.extractParticipants(raid).forEach(p => {
            itemObjs.forEach(({ idx, distDate }) => {
                if (ClanApp.getDistInfo(raid, idx, distDate, p.id).status === '분배완료') return;
                const draft = memberInputDrafts[`${p.id}__${distDate}__wait`] || {};
                const method = draft.method || '본인수령';
                const doneInfo = {
                    status: '분배완료',
                    method,
                    proxy_name: method === '혈귀속' ? (draft.proxy_name || '피닉스혈') : (draft.proxy_name || p.id),
                    paid_date: draft.paid_date || todayStr
                };
                distMap[`${p.id}__date_${distDate}`] = doneInfo;
                distMap[`${p.id}__item_${idx}`] = doneInfo;
                syncRaidLegacyMemberKey(raid, distMap, p.id, doneInfo);
            });
        });

        if (!(await ClanApp.saveDistributions(rId, distMap))) break;
        await ensureRaidItemsDistDateFilled(raid, itemObjs.map(o => o.idx), selectedDistDate);
    }

    unlockedRowKeys.clear();
    await loadAllRaidsForDistribution();
    alert(`${labelStr} 기준 전체 분배 완료 처리되었습니다.`);
}

// 분배 완료 처리한 아이템에 혈분배일이 비어 있으면 채워 넣기
async function ensureRaidItemsDistDateFilled(raid, targetItemIdxs, fallbackDate) {
    const idxSet = new Set(targetItemIdxs);
    let changed = false;
    const updated = ClanApp.extractItemDetails(raid).map((it, idx) => {
        if (idxSet.has(idx) && (it.dist_checked || ClanApp.isCastleTaxItem(it.name)) && !(it.dist_date || '').trim()) {
            changed = true;
            return { ...it, dist_checked: true, dist_date: fallbackDate };
        }
        return it;
    });
    if (changed) await ClanApp.saveItemDetails(raid.id, updated);
}

function exportDistExcel(kind) {
    ClanApp.exportExcel(kind, $id('distDateFilter').value, $id('distMonthFilter').value, ClanApp.getPlusSevenDaysRange);
}
