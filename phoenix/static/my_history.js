// =========================================================
// [my_history.js] 캐릭터 참여 · 분배금 수령 내역
// =========================================================
let allRaidsCache = [];
let historyItemFilter = 'all';

window.onload = async () => {
    const user = ClanApp.initPage('/my-history', () => {
        if (!ClanApp.isAdminModeOn) {
            $id('targetMemberIdInput').value = ClanApp.user.active_id;
            reloadProfileAndHistory();
        } else {
            renderHistoryItemsTable();
        }
    });
    if (!user) return;

    $id('targetMemberIdInput').value = user.active_id;
    const now = new Date();
    $id('historyMonth').value = ClanApp.formatYM(now);
    $id('historyDate').value = ClanApp.formatYMD(now);

    await ClanApp.loadMeta();
    await reloadProfileAndHistory();
};

const shortDate = (d) => ClanApp.toShortDate(d);

function getTargetMemberId() {
    if (ClanApp.isAdminModeOn) return $id('targetMemberIdInput').value.trim() || ClanApp.user.active_id;
    return ClanApp.user.active_id;
}

function renderProfileCard(targetId) {
    const m = ClanApp.members.find(x => x.active_id === targetId)
        || (targetId === ClanApp.user.active_id ? ClanApp.user : { active_id: targetId });
    const skills = Array.isArray(m.skills) ? m.skills.join(', ') : (m.skills || '');
    $id('profUniqueId').textContent = m.unique_id || '-';
    $id('profActiveId').textContent = m.active_id || targetId;
    $id('profSubChars').textContent = m.sub_chars || '없음';
    $id('profClassSkills').textContent = `${m.char_class || '-'} (${skills || '스킬없음'})`;
}

// ---------------------------------------------------------
// 기간 선택
// ---------------------------------------------------------
function onHistoryPeriodModeChange() {
    const mode = $id('historyPeriodMode').value;
    $id('historyMonthBox').classList.toggle('hidden', mode !== 'month');
    $id('historyDateBox').classList.toggle('hidden', mode !== 'day');
    $id('historyAllBox').classList.toggle('hidden', mode !== 'all');
    renderAllHistoryViews();
}

function onHistoryMonthChange() {
    const ym = $id('historyMonth').value;
    if (!ym) return;
    if (!$id('historyDate').value.startsWith(ym)) $id('historyDate').value = `${ym}-01`;
    renderAllHistoryViews();
}

function onHistoryDateChange() {
    const d = $id('historyDate').value;
    if (!d) return;
    $id('historyMonth').value = d.slice(0, 7);
    renderAllHistoryViews();
}

// offset 0 = 오늘
function moveHistoryDay(offset) {
    const base = $id('historyDate').value || ClanApp.today();
    $id('historyDate').value = offset === 0 ? ClanApp.today() : ClanApp.shiftDate(base, offset);
    onHistoryDateChange();
}

function setHistoryItemFilter(filterVal) {
    historyItemFilter = filterVal;
    ClanApp.setActiveTab('historyTabs', filterVal);
    renderHistoryItemsTable();
}

async function reloadProfileAndHistory() {
    renderProfileCard(getTargetMemberId());
    allRaidsCache = await ClanApp.fetchRaids();
    renderAllHistoryViews();
}

// ---------------------------------------------------------
// 참여 타임 그리드 + 참여 횟수
// ---------------------------------------------------------
function renderAllHistoryViews() {
    const targetId = getTargetMemberId();
    const dateVal = $id('historyDate').value || ClanApp.today();
    const monthVal = $id('historyMonth').value || dateVal.slice(0, 7);
    $id('selectedHistoryDateLabel').textContent = shortDate(dateVal);

    let monthPartCount = 0;
    let dayPartCount = 0;
    const joinedSlots = new Set();

    allRaidsCache.forEach(r => {
        if (!ClanApp.participantIds(r).includes(targetId)) return;
        if ((r.raid_date || '').startsWith(monthVal)) monthPartCount++;
        if (r.raid_date === dateVal) {
            dayPartCount++;
            joinedSlots.add(r.raid_time);
        }
    });

    $id('dayParticipatedCount').textContent = dayPartCount;
    $id('monthParticipatedCount').textContent = monthPartCount;

    $id('myCommonTimeGrid').innerHTML = ClanApp.getRaidTimes(dateVal).map(t => {
        const joined = joinedSlots.has(t);
        return `
            <div class="common-time-btn ${joined ? 'is-on' : ''}"${ClanApp.slotAttr(t)}>
                <span>${t}</span>
                <span class="common-time-sub">${joined ? '참여완료' : '미참여'}</span>
            </div>`;
    }).join('');

    renderHistoryItemsTable();
}

function matchesDateFilter(targetDateStr, periodMode, refDateVal, refMonthVal) {
    if (periodMode === 'all') return true;
    if (!targetDateStr) return false;
    if (periodMode === 'day') return targetDateStr === refDateVal;
    if (periodMode === 'month') return targetDateStr.startsWith(refMonthVal);
    return true;
}

// ---------------------------------------------------------
// 아이템 / 분배금 내역 표
// ---------------------------------------------------------
function buildHistoryRows() {
    const targetId = getTargetMemberId();
    const basis = $id('historyDateBasis').value;
    const periodMode = $id('historyPeriodMode').value;
    const refDateVal = $id('historyDate').value || ClanApp.today();
    const refMonthVal = $id('historyMonth').value || refDateVal.slice(0, 7);
    const kw = $id('historyItemSearch').value.trim().toLowerCase();
    const todayStr = ClanApp.today();
    const { bonusMap, sourceMap } = ClanApp.buildCastleTaxMaps(allRaidsCache);
    const rows = [];

    const inPeriod = (raidDate, distDate, paidDate) => {
        const compare = basis === 'dist_date' ? distDate : (basis === 'paid_date' ? paidDate : raidDate);
        return matchesDateFilter(compare, periodMode, refDateVal, refMonthVal);
    };

    // 분배관리 기준: 성세금포함 아이템은 해당 일자 공성 참여자에게 귀속
    const pushCastleIncludedRows = (r, item, idx) => {
        const siegeRaid = ClanApp.findSiegeRaid(allRaidsCache, sourceMap, r, idx, item);
        if (!siegeRaid) return;
        const siegeIds = ClanApp.participantIds(siegeRaid);
        if (!siegeIds.includes(targetId)) return;

        const src = sourceMap[`${r.id}_${idx}`];
        const merged = Boolean(src && src.target_key);
        const netPrice = ClanApp.netOf(item.price);
        const myShare = (siegeIds.length > 0 && netPrice > 0) ? Math.floor(netPrice / siegeIds.length) : 0;

        let clanDistDate = (item.dist_date || '').trim();
        let distInfo;
        if (merged) {
            const tIdx = Number(String(src.target_key).split('_').pop());
            const tItem = ClanApp.extractItemDetails(siegeRaid)[tIdx] || {};
            clanDistDate = (tItem.dist_date || '').trim() || todayStr;
            distInfo = ClanApp.getDistInfo(siegeRaid, tIdx, clanDistDate, targetId, '');
        } else {
            distInfo = ClanApp.getDistInfo(r, idx, clanDistDate, targetId, '');
        }
        const myPaidDate = distInfo.paid_date || '';
        if (!inPeriod(r.raid_date, clanDistDate, myPaidDate)) return;

        rows.push({
            raid_date: r.raid_date,
            raid_time: r.raid_time,
            memberCount: siegeIds.length,
            item_name: item.name,
            sale_type: item.sale_type,
            alliance: item.alliance || '',
            winner: item.winner || '',
            net_price: netPrice,
            my_share: myShare,
            clan_dist_date: clanDistDate,
            is_done: distInfo.status === '분배완료',
            method: distInfo.method || '본인수령',
            receiver_id: (distInfo.proxy_name || '').trim() || targetId,
            paid_date: myPaidDate,
            blood_credit_from: '',
            castle_merged: merged,
            castle_target_date: siegeRaid.raid_date,
            info_only: merged,
            force_dist: !merged
        });
    };

    allRaidsCache.forEach(r => {
        const pIds = ClanApp.participantIds(r);
        const memberCount = pIds.length;

        ClanApp.extractItemDetails(r).forEach((item, idx) => {
            if (!ClanApp.itemMatches(item.name, kw)) return;

            const sType = item.sale_type || '보유중';
            if (sType === '성세금포함') return pushCastleIncludedRows(r, item, idx);

            const isNonDistType = ['연합', '이벤트', '분배금혈귀'].includes(sType);
            // 연합분배대기(보유중): 연합/내판/외판/이벤트 결정 전이므로 분배금 0원
            const isAllianceWait = sType === '보유중';
            const bonusInfo = ClanApp.isCastleTaxItem(item.name) ? bonusMap[`${r.id}_${idx}`] : null;
            const hasIncludedBonus = Boolean(bonusInfo && bonusInfo.includedItems.length > 0);
            const clanDistDate = isNonDistType ? '' : ((item.dist_date || '').trim() || (hasIncludedBonus ? todayStr : ''));
            const grossPrice = (isNonDistType || isAllianceWait) ? 0 : (Number(item.price || 0) + (bonusInfo ? bonusInfo.bonusPrice : 0));
            const netPrice = ClanApp.netOf(grossPrice);
            const myItemShare = (memberCount > 0 && netPrice > 0) ? Math.floor(netPrice / memberCount) : 0;

            const pushRow = (ownerId, isBloodCredit) => {
                const distInfo = ClanApp.getDistInfo(r, idx, clanDistDate, ownerId, '');
                const myPaidDate = isNonDistType ? '' : (distInfo.paid_date || '');
                if (!inPeriod(r.raid_date, clanDistDate, myPaidDate)) return;

                rows.push({
                    raid_date: r.raid_date,
                    raid_time: r.raid_time,
                    memberCount,
                    item_name: item.name,
                    sale_type: sType,
                    alliance: item.alliance || '',
                    winner: item.winner || '',
                    net_price: netPrice,
                    my_share: myItemShare,
                    clan_dist_date: clanDistDate,
                    is_done: isNonDistType ? true : distInfo.status === '분배완료',
                    method: isBloodCredit ? '혈귀속' : (distInfo.method || '본인수령'),
                    receiver_id: isBloodCredit ? targetId : ((distInfo.proxy_name || '').trim() || ownerId),
                    paid_date: myPaidDate,
                    blood_credit_from: isBloodCredit ? ownerId : ''
                });
            };

            // 1) 본인이 참여한 보스탐: 본인 내역 (대리수령이면 본 아이디에 그대로 표시)
            if (pIds.includes(targetId)) pushRow(targetId, false);

            // 2) 다른 참여자의 분배금이 혈귀속으로 targetId(예: 피닉스혈)에게 귀속된 경우
            if (!isNonDistType && !isAllianceWait) {
                pIds.forEach(ownerId => {
                    if (ownerId === targetId) return;
                    const info = ClanApp.getDistInfo(r, idx, clanDistDate, ownerId, '');
                    if (info.status === '분배완료' && info.method === '혈귀속' && (info.proxy_name || '').trim() === targetId) {
                        pushRow(ownerId, true);
                    }
                });
            }
        });
    });

    return rows;
}

function statusCellHtml(row) {
    const B = (label, tone) => ClanApp.badge(label, tone, 'badge-lg');
    if (row.sale_type === '성세금포함' && row.castle_merged) {
        return B(`↳ 성세금합산(${shortDate(row.castle_target_date)}) · ${row.is_done ? '분배완료' : '분배대기'}`, 'indigo');
    }
    if (row.sale_type === '연합') {
        const where = (row.alliance && row.alliance !== '피닉스') ? row.alliance : row.winner;
        return B(`${where ? `연합(${where})` : '연합'} · 분배제외`, 'teal');
    }
    if (row.sale_type === '성세금포함' && !row.force_dist) return B('성세금포함', 'indigo');
    if (row.sale_type === '분배금혈귀') return B('분배금혈귀 · 분배제외', 'rose');
    if (row.sale_type === '이벤트') return B('이벤트 · 분배제외', 'purple');
    if (row.sale_type === '보유중') {
        return row.alliance === '피닉스' ? B('피닉스 판매대기', 'pink') : B('연합분배대기', 'amber');
    }
    if (row.is_done) {
        let methodLabel = `본인수령 (${row.receiver_id})`;
        if (row.method === '대리수령') methodLabel = `대리수령 (${row.receiver_id})`;
        else if (row.method === '혈귀속') {
            methodLabel = row.blood_credit_from
                ? `혈귀속 수령 (${row.blood_credit_from} 분)`
                : `혈귀속 (${row.receiver_id || '피닉스혈'})`;
        }
        const datePart = row.paid_date ? `<span class="done-paid-date">${shortDate(row.paid_date)}</span>` : '';
        return `<div class="history-status-cell">${B(methodLabel, 'gray')}${datePart}</div>`;
    }
    return B(`${row.force_dist ? '성세금포함' : row.sale_type} · 분배대기`, 'amber');
}

function renderHistoryItemsTable() {
    const allItemRows = buildHistoryRows();
    const waitRows = allItemRows.filter(x => !x.is_done);
    const doneRows = allItemRows.filter(x => x.is_done);

    $id('cntAllItems').textContent = allItemRows.length;
    $id('cntWaitItems').textContent = waitRows.length;
    $id('cntDoneItems').textContent = doneRows.length;

    const targetRows = historyItemFilter === 'wait' ? waitRows : (historyItemFilter === 'done' ? doneRows : allItemRows);
    const tbody = $id('dailyIndividualShareBody');
    if (targetRows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-party-msg">해당 검색 조건에 조회된 아이템 내역이 없습니다.</td></tr>`;
        return;
    }

    const totalMyShare = targetRows.reduce((acc, cur) => acc + (cur.info_only ? 0 : cur.my_share), 0);
    tbody.innerHTML = targetRows.map(row => `
        <tr>
            <td class="c-soft">${shortDate(row.raid_date)} ${ClanApp.escapeHtml(row.raid_time)}</td>
            <td class="drop-item-name">${ClanApp.itemNameHtml(row.item_name)}</td>
            <td class="c-soft">${row.net_price.toLocaleString()}</td>
            <td class="c-soft">${row.memberCount}명</td>
            <td class="c-gold my-share-cell">${row.my_share.toLocaleString()}</td>
            <td class="txt-date">${row.clan_dist_date ? shortDate(row.clan_dist_date) : '-'}</td>
            <td>${statusCellHtml(row)}</td>
        </tr>`).join('') + `
        <tr class="history-sum-row">
            <td colspan="7">조회 기간 내 분배금 합계: <span class="history-sum-amount">${totalMyShare.toLocaleString()}</span></td>
        </tr>`;
}

function exportHistoryExcel(kind) {
    ClanApp.exportExcel(kind, $id('historyDate').value, $id('historyMonth').value);
}
