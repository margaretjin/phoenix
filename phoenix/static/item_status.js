// =========================================================
// [item_status.js] 혈맹 아이템 현황 (템보유현황)
// =========================================================
const DAWN_SLOTS = new Set(['01시', '03시', '05시']);
const NON_DIST_HOLD = ['연합', '이벤트', '분배금혈귀'];
// 수령자 + 수령완료일이 저장되면 '수령완료'로 표시되는 보유상태
const RECEIVE_DONE_HOLD = ['이벤트', '분배금혈귀'];

let flattenedItems = [];
let visibleRows = [];          // 현재 화면에 그려진 행 (인덱스 i 기준)
let editingItemKeys = new Set();

window.onload = async () => {
    const user = ClanApp.initPage('/item-status', () => {
        if (!ClanApp.isAdminModeOn) editingItemKeys.clear();
        renderItemTable();
    });
    if (!user) return;

    const now = new Date();
    $id('filterMonth').value = ClanApp.formatYM(now);
    $id('filterDate').value = ClanApp.formatYMD(now);

    await ClanApp.loadMeta();
    await loadItemStatusData();
};

// ---------------------------------------------------------
// 표시 헬퍼
// ---------------------------------------------------------
function formatRaidDateTimeCell(dateStr, timeStr) {
    const t = (timeStr || '').trim();
    const dawnTag = DAWN_SLOTS.has(t) ? `<span class="dawn-sub-tag">(새벽)</span>` : '';
    return `<span class="raid-datetime-unified">${ClanApp.toShortDate(dateStr)} ${ClanApp.escapeHtml(t)}${dawnTag}</span>`;
}

// 성세금 날짜 드롭다운: 공성은 일요일에만 열리므로 일요일만 3개 표시
// (획득일 이전 가장 가까운 일요일 + 이후 일요일 2개)
function buildCastleTaxDateOptionsHtml(baseDateStr, selectedDate = '') {
    const ref = baseDateStr && baseDateStr.length >= 10 ? baseDateStr : ClanApp.today();
    const sel = (selectedDate || '').trim();
    const prevSunday = ClanApp.shiftDate(ref, -ClanApp.parseYMD(ref).getDay());
    const dates = [0, 7, 14].map(off => ClanApp.shiftDate(prevSunday, off));
    if (sel && !dates.includes(sel)) dates.unshift(sel);

    const opts = [`<option value="" ${!sel ? 'selected' : ''}>성세금일(자동)</option>`];
    dates.forEach(val => {
        const wd = ClanApp.WEEKDAYS[ClanApp.parseYMD(val).getDay()] || '';
        opts.push(`<option value="${val}" ${sel === val ? 'selected' : ''}>${ClanApp.toShortDate(val)}(${wd})</option>`);
    });
    return opts.join('');
}

// 내판·외판 + 성세금 + 성세금포함 모두 체크박스(분배관리 연동) 허용
function isDistributableHoldState(holdState, itemName = '') {
    if (holdState === '내판' || holdState === '외판' || holdState === '성세금포함') return true;
    return ClanApp.isCastleTaxItem(itemName) && !NON_DIST_HOLD.includes(holdState);
}

function resolveRowHoldState(item) {
    if (item.event_item) return '이벤트';
    if (item.clan_owned) return '연합';
    const st = item.sale_type || '보유중';
    if (!item.alliance && (st === '내판' || st === '외판')) {
        return ClanApp.isClanChar(item.winner) ? '내판' : '외판';
    }
    return st;
}

function holdLabelOf(row) {
    if (row.hold_state === '보유중') return row.alliance === '피닉스' ? '피닉스(구분대기)' : '연합분배대기';
    if (row.hold_state === '연합') {
        const al = row.alliance && row.alliance !== '피닉스' ? row.alliance : '';
        return al ? `연합(${al})` : '연합';
    }
    return row.hold_state;
}

function holdToneOf(row) {
    if (row.hold_state === '보유중') return row.alliance === '피닉스' ? 'pink' : 'amber';
    return ClanApp.HOLD_TONE[row.hold_state] || 'gray';
}

function distToneOf(state, label) {
    if (state === '연합분배대기' && String(label).startsWith('피닉스')) return 'pink';
    return ClanApp.DIST_TONE[state] || 'gray';
}

function distBadgeHtml(state, label, id = '') {
    return ClanApp.badge(label, distToneOf(state, label), '', id);
}

function formatPriceWithPolicyHint(row) {
    if (row.hold_state === '이벤트') return '0 (이벤트)';
    const actual = Number(row.price || 0);
    const policy = Number(row.policy_price || 0);
    if (actual <= 0) return '-';
    if (policy > 0 && actual !== policy) {
        return `<span class="val-stack"><span>${actual.toLocaleString()}</span><span class="sub-note">(정책: ${policy.toLocaleString()})</span></span>`;
    }
    return actual.toLocaleString();
}

// ---------------------------------------------------------
// 분배상태 계산
// ---------------------------------------------------------
function computeDistStateInfo(record, item, itemIdx = 0) {
    const winner = (item.winner || '').trim();
    const holdState = resolveRowHoldState(item);
    const one = (state, label = state) => ({ state, label });

    // 이벤트 · 분배금혈귀 : 수령자 + 수령완료일 저장 시 수령완료
    if (RECEIVE_DONE_HOLD.includes(holdState) && winner && (item.taken_date || '').trim()) {
        return one('수령완료');
    }
    if (holdState === '연합') {
        const al = (item.alliance || '').trim();
        if (item.clan_owned && !winner && !al) return one('혈비귀속');
        const where = al || winner;
        return one('연합', where ? `연합(${where})` : '연합');
    }
    if (holdState === '이벤트') return one(item.event_item ? '이벤트템' : '이벤트');
    if (holdState === '성세금포함') {
        const ctDate = (item.castle_tax_date || '').trim();
        return one('성세금포함', ctDate ? `성세금포함(${ClanApp.toShortDate(ctDate)})` : '성세금포함');
    }
    if (holdState === '분배금혈귀') return one('분배금혈귀');

    // 성세금 아이템은 수령자 없이도 분배 체크/진행 상태 표시
    if (ClanApp.isCastleTaxItem(item.name)) return ClanApp.distProgress(record, item, itemIdx);

    if (holdState === '보유중') {
        return one('연합분배대기', item.alliance === '피닉스' ? '피닉스 판매대기' : '연합분배대기');
    }
    if (!winner || !isDistributableHoldState(holdState, item.name)) return one('분배대기');
    return ClanApp.distProgress(record, item, itemIdx);
}

// ---------------------------------------------------------
// 조회
// ---------------------------------------------------------
function onViewModeChange() {
    const mode = $id('viewModeSelect').value;
    const dateLabel = $id('datePickerLabel');
    $id('monthPickerBox').classList.toggle('hidden', mode !== 'month');
    $id('allModeNoticeBox').classList.toggle('hidden', mode !== 'all');
    $id('datePickerBox').classList.toggle('hidden', !['week', 'today', 'custom_date'].includes(mode));

    if (mode === 'week') dateLabel.textContent = '주간 기준일 선택';
    else if (mode === 'today') {
        $id('filterDate').value = ClanApp.today();
        dateLabel.textContent = '오늘 날짜';
    } else if (mode === 'custom_date') dateLabel.textContent = '특정일 선택';

    loadItemStatusData();
}

async function loadItemStatusData() {
    const mode = $id('viewModeSelect').value;
    const dateVal = $id('filterDate').value || ClanApp.today();
    const monthVal = $id('filterMonth').value || ClanApp.formatYM();

    let params = {};
    if (mode === 'month') params = { month: monthVal };
    else if (mode === 'week') params = ClanApp.getWeekRange(dateVal);
    else if (mode === 'today' || mode === 'custom_date') params = { date: dateVal };

    const raids = await ClanApp.fetchRaids(params);

    flattenedItems = [];
    raids.forEach(r => {
        const rawSavedDetails = Array.isArray(r.item_details) ? r.item_details : [];
        const details = ClanApp.extractItemDetails(r);

        details.forEach((item, idx) => {
            const holdState = resolveRowHoldState(item);
            const alliance = item.alliance || (['내판', '외판', '이벤트', '성세금포함', '분배금혈귀'].includes(holdState) ? '피닉스' : '');
            const castleTaxDate = holdState === '성세금포함' ? (item.castle_tax_date || '') : '';
            const canDist = isDistributableHoldState(holdState, item.name);
            const distDate = canDist ? (item.dist_date || '').trim() : '';
            const isChecked = canDist && (distDate ? true : Boolean((rawSavedDetails[idx] || {}).dist_checked));

            const distInfo = computeDistStateInfo(r, {
                ...item,
                alliance,
                sale_type: holdState,
                castle_tax_date: castleTaxDate,
                dist_date: distDate,
                dist_checked: isChecked,
                clan_owned: Boolean(item.clan_owned),
                event_item: Boolean(item.event_item)
            }, idx);

            flattenedItems.push({
                key: `${r.id}_${idx}`,
                raid_id: r.id,
                item_idx: idx,
                raid_date: r.raid_date,
                raid_time: r.raid_time,
                name: item.name,
                hold_state: holdState,
                alliance,
                castle_tax_date: castleTaxDate,
                dist_state: distInfo.state,
                dist_label: distInfo.label,
                price: Number(item.price || 0),
                policy_price: Number(ClanApp.priceMap[item.name] || 0),
                clan_owned: Boolean(item.clan_owned),
                event_item: Boolean(item.event_item),
                winner: (item.winner || '').trim(),
                taken_date: item.taken_date || '',
                dist_date: distDate,
                dist_checked: isChecked,
                full_details_ref: details,
                record_ref: r
            });
        });
    });

    renderItemTable();
}

function getFilteredItems() {
    const holdFilter = $id('holdStateFilter').value;
    const distFilter = $id('distStateFilter').value;
    const kw = $id('keywordSearch').value.trim().toLowerCase();

    return flattenedItems.filter(row => {
        if (holdFilter !== 'all' && row.hold_state !== holdFilter) return false;
        if (distFilter !== 'all' && row.dist_state !== distFilter) return false;
        if (kw && !ClanApp.itemMatches(row.name, kw) && !row.winner.toLowerCase().includes(kw)) return false;
        return true;
    });
}

// ---------------------------------------------------------
// 렌더링
// ---------------------------------------------------------
const td = (cls, label, html) =>
    `<td${cls ? ` class="${cls}"` : ''}${label ? ` data-label="${label}"` : ''}>${html}</td>`;

function checkCellHtml(row, i) {
    const inner = isDistributableHoldState(row.hold_state, row.name)
        ? `<input type="checkbox" id="stDistChk_${i}" class="dist-target-checkbox" ${row.dist_checked ? 'checked' : ''}
                  title="체크 시 분배관리로 넘어갑니다." onchange="onDistCheckToggle(${i})">`
        : `<span class="c-faint">-</span>`;
    return `<div id="stCheckCellWrap_${i}" class="dist-check-cell">${inner}</div>`;
}

function viewRowHtml(row, i, isAdmin) {
    const distDateHtml = row.dist_date ? `<span class="txt-date">${ClanApp.toShortDate(row.dist_date)}</span>` : '-';
    const cells = [
        td('mc-meta', '', formatRaidDateTimeCell(row.raid_date, row.raid_time)),
        td('mc-title c-gold', '', ClanApp.itemNameHtml(row.name)),
        td('c-money', '판매가격', formatPriceWithPolicyHint(row)),
        td('', '보유상태', ClanApp.badge(holdLabelOf(row), holdToneOf(row))),
        td('', '분배상태', distBadgeHtml(row.dist_state, row.dist_label)),
        td('c-mint', '수령자', ClanApp.escapeHtml(row.winner || '-')),
        td('', '수령완료일', row.taken_date ? ClanApp.toShortDate(row.taken_date) : '-')
    ];
    if (isAdmin) cells.push(td('', '', checkCellHtml(row, i)));
    cells.push(td('', '분배완료일', distDateHtml));
    if (isAdmin) {
        cells.push(td('', '', `<button type="button" class="btn-row-edit" onclick="startEditItemRow(${ClanApp.jsArg(row.key)})">수정</button>`));
    }
    return `<tr>${cells.join('')}</tr>`;
}

function editRowHtml(row, i) {
    const isCastleTax = ClanApp.isCastleTaxItem(row.name);
    const locked = row.clan_owned || row.event_item;
    const priceCanEdit = locked || isDistributableHoldState(row.hold_state, row.name) || row.hold_state === '분배금혈귀';
    const winnerEnabled = row.alliance || isCastleTax || locked;
    const winnerPlaceholder = row.hold_state === '내판' ? '혈원 아이디 입력'
        : row.hold_state === '외판' ? '명단에 없는 이름'
        : (row.alliance || isCastleTax) ? '(선택) 수령자' : '연합 선택 후 입력';
    const sel = (cond) => (cond ? 'selected' : '');

    const holdCell = locked
        ? ClanApp.badge(row.event_item ? '이벤트템' : '혈비귀속', ClanApp.HOLD_TONE[row.hold_state] || 'gray')
        : `<div class="hold-edit-stack">
               <select id="stAlliance_${i}" class="tbl-select tbl-hold-select" onchange="onLiveRowInput(${i}, true)">
                   <option value="" ${sel(!row.alliance)}>연합분배대기</option>
                   <option value="피닉스" ${sel(row.alliance === '피닉스')}>피닉스</option>
                   <option value="반항" ${sel(row.alliance === '반항')}>반항</option>
                   <option value="세븐" ${sel(row.alliance === '세븐')}>세븐</option>
               </select>
               <select id="stSaleType_${i}" class="tbl-select tbl-hold-select ${row.alliance === '피닉스' ? '' : 'hidden'}" onchange="onLiveRowInput(${i}, true)">
                   <option value="">판매구분 선택</option>
                   ${['내판', '외판', '이벤트', '성세금포함', '분배금혈귀'].map(v => `<option value="${v}" ${sel(row.hold_state === v)}>${v}</option>`).join('')}
               </select>
               <select id="stCastleTaxDate_${i}" class="tbl-select tbl-hold-select ${row.hold_state === '성세금포함' ? '' : 'hidden'}" onchange="onLiveRowInput(${i})">
                   ${buildCastleTaxDateOptionsHtml(row.raid_date, row.castle_tax_date)}
               </select>
           </div>`;

    const superDelete = ClanApp.isSuperAdmin
        ? `<button type="button" class="btn-row-del" onclick="deleteItemRow(${i})">삭제</button>`
        : '';

    return `
        <tr class="is-editing">
            <td>${formatRaidDateTimeCell(row.raid_date, row.raid_time)}</td>
            <td class="c-gold">${ClanApp.itemNameHtml(row.name)}</td>
            <td>
                <input type="number" id="stPrice_${i}" class="tbl-input tbl-price-input" value="${row.price}" min="0"
                       ${priceCanEdit ? '' : 'disabled'} oninput="onLiveRowInput(${i})">
            </td>
            <td>${holdCell}</td>
            <td>${distBadgeHtml(row.dist_state, row.dist_label, `stLiveDistBadge_${i}`)}</td>
            <td>
                <div class="suggest-wrap">
                    <input type="text" id="stWinner_${i}" class="tbl-input tbl-winner-input" autocomplete="off"
                           value="${ClanApp.escapeHtml(row.winner)}" placeholder="${winnerPlaceholder}"
                           ${winnerEnabled ? '' : 'disabled'}
                           oninput="onWinnerTypeSearch(${i})" onkeydown="onWinnerKeydown(event, ${i})">
                    <div id="stWinnerSuggest_${i}" class="suggest-list hidden"></div>
                </div>
            </td>
            <td>
                <input type="date" id="stTaken_${i}" class="tbl-input tbl-date-input" value="${row.taken_date}" title="아이템을 건넨 날짜를 직접 지정" onchange="onLiveRowInput(${i})">
            </td>
            <td>${checkCellHtml(row, i)}</td>
            <td>${row.dist_date ? `<span class="txt-date">${ClanApp.toShortDate(row.dist_date)}</span>` : '-'}</td>
            <td>
                <div class="row-actions">
                    <button type="button" class="btn-sm btn-sm-green btn-xs" onclick="saveItemRow(${i})">저장</button>
                    <button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="cancelEditItemRow(${i})">취소</button>
                    ${superDelete}
                </div>
            </td>
        </tr>
    `;
}

function renderItemTable() {
    visibleRows = getFilteredItems();
    $id('itemTotalCountBadge').textContent = `총 ${visibleRows.length}건`;

    const isAdmin = ClanApp.isAdminModeOn;
    // 일반회원 화면: 모바일에서 카드형 / 관리자 화면: 표 + 가로 스크롤
    $id('itemStatusTable').classList.toggle('tbl-mcard', !isAdmin);

    const tbody = $id('itemStatusTableBody');
    if (visibleRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 10 : 8}" class="empty-party-msg">조회된 아이템 내역이 없습니다.</td></tr>`;
        return;
    }

    tbody.innerHTML = visibleRows.map((row, i) =>
        (isAdmin && editingItemKeys.has(row.key)) ? editRowHtml(row, i) : viewRowHtml(row, i, isAdmin)
    ).join('');
}

// ---------------------------------------------------------
// 수정 모드
// ---------------------------------------------------------
function startEditItemRow(key) {
    if (!ClanApp.isAdminModeOn) return;
    editingItemKeys.add(key);
    renderItemTable();
}

function cancelEditItemRow(i) {
    const row = visibleRows[i];
    if (row) editingItemKeys.delete(row.key);
    renderItemTable();
}

// 수정 중인 행의 입력값 읽기 (입력창이 없으면 저장된 값 사용)
function readRowEdit(i, target) {
    const alEl = $id(`stAlliance_${i}`);
    const stEl = $id(`stSaleType_${i}`);
    const taxDateEl = $id(`stCastleTaxDate_${i}`);
    const wEl = $id(`stWinner_${i}`);
    const pEl = $id(`stPrice_${i}`);
    const takenEl = $id(`stTaken_${i}`);

    let alliance = target ? (target.alliance || '') : '';
    let saleType = target ? target.hold_state : '보유중';
    if (alEl) {
        alliance = alEl.value;
        if (alliance === '반항' || alliance === '세븐') saleType = '연합';
        else if (alliance === '피닉스') saleType = (stEl && stEl.value) ? stEl.value : '보유중';
        else saleType = '보유중';
    }
    const castleTaxDate = saleType === '성세금포함'
        ? (taxDateEl ? taxDateEl.value.trim() : (target ? (target.castle_tax_date || '') : ''))
        : '';
    return {
        alliance,
        saleType,
        castle_tax_date: castleTaxDate,
        winner: wEl ? wEl.value.trim() : (target ? target.winner : ''),
        price: pEl ? Number(pEl.value || 0) : (target ? Number(target.price || 0) : 0),
        taken_date: takenEl ? takenEl.value : (target ? target.taken_date : '')
    };
}

// 수정 중 입력이 바뀔 때마다 분배상태 배지 / 체크칸 / 입력 가능 여부 갱신
function onLiveRowInput(i, manualHoldChange = false) {
    const targetRow = visibleRows[i];
    if (!targetRow) return;
    const winnerEl = $id(`stWinner_${i}`);
    const priceEl = $id(`stPrice_${i}`);
    const stEl = $id(`stSaleType_${i}`);
    const alEl = $id(`stAlliance_${i}`);
    const chkEl = $id(`stDistChk_${i}`);

    if (stEl && alEl) {
        if (manualHoldChange && alEl.value !== '피닉스') stEl.value = '';
        stEl.classList.toggle('hidden', alEl.value !== '피닉스');
    }

    const cur = readRowEdit(i, targetRow);
    const saleType = cur.saleType;
    const taxDateEl = $id(`stCastleTaxDate_${i}`);
    if (taxDateEl) taxDateEl.classList.toggle('hidden', saleType !== '성세금포함');

    const isCastleTax = ClanApp.isCastleTaxItem(targetRow.name);
    const lockedForced = Boolean(targetRow.clan_owned || targetRow.event_item);
    const canCheck = isDistributableHoldState(saleType, targetRow.name);
    const priceEditable = canCheck || saleType === '분배금혈귀';

    if (priceEl && !lockedForced) {
        priceEl.disabled = !priceEditable;
        if (saleType === '이벤트') priceEl.value = 0;
        else if (!priceEditable) priceEl.value = Number(targetRow.policy_price || targetRow.price || 0);
        else if (manualHoldChange && Number(priceEl.value || 0) === 0) priceEl.value = Number(targetRow.policy_price || 0);
    }
    if (winnerEl && !lockedForced) {
        const noAlliance = cur.alliance === '' && !isCastleTax;
        winnerEl.disabled = noAlliance;
        if (noAlliance) winnerEl.value = '';
        winnerEl.placeholder =
            saleType === '내판' ? '혈원 아이디 입력' :
            saleType === '외판' ? '명단에 없는 이름' :
            (['이벤트', '성세금포함', '분배금혈귀'].includes(saleType) || isCastleTax) ? '(선택) 수령자' :
            (cur.alliance === '반항' || cur.alliance === '세븐') ? '(선택) 가져간 혈원' :
            cur.alliance === '피닉스' ? '(선택) 수령자' : '연합 선택 후 입력';
    }

    const winnerVal = winnerEl ? winnerEl.value.trim() : cur.winner;
    const isCurrentlyChecked = canCheck && Boolean((chkEl && chkEl.checked) || targetRow.dist_checked);
    const distInfo = computeDistStateInfo(targetRow.record_ref || { distributions: {} }, {
        name: targetRow.name,
        clan_owned: Boolean(targetRow.clan_owned),
        event_item: Boolean(targetRow.event_item),
        alliance: cur.alliance,
        castle_tax_date: cur.castle_tax_date,
        winner: winnerVal,
        taken_date: winnerVal ? cur.taken_date : '',
        price: saleType === '이벤트' ? 0 : (priceEl ? Number(priceEl.value || 0) : cur.price),
        sale_type: saleType,
        dist_date: canCheck ? targetRow.dist_date : '',
        dist_checked: isCurrentlyChecked
    }, targetRow.item_idx);

    const badgeEl = $id(`stLiveDistBadge_${i}`);
    if (badgeEl) {
        badgeEl.className = `badge badge-${distToneOf(distInfo.state, distInfo.label)}`;
        badgeEl.textContent = distInfo.label;
    }
    const checkWrap = $id(`stCheckCellWrap_${i}`);
    if (checkWrap) {
        checkWrap.outerHTML = checkCellHtml({ ...targetRow, hold_state: saleType, dist_checked: isCurrentlyChecked }, i);
    }
}

// ---------------------------------------------------------
// 수령자 자동완성 (내판일 때 혈원 검색)
// ---------------------------------------------------------
function onWinnerTypeSearch(i) {
    onLiveRowInput(i);
    const winnerEl = $id(`stWinner_${i}`);
    const box = $id(`stWinnerSuggest_${i}`);
    if (!winnerEl || !box) return;

    const cur = readRowEdit(i, visibleRows[i]);
    const q = cur.saleType === '내판' ? winnerEl.value : '';
    ClanApp.suggest.open(box, ClanApp.searchChars(q), (charId) => {
        winnerEl.value = charId;
        saveItemRow(i, charId);
    });
}

function onWinnerKeydown(event, i) {
    const box = $id(`stWinnerSuggest_${i}`);
    const picked = ClanApp.suggest.handleKey(event, box);
    if (!picked && event.key === 'Enter' && !event.isComposing) {
        event.preventDefault();
        saveItemRow(i);
    }
}

// ---------------------------------------------------------
// 저장 / 삭제
// ---------------------------------------------------------
function validateSaleInput(alliance, saleType, winner) {
    if (alliance === '피닉스' && (saleType === '내판' || saleType === '외판')) {
        if (!winner) return `${saleType}은 수령자 이름을 입력해야 합니다.`;
        const inRoster = ClanApp.isClanChar(winner);
        if (saleType === '내판' && !inRoster) return `[${winner}] 은(는) 혈원 명단에 없는 이름입니다. 혈원이면 정확한 아이디를, 명단 밖이면 외판을 선택해 주세요.`;
        if (saleType === '외판' && inRoster) return `[${winner}] 은(는) 혈원 명단에 있는 이름입니다. 혈원이면 내판을 선택해 주세요.`;
    }
    return '';
}

function canDistFor(cur, winner, itemName) {
    return ((cur.saleType === '내판' || cur.saleType === '외판') && Boolean(winner)) ||
        cur.saleType === '성세금포함' ||
        (ClanApp.isCastleTaxItem(itemName) && !NON_DIST_HOLD.includes(cur.saleType));
}

async function postItemDetails(target, mine, errMsg) {
    const details = target.full_details_ref.map((it, idx) => (idx === target.item_idx ? mine : it));
    if (await ClanApp.saveItemDetails(target.raid_id, details, errMsg)) {
        editingItemKeys.delete(target.key);
        await loadItemStatusData();
    }
}

async function onDistCheckToggle(i) {
    if (!ClanApp.isAdminModeOn) return;
    const target = visibleRows[i];
    if (!target) return;

    const chkEl = $id(`stDistChk_${i}`);
    const takenEl = $id(`stTaken_${i}`);
    const cur = readRowEdit(i, target);
    const reject = (msg) => {
        alert(msg);
        if (chkEl) chkEl.checked = false;
    };

    if (!canDistFor(cur, cur.winner, target.name)) {
        return reject('내판·외판(수령자 입력) 또는 성세금·성세금포함 상태일 때만 체크할 수 있습니다.');
    }
    const msg = validateSaleInput(cur.alliance, cur.saleType, cur.winner);
    if (msg) return reject(msg);

    const distChecked = chkEl ? chkEl.checked : false;
    await postItemDetails(target, {
        name: target.name,
        sale_type: cur.saleType,
        alliance: cur.alliance,
        price: cur.price,
        winner: cur.winner,
        taken_date: takenEl ? takenEl.value : (target.taken_date || ''),
        dist_date: distChecked ? (target.dist_date || '') : '',
        dist_checked: distChecked,
        castle_tax_date: cur.saleType === '성세금포함' ? cur.castle_tax_date : ''
    }, '체크 저장 실패');
}

async function saveItemRow(i, forcedWinner = null) {
    if (!ClanApp.isAdminModeOn) return;
    const target = visibleRows[i];
    if (!target) return;

    const cur = readRowEdit(i, target);
    const winner = forcedWinner !== null ? forcedWinner.trim() : cur.winner;
    const msg = validateSaleInput(cur.alliance, cur.saleType, winner);
    if (msg) return alert(msg);

    const isCastleTax = ClanApp.isCastleTaxItem(target.name);
    const canDist = canDistFor(cur, winner, target.name);
    const chkEl = $id(`stDistChk_${i}`);
    // 수령완료일은 아이템을 건넨 사람이 직접 지정 (수령자 저장과 별개)
    const takenDate = winner ? (cur.taken_date || '') : '';
    const winnerAllowed = !(cur.alliance === '' && !isCastleTax && !(target.clan_owned || target.event_item));

    await postItemDetails(target, {
        name: target.name,
        sale_type: cur.saleType,
        alliance: cur.alliance,
        price: cur.saleType === '이벤트' ? 0 : cur.price,
        winner: winnerAllowed ? winner : '',
        taken_date: takenDate,
        dist_date: canDist ? (target.dist_date || '') : '',
        dist_checked: canDist ? (chkEl ? chkEl.checked : Boolean(target.dist_checked)) : false,
        castle_tax_date: cur.saleType === '성세금포함' ? cur.castle_tax_date : ''
    }, '저장 실패');
}

async function deleteItemRow(i) {
    const row = visibleRows[i];
    if (!row) return;
    if (!ClanApp.isSuperAdmin) return alert('슈퍼관리자만 아이템을 삭제할 수 있습니다.');
    if (!confirm(`[${row.name}] 아이템을 완전히 삭제하시겠습니까?`)) return;

    if (await ClanApp.del(`/api/raids/item-details/${row.raid_id}/${row.item_idx}?${ClanApp.roleParam()}`, '아이템 삭제 실패')) {
        editingItemKeys.delete(row.key);
        await loadItemStatusData();
    }
}

function exportItemExcel(kind) {
    ClanApp.exportExcel(kind, $id('filterDate').value, $id('filterMonth').value);
}
