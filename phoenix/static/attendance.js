// =========================================================
// [attendance.js] 전체 혈원 보스탐 참여도
// =========================================================
const MAIN_SLOTS = ClanApp.MAIN_RAID_TIMES;
const EXCLUDED_SHARE_TYPES = ['이벤트', '연합', '보유중', '성세금포함', '분배금혈귀'];
let monthRaids = [];
let sortMode = 'monthTotal';

window.onload = async () => {
    const user = ClanApp.initPage('/attendance');
    if (!user) return;

    $id('attMonthInput').value = ClanApp.formatYM();
    await ClanApp.loadMeta();
    $id('memberCountLabel').textContent = `전체 ${ClanApp.members.length}명`;
    $id('kpiTotalMembers').textContent = `${ClanApp.members.length}명`;
    await loadMonthRaidsData();
};

function updateMonthlyShareLabels() {
    const ym = $id('attMonthInput').value || ClanApp.formatYM();
    const monthNum = parseInt(ym.split('-')[1], 10) || (new Date().getMonth() + 1);
    const label = `${monthNum}월 누적분배금`;
    $id('thMonthlyShare').innerHTML = `${monthNum}월<br>누적분배금`;
    $id('sortBtnTotalShare').textContent = `${label}순`;
    $id('attSectionTitle').textContent = `🏆 전체 혈원 월별 참여 횟수 및 ${label}`;
}

function setSortMode(mode) {
    sortMode = mode;
    ClanApp.setActiveTab('attSortTabs', mode);
    renderAttendanceTable();
}

async function loadMonthRaidsData() {
    updateMonthlyShareLabels();
    monthRaids = await ClanApp.fetchRaids({ month: $id('attMonthInput').value || ClanApp.formatYM() });
    renderAttendanceTable();
}

function buildStats() {
    const statsMap = new Map();
    ClanApp.members.forEach(m => {
        statsMap.set(m.active_id, {
            id: m.active_id,
            char_class: m.char_class || '-',
            sub_chars: m.sub_chars || '',
            monthTotal: 0,
            totalShare: 0,
            monthMain: 0,
            slotCounts: Object.fromEntries(MAIN_SLOTS.map(s => [s, 0]))
        });
    });

    const bonusMap = ClanApp.buildCastleTaxBonusMap(monthRaids);

    monthRaids.forEach(r => {
        const pList = ClanApp.extractParticipants(r);
        const pCount = pList.length;
        if (pCount === 0) return;

        const isMainSlot = MAIN_SLOTS.includes(r.raid_time);
        let raidPerMemberShare = 0;
        ClanApp.extractItemDetails(r).forEach((item, idx) => {
            if (EXCLUDED_SHARE_TYPES.includes(item.sale_type || '보유중')) return;
            const bonusInfo = ClanApp.isCastleTaxItem(item.name) ? bonusMap[`${r.id}_${idx}`] : null;
            const netPool = ClanApp.netOf(Number(item.price || 0) + (bonusInfo ? bonusInfo.bonusPrice : 0));
            if (netPool > 0) raidPerMemberShare += Math.floor(netPool / pCount);
        });

        pList.forEach(p => {
            const st = statsMap.get(p.id);
            if (!st) return;
            st.monthTotal += 1;
            st.totalShare += raidPerMemberShare;
            if (isMainSlot) {
                st.monthMain += 1;
                st.slotCounts[r.raid_time] = (st.slotCounts[r.raid_time] || 0) + 1;
            }
        });
    });
    return [...statsMap.values()];
}

// 정렬 기준별 비교 키 (앞에서부터 차례로 비교)
function sortKeys(row) {
    if (sortMode === 'totalShare') return [row.totalShare, row.monthTotal];
    if (sortMode === 'monthMain') return [row.monthMain, row.monthTotal];
    if (MAIN_SLOTS.includes(sortMode)) return [row.slotCounts[sortMode] || 0, row.monthMain];
    return [row.monthTotal, row.totalShare, row.monthMain];
}

function renderAttendanceTable() {
    const classFilter = $id('attClassFilter').value;
    const kw = $id('attMemberSearch').value.trim().toLowerCase();

    const activeRaids = monthRaids.filter(r => ClanApp.extractParticipants(r).length > 0);
    $id('kpiMonthRaids').textContent = `총 ${activeRaids.length}회`;
    $id('kpiMonthMainRaids').textContent = `총 ${activeRaids.filter(r => MAIN_SLOTS.includes(r.raid_time)).length}회`;

    const rows = buildStats().filter(row => {
        if (classFilter !== 'all' && row.char_class !== classFilter) return false;
        if (kw && !row.id.toLowerCase().includes(kw) && !row.sub_chars.toLowerCase().includes(kw)) return false;
        return true;
    });

    rows.sort((a, b) => {
        const ka = sortKeys(a);
        const kb = sortKeys(b);
        for (let i = 0; i < ka.length; i++) {
            if (kb[i] !== ka[i]) return kb[i] - ka[i];
        }
        return a.id.localeCompare(b.id, 'ko');
    });

    const tbody = $id('attendanceTableBody');
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="empty-party-msg">조회된 혈원이 없습니다.</td></tr>`;
        return;
    }

    const slotCell = (cnt) => `<td class="c-soft">${cnt}회</td>`;
    tbody.innerHTML = rows.map((r, idx) => `
        <tr>
            <td><span class="rank-badge ${idx < 3 ? 'top-rank' : ''}">${idx + 1}</span></td>
            <td class="c-gold">${ClanApp.escapeHtml(r.id)}</td>
            <td class="c-soft">${ClanApp.escapeHtml(r.char_class)}</td>
            <td><span class="count-pill">${r.monthTotal}회</span></td>
            <td>${r.totalShare > 0
                ? `<span class="share-amount-text">${r.totalShare.toLocaleString()}</span>`
                : `<span class="share-zero-text">0</span>`}</td>
            <td class="c-white">${r.monthMain}회</td>
            ${MAIN_SLOTS.map(s => slotCell(r.slotCounts[s])).join('')}
        </tr>`).join('');
}
