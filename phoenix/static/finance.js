// =========================================================
// [finance.js] 혈비 재정 관리
//  - 장부는 엑셀(구글 시트)과 같은 형식: 연번 · 날짜 · 항목1 · 항목2 · 수입 · 지출 · 비고, 합계줄은 머리글 위
//  - 첫 박스: 혈비 잔액 | 수입 · 지출, 기본은 이번 달 1달간 (수입 − 지출), 기간(전체 / 월별) 선택 → 요약 + 장부 모두 그 기간 기준
//  - 자동 줄: 템보유현황 · 분배관리 입력값에서 바로 계산 (입찰판매 · 혈비지원템구입 · 성세금 · 분배금지급 · 혈귀속)
//    → 저장하지 않으므로 그쪽을 고치면 장부도 바로 맞춰짐, [수정]으로 비고 첨언만 저장
//  - 기부(기부금 · 기부물품)는 같은 날짜끼리 1줄로 합쳐 배지로 표시, [수정]을 누르면 펼쳐서 한 건씩 수정
//  - [📦 비품관리] → 팝업 (재고), 비품마다 [관리] → 하루 1줄 입출 내역 + 구입(장부 자동 기록) · 사용 · 입고 · 재고조정
// =========================================================

// 항목1 (구분은 항목에 따라 자동, 기타만 직접 선택)
//  sub: supply = 항목2가 비품 / basis = 인원·1회 다이 / list = 정해진 세부 항목
const CAT1 = [
    { name: '비품구입', kind: 'expense', sub: 'supply' },
    { name: '입찰판매', kind: 'income' },
    { name: '분배금지급', kind: 'expense' },
    { name: '복구비지급', kind: 'expense', sub: 'basis' },
    { name: '혈비지원템구입', kind: 'expense' },
    { name: '기부', sub: 'list', subs: ['기부금', '기부물품'] },
    { name: '이벤트', sub: 'list', subs: ['이벤트금', '이벤트물품'] },
    { name: '기타', kind: '', free: true }
];
// 항목2 세부 (저장 시 항목명 = 항목2)
const SUB_INFO = {
    '기부금': { group: '기부', kind: 'income', person: '기부자' },
    '기부물품': { group: '기부', kind: 'income', person: '기부자', item: 'in' },
    '이벤트금': { group: '이벤트', kind: 'expense', person: '당첨자' },
    '이벤트물품': { group: '이벤트', kind: 'expense', person: '당첨자', item: 'out' }
};
const DONATION_CATS = ['기부금', '기부물품'];
const AUTO_CATS = ['입찰판매', '혈비지원템구입', '성세금', '분배금지급', '혈귀속'];
const BASIS_LABEL = { '명': '인원', '회': '1회 다이' };
const CLAN_CHAR = '피닉스혈';
const NEW_SUPPLY = '__new_supply__';
const AUTO_MARK = '<span class="auto-mark" title="템보유현황 · 분배관리에서 자동">🔄</span>';   // 혈 캐릭터: 이 이름이 수령자인 내판 = 혈비로 산 아이템

let fin = { ledger: [], categories: [], supplies: [], moves: [], auto_notes: {} };
let allRaids = [];
let rows = [];               // 장부 원본 (수동 + 자동, 날짜순)
let period = ClanApp.today().slice(0, 7);   // 기본: 이번 달 · 'all' | 'YYYY-MM'
let editingKey = null;       // 행 안에서 수정 중인 줄 (m_장부id / 자동 줄 키)
let editDraft = null;        // 수정 중인 값 (항목 바꿀 때 다시 그리기용)
let expandedDonation = null; // 펼친 기부 묶음 날짜
let newestFirst = true;      // 기본 최신순
let openSupply = '';         // [관리] 팝업에 열린 비품
let pendingItems = [];       // 입력 팝업: 기부물품 · 이벤트물품 배지 { name, qty, person }
let stockPending = [];       // 비품 입력/지출 팝업: 배지 { name, qty, memo }
let stockDir = 'out';        // 비품 지출 팝업
let formMode = '';           // 입력 팝업: '' 혈비 전체 항목 / 'supply' 비품관리에서 연 입력 (비품구입 · 기부물품만)
let editingSupplyDay = null; // [관리] 입출 내역에서 수정 중인 날짜

window.onload = async () => {
    const user = ClanApp.initPage('/finance', () => {
        editingKey = null;
        editDraft = null;
        renderAll();
    });
    if (!user) return;

    await ClanApp.loadMeta();
    await reloadAll();
};

const fmt = (n) => Number(n || 0).toLocaleString();
const esc = (v) => ClanApp.escapeHtml(v);
const fmtQty = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
// 엑셀과 같은 날짜 표기: 2026.11.9
const dotDate = (d) => {
    const [y, m, dd] = String(d || '').split('-');
    return y ? `${y}.${Number(m)}.${Number(dd)}` : '-';
};
const cat1Info = (name) => CAT1.find(c => c.name === name) || null;
const supplyByName = (name) => (fin.supplies || []).find(s => s.name === name) || null;
const supplyOptions = (selected, emptyLabel) => (emptyLabel ? `<option value="">${emptyLabel}</option>` : '')
    + (fin.supplies || []).map(s => `<option value="${esc(s.name)}" ${s.name === selected ? 'selected' : ''}>${esc(s.name)}</option>`).join('');

async function reloadAll() {
    const [data, raids] = await Promise.all([ClanApp.getJSON('/api/finance', null), ClanApp.fetchRaids()]);
    if (!data) {
        $id('ledgerBody').innerHTML = `<tr><td colspan="8" class="empty-party-msg">재정 데이터를 불러오지 못했습니다. (Supabase 테이블 생성 여부 확인)</td></tr>`;
        return;
    }
    fin = data;
    allRaids = raids || [];
    buildRows();
    fillSelects();
    renderAll();
}

function renderAll() {
    buildRows();
    renderPeriodChips();
    renderKpis();
    renderLedger();
    renderSupplies();
    if (openSupply && !$id('supplyModal').classList.contains('hidden')) renderSupplyModal();
}

// ---------------------------------------------------------
// 자동 줄: 템보유현황 · 분배관리 → 장부
// ---------------------------------------------------------
function buildAutoRows() {
    const out = [];
    const notes = fin.auto_notes || {};
    const alias = (n) => ClanApp.getItemAlias(n);
    const base = { id: null, auto: true, counted: true, income: 0, expense: 0, details: [], cat2: '', memo: '', person: '', supply_name: '', qty_unit: '', unit_price: 0, quantity: 0 };
    const push = (row) => out.push({ ...base, ...row, note: notes[row.key] || '' });

    const groups = new Map();
    // 혈귀속 분배금: 받아간 날짜 + 혈분배일 별로 1줄
    const addGroup = (type, date, amount, detail, distDate) => {
        if (!date || amount <= 0) return;
        const key = `clan_${date}_${distDate}`;
        if (!groups.has(key)) groups.set(key, { key, type, date, distDate, amount: 0, details: [] });
        const g = groups.get(key);
        g.amount += amount;
        g.details.push(detail);
    };

    // 1) 아이템 판매: 입찰판매(수입) · 피닉스혈 내판 = 혈비지원템구입(지출) · 분배금혈귀 = 혈귀속
    allRaids.forEach(r => {
        ClanApp.extractItemDetails(r).forEach((it, idx) => {
            const price = Number(it.price || 0);
            const winner = String(it.winner || '').trim();
            const taken = String(it.taken_date || '').trim();
            const date = taken;   // 수령완료일이 입력된 날 = 판매대금을 받은 날
            const name = alias(it.name);
            if (['내판', '외판', '성세금포함'].includes(it.sale_type) && winner && price > 0 && date) {
                push({
                    key: `sale_${r.id}_${idx}`, date, category: '입찰판매', cat2: name, income: price,
                    autoTags: [it.sale_type === '내판' ? '' : it.sale_type, `수령 ${winner}`].filter(Boolean)
                });
                if (it.sale_type === '내판' && winner === CLAN_CHAR) {
                    push({ key: `sale_${r.id}_${idx}_buy`, date, category: '혈비지원템구입', cat2: name, expense: price, autoTags: [`${CLAN_CHAR} 내판`] });
                }
            }
            if (it.sale_type === '분배금혈귀' && winner && taken && price > 0) {
                push({ key: `clanitem_${r.id}_${idx}`, date: taken, category: '혈귀속', cat2: name, income: price, autoTags: ['분배금혈귀', `수령 ${winner}`] });
            }
        });
    });

    // 2) 분배
    //  - 분배금지급(지출): 혈분배일 기준, 그 혈분배일 분배가 전부 완료되면 전체 분배금(혈귀속 몫 포함)을 혈분배일에 지출
    //  - 혈귀속(수입): 참여자 개별 수령현황에서 혈귀속인 몫을 분배받아간일 기준으로 수입
    //  - 성세금(수입): 성세금 아이템 혈분배일
    const batches = new Map();   // 혈분배일 -> { total, done, members, items }
    const md = (d) => { const [, m, dd] = d.split('-'); return `${Number(m)}.${Number(dd)}`; };
    ClanApp.buildDistEntries(allRaids).forEach(e => {
        if (e.is_castle_tax_included) return;   // 성세금포함 합산분은 성세금 쪽에서 지급
        const ownDistDate = String((e.full_details_ref[e.item_idx] || {}).dist_date || '').trim();
        if (ClanApp.isCastleTaxItem(e.name) && ownDistDate && e.base_price > 0) {
            push({ key: `castle_${e.raid_id}_${e.item_idx}`, date: ownDistDate, category: '성세금', cat2: e.raid_date ? dotDate(e.raid_date) : '', income: e.base_price, autoTags: ['공성 성세금'] });
        }
        if (!ownDistDate || e.per_share <= 0) return;   // 혈분배일이 정해진 것만
        const name = alias(e.name);

        if (!batches.has(ownDistDate)) batches.set(ownDistDate, { total: 0, done: true, members: new Set(), items: [] });
        const bt = batches.get(ownDistDate);
        bt.total += e.per_share * e.participants.length;
        bt.done = bt.done && e.is_done;
        e.participants.forEach(p => bt.members.add(p.id));
        bt.items.push(name);

        e.participants.forEach(p => {
            const info = ClanApp.getDistInfo(e.raid_ref, e.item_idx, e.dist_date, p.id);
            if (info.status === '분배완료' && info.method === '혈귀속') {
                addGroup('혈귀속', info.paid_date || ownDistDate, e.per_share, `${p.id} 분배금 (${name}) ${fmt(e.per_share)}`, ownDistDate);
            }
        });
    });

    batches.forEach((bt, distDate) => {
        if (!bt.done || bt.total <= 0) return;   // 혈분배일 분배가 전부 끝나야 지출로 기록
        push({
            key: `pay_${distDate}`, date: distDate, category: '분배금지급', expense: bt.total,
            autoTags: [`혈분배일 ${md(distDate)} 분배완료`, `${bt.members.size}명`, [...new Set(bt.items)].join('·')]
        });
    });
    groups.forEach(g => {
        push({ key: g.key, date: g.date, category: '혈귀속', cat2: '분배금', income: g.amount, autoTags: [`혈분배일 ${md(g.distDate)}`], details: g.details });
    });
    return out;
}

// 저장된 항목 → 화면의 항목1 / 항목2
function splitCategory(r) {
    if (r.auto) return [r.category, r.cat2 || ''];
    const sub = SUB_INFO[r.category];
    if (sub) return [sub.group, r.category];
    if (r.category === '이벤트') return ['이벤트', ''];
    if (r.category === '복구비지급') return [r.category, BASIS_LABEL[r.qty_unit] || ''];
    return [r.category, r.supply_name && r.supply_name !== r.category ? r.supply_name : ''];
}

function buildRows() {
    const manual = (fin.ledger || []).map(l => ({
        key: `m_${l.id}`,
        id: l.id,
        auto: false,
        counted: true,
        date: l.entry_date,
        category: l.category,
        income: Number(l.income || 0),
        expense: Number(l.expense || 0),
        unit_price: Number(l.unit_price || 0),
        quantity: Number(l.quantity || 0),
        supply_name: l.supply_name || '',
        qty_unit: l.qty_unit || '',
        person: l.person || '',
        memo: l.memo || '',
        details: []
    }));

    rows = manual.concat(buildAutoRows()).sort((a, b) =>
        a.date.localeCompare(b.date) || (a.auto - b.auto) || ((a.id || 0) - (b.id || 0)) || a.key.localeCompare(b.key));
    rows.forEach(r => { [r.cat1, r.cat2] = splitCategory(r); });
}

// ---------------------------------------------------------
// 기간 (전체 / 월별) + 요약
// ---------------------------------------------------------
function sumOf(list) {
    const counted = list.filter(r => r.counted);
    const income = counted.reduce((a, r) => a + r.income, 0);
    const expense = counted.reduce((a, r) => a + r.expense, 0);
    return { income, expense, net: income - expense };
}

// 첫 기록 달 ~ 이번 달까지 (기록이 없어도 이번 달은 표시)
function periodMonths() {
    const thisMonth = ClanApp.today().slice(0, 7);
    const firstData = rows.length ? rows[0].date.slice(0, 7) : thisMonth;
    const lastData = rows.length ? rows[rows.length - 1].date.slice(0, 7) : thisMonth;
    const last = lastData > thisMonth ? lastData : thisMonth;
    let [y, m] = (firstData < thisMonth ? firstData : thisMonth).split('-').map(Number);
    const months = [];
    while (`${y}-${String(m).padStart(2, '0')}` <= last && months.length < 120) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        if (++m > 12) { m = 1; y++; }
    }
    return months;
}

function periodLabel(p = period) {
    if (p === 'all') return '전체';
    const [y, m] = p.split('-').map(Number);
    return y === Number(ClanApp.today().slice(0, 4)) ? `${m}월` : `${String(y).slice(2)}년 ${m}월`;
}

function renderPeriodChips() {
    const months = periodMonths();
    if (period !== 'all' && !months.includes(period)) period = 'all';
    $id('periodChips').innerHTML = ['all', ...months].map(p =>
        `<button type="button" class="tab-btn fin-period-chip ${p === period ? 'active' : ''}" onclick="setPeriod('${p}')">${periodLabel(p)}</button>`).join('');
}

function setPeriod(p) {
    period = p;
    editingKey = null;
    editDraft = null;
    renderPeriodChips();
    renderKpis();
    renderLedger();
}

const inPeriod = (r) => period === 'all' || r.date.startsWith(period);

function renderKpis() {
    const s = sumOf(rows.filter(inPeriod));
    const label = periodLabel();
    $id('kpiIncome').textContent = fmt(s.income);
    $id('kpiExpense').textContent = fmt(s.expense);
    $id('kpiBalance').textContent = fmt(s.net);
    $id('kpiIncomePeriod').textContent = label;
    $id('kpiExpensePeriod').textContent = label;
    $id('kpiBalancePeriod').textContent = period === 'all' ? '전체' : `${label} 수입 − 지출`;
    $id('kpiBalance').classList.toggle('c-expense', s.net < 0);
}

// ---------------------------------------------------------
// 장부 표
// ---------------------------------------------------------
function filteredRows() {
    const cat = $id('categoryFilter').value;
    const kw = $id('ledgerSearch').value.trim().toLowerCase();
    return rows.filter(r => {
        if (!inPeriod(r)) return false;
        if (cat && r.cat1 !== cat) return false;
        if (kw && !`${r.category} ${r.cat1} ${r.cat2} ${r.memo} ${r.note || ''} ${r.person} ${r.supply_name} ${(r.autoTags || []).join(' ')} ${r.details.join(' ')}`.toLowerCase().includes(kw)) return false;
        return true;
    });
}

// 같은 날짜의 기부(기부금 · 기부물품)를 1줄로 묶기 (1건뿐이면 그대로)
function displayRows(list) {
    const out = [];
    const byDate = new Map();
    list.forEach(r => {
        if (r.auto || !DONATION_CATS.includes(r.category)) { out.push(r); return; }
        if (!byDate.has(r.date)) {
            const g = { merged: true, key: `don_${r.date}`, date: r.date, cat1: '기부', items: [], income: 0, expense: 0, counted: true };
            byDate.set(r.date, g);
            out.push(g);
        }
        const g = byDate.get(r.date);
        g.items.push(r);
        g.income += r.income;
        g.expense += r.expense;
    });
    return out.map(r => {
        if (!r.merged || r.items.length > 1) return r;
        return r.items[0];
    }).map(r => {
        if (r.merged) r.cat2 = [...new Set(r.items.map(x => x.category))].join(' · ');
        return r;
    });
}

function toggleSort() {
    newestFirst = !newestFirst;
    $id('sortToggleBtn').textContent = newestFirst ? '최신순 ▼' : '오래된순 ▲';
    renderLedger();
}

// 비고 앞 태그: 카오개 구입처럼 "5,000 × 100 카오개" / 복구비 "300,000 × 5명" · "300,000 × 7회 다이" / 물품 "모내 500"
function qtyTagHtml(r) {
    if (r.unit_price && r.quantity) {
        let suffix = '';
        if (r.supply_name) suffix = ` ${esc(r.supply_name)}`;
        else if (r.qty_unit === '명') suffix = '명';
        else if (r.qty_unit === '회') suffix = '회 다이';
        else if (r.qty_unit) suffix = esc(r.qty_unit);
        return `<span class="qty-tag">${fmt(r.unit_price)} × ${fmtQty(r.quantity)}${suffix}</span>`;
    }
    if (r.quantity && r.supply_name) {
        const sign = (SUB_INFO[r.category] || {}).item === 'out' ? '−' : '';
        return `<span class="qty-tag">${esc(r.supply_name)} ${sign}${fmtQty(r.quantity)}</span>`;
    }
    return '';
}

function personTagHtml(r) {
    if (!r.person) return '';
    const sub = SUB_INFO[r.category];
    return `<span class="person-tag">${esc((sub && sub.person) || '이름')} ${esc(r.person)}</span>`;
}

function memoHtml(r) {
    const tags = (r.autoTags || []).map(t => `<span class="auto-tag">${esc(t)}</span>`).join(' ');
    const note = r.note ? `<span class="note-text">💬 ${esc(r.note)}</span>` : '';
    let html = [qtyTagHtml(r), personTagHtml(r), tags, r.memo ? esc(r.memo) : '', note].filter(Boolean).join(' ');
    if (r.details.length) {
        html = `<details><summary>${html}</summary><ul class="auto-detail">${r.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>`;
    }
    return html;
}

// 기부 묶음 비고: 기부자별로 [모내 500] [카오개 500] [💰 1,000,000] 배지
function donationMemoHtml(g) {
    const byPerson = new Map();
    g.items.forEach(x => {
        const who = x.person || '';
        if (!byPerson.has(who)) byPerson.set(who, []);
        byPerson.get(who).push(x);
    });
    return [...byPerson.entries()].map(([who, list]) => {
        const badges = list.map(x => x.category === '기부금'
            ? `<span class="item-badge money">💰 ${fmt(x.income)}</span>`
            : `<span class="item-badge">${esc(x.supply_name || '물품')} ${fmtQty(x.quantity)}${x.income ? ` · ${fmt(x.income)}` : ''}</span>`).join('');
        const memos = list.map(x => x.memo).filter(Boolean);
        return `<span class="don-group">${who ? `<span class="person-tag">기부자 ${esc(who)}</span>` : ''}${badges}${memos.length ? `<span class="c-muted"> ${esc(memos.join(', '))}</span>` : ''}</span>`;
    }).join('');
}

// 엑셀처럼 머리글 위 합계줄 (수입합 · 지출합 · 총금액)
function sumRowCells(list, isAdmin) {
    const s = sumOf(list);
    const searched = $id('categoryFilter').value || $id('ledgerSearch').value.trim();
    const label = `${period === 'all' ? '' : `${periodLabel()} `}${searched ? '조회 합계' : '합계'}`;
    const netLabel = (period === 'all' && !searched) ? '총금액' : '수입 − 지출';
    return `
        <td colspan="4" class="sum-label">${label}</td>
        <td class="c-money" data-label="수입 합계">${fmt(s.income)}</td>
        <td class="c-expense" data-label="지출 합계">${fmt(s.expense)}</td>
        <td class="sum-net mc-full">${netLabel} <b>${fmt(s.net)}</b></td>
        ${isAdmin ? '<td class="mc-hide"></td>' : ''}`;
}

function moneyCells(r) {
    const incomeCls = r.counted ? 'c-money' : 'c-dim info-amount';
    return `
        <td class="${incomeCls} ${r.income ? '' : 'mc-hide'}" data-label="${r.counted ? '수입' : '참고 (총금액 제외)'}">${r.income ? fmt(r.income) : ''}</td>
        <td class="c-expense ${r.expense ? '' : 'mc-hide'}" data-label="지출">${r.expense ? fmt(r.expense) : ''}</td>`;
}

function viewRowHtml(r, isAdmin, seq, extraClass = '') {
    const cat1Html = r.auto ? `${esc(r.cat1)} ${AUTO_MARK}` : esc(r.cat1);
    let action = '';
    if (isAdmin) {
        action = r.auto
            ? `<td class="mc-full"><div class="row-actions"><button type="button" class="btn-row-edit" onclick="startInlineEdit('${r.key}')">수정</button></div></td>`
            : `<td class="mc-full">
                   <div class="row-actions">
                       <button type="button" class="btn-row-edit" onclick="startInlineEdit('${r.key}')">수정</button>
                       <button type="button" class="btn-row-del" onclick="deleteLedger(${r.id})">삭제</button>
                   </div>
               </td>`;
    }
    return `
        <tr class="${r.auto ? 'auto-row' : ''} ${r.counted ? '' : 'ref-row'} ${extraClass}">
            <td class="c-dim mc-hide">${seq}</td>
            <td class="c-soft mc-meta">${dotDate(r.date)}</td>
            <td class="cat-cell mc-title">${cat1Html}</td>
            <td class="cat2-cell ${r.cat2 ? '' : 'mc-hide'}" data-label="항목2">${esc(r.cat2)}</td>
            ${moneyCells(r)}
            <td class="memo-cell mc-full">${memoHtml(r)}</td>
            ${action}
        </tr>`;
}

function donationRowHtml(g, isAdmin, seq) {
    const open = expandedDonation === g.date;
    const action = isAdmin
        ? `<td class="mc-full"><div class="row-actions"><button type="button" class="btn-row-edit" onclick="toggleDonation('${g.date}')">${open ? '접기' : '수정'}</button></div></td>`
        : '';
    return `
        <tr class="donation-row ${open ? 'is-open' : ''}">
            <td class="c-dim mc-hide">${seq}</td>
            <td class="c-soft mc-meta">${dotDate(g.date)}</td>
            <td class="cat-cell mc-title">기부 <small class="c-muted">${g.items.length}건</small></td>
            <td class="cat2-cell" data-label="항목2">${esc(g.cat2)}</td>
            ${moneyCells(g)}
            <td class="memo-cell mc-full">${donationMemoHtml(g)}</td>
            ${action}
        </tr>`;
}

function toggleDonation(date) {
    expandedDonation = expandedDonation === date ? null : date;
    if (editingKey && !expandedDonation) { editingKey = null; editDraft = null; }
    renderLedger();
}

function renderLedger() {
    const list = filteredRows();
    const isAdmin = ClanApp.isAdminModeOn;
    $id('ledgerSumRow').innerHTML = sumRowCells(list, isAdmin);
    const tbody = $id('ledgerBody');
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 8 : 7}" class="empty-party-msg">해당 조건의 기록이 없습니다.</td></tr>`;
        return;
    }
    const display = displayRows(list);
    display.forEach((r, i) => { r.seq = i + 1; });
    const shown = newestFirst ? [...display].reverse() : display;

    const rowHtml = (r, seq, cls = '') => (isAdmin && r.key === editingKey)
        ? (r.auto ? autoEditRowHtml(r, seq) : editRowHtml(r, seq, cls))
        : viewRowHtml(r, isAdmin, seq, cls);

    tbody.innerHTML = shown.map(r => {
        if (!r.merged) return rowHtml(r, r.seq);
        let html = donationRowHtml(r, isAdmin, r.seq);
        if (isAdmin && expandedDonation === r.date) html += r.items.map(x => rowHtml(x, '└', 'sub-row')).join('');
        return html;
    }).join('');
}

// ---------------------------------------------------------
// 항목1 / 항목2 공통 (입력 팝업 · 행 안 수정)
// ---------------------------------------------------------
// 항목1에 맞는 항목2 선택지
function cat2OptionsHtml(cat1, cat2) {
    const c1 = cat1Info(cat1);
    if (c1 && c1.sub === 'supply') {
        return supplyOptions(cat2, (fin.supplies || []).length ? '' : '비품을 먼저 등록')
            + `<option value="${NEW_SUPPLY}">+ 새 비품 직접 입력…</option>`;
    }
    if (c1 && c1.sub === 'basis') {
        return Object.entries(BASIS_LABEL).map(([v, l]) => `<option value="${v}" ${v === cat2 ? 'selected' : ''}>${l}</option>`).join('');
    }
    if (c1 && c1.sub === 'list') {
        return (cat2 ? '' : `<option value="" selected>-</option>`)
            + c1.subs.map(n => `<option value="${esc(n)}" ${n === cat2 ? 'selected' : ''}>${esc(n)}</option>`).join('');
    }
    if (c1 && !c1.free) return `<option value="">-</option>`;
    return supplyOptions(cat2, '-');   // 기타 · 예전 항목: 연결 비품 (선택)
}

function defaultCat2(cat1) {
    const c1 = cat1Info(cat1);
    if (!c1) return '';
    if (c1.sub === 'supply') return ((fin.supplies || [])[0] || {}).name || '';
    if (c1.sub === 'basis') return '명';
    if (c1.sub === 'list') return c1.subs[0];
    return '';
}

// 입력값 → 저장할 값 (항목 · 비품 · 수량 단위 · 이름)
function bodyFromDraft(d) {
    const c1 = cat1Info(d.cat1);
    let category = d.cat1;
    let supply = '';
    let qtyUnit = '';
    if (c1 && c1.sub === 'list') category = d.cat2 || d.cat1;
    else if (c1 && c1.sub === 'basis') qtyUnit = d.cat2 || '명';
    else if (!c1 || c1.sub === 'supply' || c1.free) supply = d.cat2 || '';
    const sub = SUB_INFO[category];
    if (sub && sub.item) supply = String(d.itemSupply || '').trim();
    if (supply) qtyUnit = (supplyByName(supply) || {}).unit || '개';
    return {
        entry_date: d.date,
        category,
        supply_name: supply,
        qty_unit: qtyUnit,
        unit_price: sub && sub.item ? 0 : Number(d.unit || 0),
        quantity: Number(d.qty || 0),
        person: sub && sub.person ? String(d.person || '').trim() : '',
        memo: String(d.memo || '').trim(),
        requester_role: ClanApp.role,
        requester_id: ClanApp.user.active_id
    };
}

// 항목에 따라 보이는 입력칸 / 라벨
function fieldPlan(cat1, cat2) {
    const c1 = cat1Info(cat1) || { free: true };
    const sub = c1.sub === 'list' ? SUB_INFO[cat2] : null;
    const priced = c1.sub === 'supply' || c1.sub === 'basis' || Boolean(c1.free);
    const plan = {
        kindFixed: sub ? sub.kind : c1.kind,
        free: Boolean(c1.free),
        item: sub && sub.item ? sub.item : '',
        person: sub && sub.person ? sub.person : '',
        unit: priced,
        qty: priced,
        amount: true,   // 기부(물품 포함) = 수입 · 이벤트(물품 포함) = 지출
        unitLabel: '개당 가격',
        qtyLabel: '수량'
    };
    if (c1.sub === 'basis') {
        plan.unitLabel = cat2 === '회' ? '1회 다이 금액' : '인당 금액';
        plan.qtyLabel = cat2 === '회' ? '다이 횟수 (회)' : '인원 (명)';
    }
    return plan;
}

// ---------------------------------------------------------
// 행 안에서 수정
// ---------------------------------------------------------
function draftFromRow(r) {
    const c1 = cat1Info(r.cat1);
    let cat2 = r.supply_name;
    if (c1 && c1.sub === 'basis') cat2 = r.qty_unit === '회' ? '회' : '명';
    else if (c1 && c1.sub === 'list') cat2 = SUB_INFO[r.category] ? r.category : '';
    else if (c1 && !c1.sub && !c1.free) cat2 = '';
    return {
        date: r.date, cat1: r.cat1, cat2,
        itemSupply: (SUB_INFO[r.category] || {}).item ? r.supply_name : '',
        income: r.income || '', expense: r.expense || '',
        unit: r.unit_price || '', qty: r.quantity || '', memo: r.memo, person: r.person || ''
    };
}

function readEditDraft() {
    const v = (id) => ($id(id) ? $id(id).value : '');
    editDraft = {
        date: v('eDate'), cat1: v('eCat1'), cat2: v('eCat2'), itemSupply: v('eItemSupply'),
        income: v('eIncome'), expense: v('eExpense'), unit: v('eUnit'), qty: v('eQty'), memo: v('eMemo'), person: v('ePerson')
    };
    return editDraft;
}

const editActions = (saveFn) => `
    <td class="mc-full">
        <div class="row-actions">
            <button type="button" class="btn-sm btn-sm-green btn-xs" onclick="${saveFn}()">저장</button>
            <button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="cancelInlineEdit()">취소</button>
        </div>
    </td>`;

// 자동 줄: 금액은 템보유현황 · 분배관리에서 오므로 비고 첨언만 수정
function autoEditRowHtml(r, seq) {
    return `
        <tr class="is-editing auto-row">
            <td class="c-dim mc-hide">${seq}</td>
            <td class="c-soft mc-meta">${dotDate(r.date)}</td>
            <td class="cat-cell mc-title">${esc(r.cat1)} ${AUTO_MARK}</td>
            <td class="cat2-cell ${r.cat2 ? '' : 'mc-hide'}" data-label="항목2">${esc(r.cat2)}</td>
            ${moneyCells(r)}
            <td class="memo-cell mc-full">
                <div class="auto-edit-tags">${(r.autoTags || []).map(t => `<span class="auto-tag">${esc(t)}</span>`).join(' ')}</div>
                <input type="text" id="eNote" class="tbl-input edit-memo" value="${esc(r.note || '')}" placeholder="비고 첨언 (예: 디코 공지 완료)"
                       onkeydown="if(event.key==='Enter'){event.preventDefault();saveAutoNote();}">
            </td>
            ${editActions('saveAutoNote')}
        </tr>`;
}

function editRowHtml(r, seq, cls = '') {
    const d = editDraft || draftFromRow(r);
    const plan = fieldPlan(d.cat1, d.cat2);
    const names = CAT1.map(c => c.name);
    const cat1Options = (names.includes(d.cat1) ? '' : `<option value="${esc(d.cat1)}" selected>${esc(d.cat1)}</option>`)
        + names.map(n => `<option value="${esc(n)}" ${n === d.cat1 ? 'selected' : ''}>${esc(n)}</option>`).join('');
    const itemInput = plan.item
        ? `<input type="text" id="eItemSupply" class="tbl-input edit-cat" list="supplyDatalist" value="${esc(d.itemSupply)}" placeholder="물품">` : '';
    const personInput = plan.person
        ? `<input type="text" id="ePerson" class="tbl-input edit-person" value="${esc(d.person)}" placeholder="${plan.person}">` : '';
    const showQty = plan.qty || Boolean(plan.item);
    return `
        <tr class="is-editing ${cls}">
            <td class="c-dim mc-hide">${seq}</td>
            <td data-label="날짜"><input type="date" id="eDate" class="tbl-input edit-date" value="${d.date}"></td>
            <td data-label="항목1"><select id="eCat1" class="tbl-select edit-cat" onchange="onEditCat1Change()">${cat1Options}</select></td>
            <td data-label="항목2">
                <div class="edit-cat2-stack">
                    <select id="eCat2" class="tbl-select edit-cat" onchange="onEditCat2Change()">${cat2OptionsHtml(d.cat1, d.cat2)}</select>
                    ${itemInput}
                </div>
            </td>
            <td data-label="수입"><input type="number" id="eIncome" class="tbl-input edit-money" min="0" value="${d.income}" placeholder="0" ${plan.amount ? '' : 'disabled'}></td>
            <td data-label="지출"><input type="number" id="eExpense" class="tbl-input edit-money" min="0" value="${d.expense}" placeholder="0" ${plan.amount ? '' : 'disabled'}></td>
            <td class="memo-cell mc-full">
                <div class="edit-memo-line">
                    ${personInput}
                    <input type="text" id="eMemo" class="tbl-input edit-memo" value="${esc(d.memo)}" placeholder="비고"
                           onkeydown="if(event.key==='Enter'){event.preventDefault();saveInlineEdit();}">
                </div>
                <div class="edit-qty-line ${showQty ? '' : 'hidden'}">
                    <input type="number" id="eUnit" class="tbl-input edit-small ${plan.unit ? '' : 'hidden'}" min="0" value="${d.unit}" placeholder="${plan.unitLabel}" title="${plan.unitLabel}" oninput="calcInlineAmount()">
                    <span class="${plan.unit ? '' : 'hidden'}">×</span>
                    <input type="number" id="eQty" class="tbl-input edit-small" min="0" value="${d.qty}" placeholder="${plan.qtyLabel}" title="${plan.qtyLabel}" oninput="calcInlineAmount()">
                </div>
            </td>
            ${editActions('saveInlineEdit')}
        </tr>`;
}

function startInlineEdit(key) {
    if (!ClanApp.isAdminModeOn) return;
    editingKey = key;
    editDraft = null;
    renderLedger();
    const el = $id('eMemo') || $id('eNote');
    if (el) {
        el.closest('tr').scrollIntoView({ block: 'nearest' });
        if (el.id === 'eNote') el.focus();
    }
}

function cancelInlineEdit() {
    editingKey = null;
    editDraft = null;
    renderLedger();
}

// 정해진 구분(수입/지출)이 있는 항목이면 금액을 그 칸으로 옮김
function moveAmountToKind(d) {
    const kind = fieldPlan(d.cat1, d.cat2).kindFixed;
    if (!kind) return;
    const amount = Number(d.income || 0) || Number(d.expense || 0);
    d.income = kind === 'income' && amount ? amount : '';
    d.expense = kind === 'expense' && amount ? amount : '';
}

function onEditCat1Change() {
    const d = readEditDraft();
    d.cat2 = defaultCat2(d.cat1);
    moveAmountToKind(d);
    renderLedger();
}

function onEditCat2Change() {
    if ($id('eCat2').value === NEW_SUPPLY) {
        pickNewSupply($id('eCat2')).then(() => { readEditDraft(); renderLedger(); });
        return;
    }
    moveAmountToKind(readEditDraft());
    renderLedger();
}

// 단가 × 수량 → 항목 구분(수입/지출) 칸에 금액 자동 입력
function calcInlineAmount() {
    const unit = Number($id('eUnit').value || 0);
    const qty = Number($id('eQty').value || 0);
    if (!unit || !qty || $id('eIncome').disabled || $id('eUnit').classList.contains('hidden')) return;
    const kind = fieldPlan($id('eCat1').value, $id('eCat2').value).kindFixed;
    const toIncome = kind ? kind === 'income' : Number($id('eIncome').value) > 0;
    $id(toIncome ? 'eIncome' : 'eExpense').value = Math.round(unit * qty);
    $id(toIncome ? 'eExpense' : 'eIncome').value = '';
}

async function saveInlineEdit() {
    const row = rows.find(r => r.key === editingKey);
    if (!ClanApp.isAdminModeOn || !row || row.auto) return;
    const d = readEditDraft();
    const plan = fieldPlan(d.cat1, d.cat2);
    const income = plan.amount ? Number(d.income || 0) : 0;
    const expense = plan.amount ? Number(d.expense || 0) : 0;
    if (income && expense) return alert('수입과 지출 중 한 칸만 입력해 주세요.');
    const body = { ...bodyFromDraft(d), kind: income ? 'income' : (expense ? 'expense' : 'none'), amount: income || expense };
    if (!body.entry_date || !body.category) return alert('날짜와 항목을 입력해 주세요.');
    if (plan.item && (!body.supply_name || !body.quantity)) return alert('물품과 수량을 입력해 주세요.');
    if (await ClanApp.send(`/api/finance/ledger/${row.id}`, { method: 'PUT', body, failMsg: '수정 실패' })) {
        editingKey = null;
        editDraft = null;
        await reloadAll();
    }
}

async function saveAutoNote() {
    const row = rows.find(r => r.key === editingKey);
    if (!ClanApp.isAdminModeOn || !row || !row.auto) return;
    const ok = await ClanApp.send('/api/finance/auto-note', {
        body: { key: row.key, memo: $id('eNote').value.trim(), requester_role: ClanApp.role },
        failMsg: '비고 저장 실패'
    });
    if (ok) {
        editingKey = null;
        await reloadAll();
    }
}

async function deleteLedger(id) {
    const l = (fin.ledger || []).find(x => x.id === id);
    if (!l) return;
    const what = l.supply_name && Number(l.quantity) && !Number(l.income || l.expense)
        ? `${l.supply_name} ${fmtQty(l.quantity)}` : fmt(l.income || l.expense);
    if (!confirm(`${dotDate(l.entry_date)} [${l.category}] ${what} 기록을 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/finance/ledger/${id}?${ClanApp.roleParam('requester_role')}`)) {
        if (editingKey === `m_${id}`) { editingKey = null; editDraft = null; }
        await reloadAll();
    }
}

// ---------------------------------------------------------
// [입력] 팝업
// ---------------------------------------------------------
function fillSelects() {
    const used = [...new Set(CAT1.map(c => c.name).concat(AUTO_CATS, rows.map(r => r.cat1)))];
    const prevFilter = $id('categoryFilter').value;
    $id('categoryFilter').innerHTML = `<option value="">전체 항목</option>` + used.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    $id('categoryFilter').value = used.includes(prevFilter) ? prevFilter : '';
    fillSupplyLists();
}

function fillSupplyLists() {
    $id('supplyDatalist').innerHTML = (fin.supplies || []).map(s => `<option value="${esc(s.name)}"></option>`).join('');
}

// 물품명은 비품 목록 이름으로 맞춤 (띄어쓰기 · 대소문자 무시), 없으면 입력한 그대로
function matchSupplyName(name) {
    const key = String(name || '').replace(/\s+/g, '').toLowerCase();
    if (!key) return '';
    const hit = (fin.supplies || []).find(s => s.name.replace(/\s+/g, '').toLowerCase() === key);
    return hit ? hit.name : String(name).trim();
}

// 비품 목록에 없는 물품은 비품으로 자동 등록
async function ensureSupplies(names) {
    const missing = [...new Set(names)].filter(n => n && !supplyByName(n));
    for (const name of missing) {
        await ClanApp.send('/api/finance/supplies', { body: { name, unit: '개', requester_role: ClanApp.role }, failMsg: `${name} 비품 등록 실패` });
    }
    return missing;
}

// 배지 목록 (✕ 로 빼기)
function pendingBadgesHtml(list, removeFn, labelFn) {
    return list.map((x, i) => `<span class="item-badge pending">${labelFn(x)}
        <button type="button" class="chip-x" title="빼기" onclick="${removeFn}(${i})">✕</button></span>`).join('')
        || '<span class="c-faint fi-empty">물품명 · 수량을 넣고 [추가]를 누르면 여기에 쌓입니다</span>';
}

// 기부물품 / 이벤트물품: 물품명 · 수량 · 기부자(당첨자) 한 줄 → 배지
function addPendingItem() {
    const name = matchSupplyName($id('fiName').value);
    const qty = Number($id('fiQty').value || 0);
    if (!name || !(qty > 0)) return alert('물품명과 수량을 입력해 주세요.');
    pendingItems.push({ name, qty, amount: Number($id('fiAmount').value || 0), person: $id('fiPerson').value.trim() });
    $id('fiName').value = '';
    $id('fiQty').value = '';
    $id('fiAmount').value = '';
    renderPendingItems();
    $id('fiName').focus();
}

function removePendingItem(i) {
    pendingItems.splice(i, 1);
    renderPendingItems();
}

function renderPendingItems() {
    $id('fiPending').innerHTML = pendingBadgesHtml(pendingItems, 'removePendingItem',
        x => `${x.person ? `${esc(x.person)} · ` : ''}${esc(x.name)} ${fmtQty(x.qty)}${x.amount ? ` · ${fmt(x.amount)}` : ''}${supplyByName(x.name) ? '' : ' <small>(새 비품)</small>'}`);
}

function onFormCat1Change() {
    const cat1 = $id('fCat1').value;
    $id('fCat2').innerHTML = formMode === 'supply' && cat1 === '기부'
        ? `<option value="기부물품" selected>기부물품</option>`          // 비품관리 입력: 기부는 물품만
        : cat2OptionsHtml(cat1, defaultCat2(cat1));
    onFormCat2Change();
}

// 항목2 [+ 새 비품 직접 입력…] → 비품 등록 후 선택
async function pickNewSupply(selectEl) {
    const name = matchSupplyName(prompt('새 비품 이름을 입력해 주세요. (예: 미스릴화살)') || '');
    if (!name) { selectEl.value = ((fin.supplies || [])[0] || {}).name || ''; return; }
    if (!supplyByName(name)) {
        const unit = (prompt(`[${name}] 단위 (예: 개, 마리, 장)`, '개') || '개').trim() || '개';
        if (!await ClanApp.send('/api/finance/supplies', { body: { name, unit, requester_role: ClanApp.role }, failMsg: '비품 등록 실패' })) return;
        const data = await ClanApp.getJSON('/api/finance', null);
        if (data) fin = data;
        fillSupplyLists();
        renderSupplies();
    }
    selectEl.innerHTML = cat2OptionsHtml('비품구입', name);
    selectEl.value = name;
}

function onFormCat2Change() {
    if ($id('fCat2').value === NEW_SUPPLY) { pickNewSupply($id('fCat2')).then(onFormCat2Change); return; }
    const plan = fieldPlan($id('fCat1').value, $id('fCat2').value);
    $id('fCat2').disabled = $id('fCat2').options.length <= 1 && !$id('fCat2').value;
    $id('fItemBox').classList.toggle('hidden', !plan.item);
    $id('fPersonBox').classList.toggle('hidden', !plan.person || Boolean(plan.item));   // 물품은 줄마다 이름
    $id('fKindBox').classList.toggle('hidden', !plan.free);
    $id('fUnitBox').classList.toggle('hidden', !plan.unit);
    $id('fQtyBox').classList.toggle('hidden', !plan.qty);
    $id('fAmountBox').classList.toggle('hidden', !plan.amount || Boolean(plan.item));   // 물품은 줄마다 금액
    if (plan.item) {
        $id('fiPerson').placeholder = plan.person;
        $id('fItemHint').textContent = plan.item === 'in'
            ? '(비품 재고 + · 목록에 없는 물품은 비품으로 자동 등록)' : '(비품 재고 −)';
        renderPendingItems();
    }
    if (plan.person) $id('fPersonLabel').textContent = plan.person;
    if (plan.free) $id('fKind').value = 'expense';
    updateFormLabels();
}

function updateFormLabels() {
    const cat1 = $id('fCat1').value;
    const cat2 = $id('fCat2').value;
    const plan = fieldPlan(cat1, cat2);
    const c1 = cat1Info(cat1) || {};
    let qtyLabel = plan.qtyLabel;
    if (c1.sub === 'supply' && cat2) qtyLabel = `수량 (${(supplyByName(cat2) || {}).unit || '개'})`;
    $id('fUnitLabel').textContent = plan.unitLabel;
    $id('fQtyLabel').textContent = qtyLabel;
    $id('fUnitPrice').placeholder = c1.sub === 'basis' ? '예: 300000' : '예: 200';
    $id('fQty').placeholder = c1.sub === 'basis' ? (cat2 === '회' ? '예: 7' : '예: 5') : '예: 100';
    $id('fAmountHint').textContent = plan.unit ? `(${plan.unitLabel} × ${qtyLabel.replace(/ \(.*\)/, '')} 자동 계산)` : '';
}

function calcFormAmount() {
    const unit = Number($id('fUnitPrice').value || 0);
    const qty = Number($id('fQty').value || 0);
    if (unit && qty && !$id('fUnitBox').classList.contains('hidden')) $id('fAmount').value = Math.round(unit * qty);
}

// mode 'supply' = 비품관리에서 연 입력: 혈비 입력창과 같은 폼, 항목만 비품구입(혈비로 구입) · 기부물품
function openAddModal(mode = '') {
    if (!ClanApp.isAdminModeOn) return;
    formMode = mode;
    $id('ledgerModalTitle').textContent = mode === 'supply' ? '📥 비품 입력' : '✍️ 재정 기록 입력';
    $id('fCat1').innerHTML = mode === 'supply'
        ? `<option value="비품구입">혈비로 구입 (비품구입)</option><option value="기부">기부물품</option>`
        : CAT1.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
    $id('fDate').value = ClanApp.today();
    ['fUnitPrice', 'fQty', 'fAmount', 'fMemo', 'fPerson', 'fiName', 'fiQty', 'fiAmount', 'fiPerson'].forEach(id => { $id(id).value = ''; });
    pendingItems = [];
    $id('fCat1').value = CAT1[0].name;
    onFormCat1Change();
    ClanApp.modal.open('ledgerModal');
}

async function saveNewLedger() {
    if (!ClanApp.isAdminModeOn) return;
    const d = {
        date: $id('fDate').value, cat1: $id('fCat1').value, cat2: $id('fCat2').value,
        unit: $id('fUnitPrice').value, qty: $id('fQty').value, memo: $id('fMemo').value, person: $id('fPerson').value
    };
    const plan = fieldPlan(d.cat1, d.cat2);
    const kind = plan.kindFixed || (plan.free ? $id('fKind').value : 'none');
    if (!d.date || !d.cat1) return alert('날짜와 항목을 입력해 주세요.');

    // 물품: 배지마다 1건씩 저장 (같은 날짜 기부는 장부에서 1줄로 합쳐 보임)
    if (plan.item) {
        if ($id('fiName').value.trim() && $id('fiQty').value) addPendingItem();   // [추가] 안 누른 줄도 포함
        if (!pendingItems.length) return alert('물품명 · 수량을 넣고 [추가]를 눌러 주세요.');
        const sub = SUB_INFO[d.cat2] || {};
        if (sub.item === 'in') await ensureSupplies(pendingItems.map(x => x.name));
        for (const x of pendingItems) {
            const body = { ...bodyFromDraft({ ...d, itemSupply: x.name, qty: x.qty, person: x.person }), kind: sub.kind, amount: x.amount || 0 };
            if (!await ClanApp.send('/api/finance/ledger', { body, failMsg: `${x.name} 저장 실패` })) break;
        }
        pendingItems = [];
        ClanApp.modal.close('ledgerModal');
        await reloadAll();
        return;
    }

    const body = { ...bodyFromDraft(d), kind, amount: plan.amount ? Number($id('fAmount').value || 0) : 0 };
    if (cat1Info(d.cat1)?.sub === 'supply' && !body.supply_name) return alert('항목2에서 비품을 선택해 주세요. (비품관리에서 먼저 등록)');
    if (body.kind !== 'none' && !body.amount && !(body.unit_price && body.quantity)) return alert('금액(또는 단가 × 수량)을 입력해 주세요.');

    if (await ClanApp.send('/api/finance/ledger', { body, failMsg: '저장 실패' })) {
        ClanApp.modal.close('ledgerModal');
        await reloadAll();
    }
}

// ---------------------------------------------------------
// 📦 비품관리 팝업 (재고) + [관리] 입출 내역 팝업
// ---------------------------------------------------------
function openSupplyManager() {
    renderSupplies();
    ClanApp.modal.open('supplyMgrModal');
}

// 비품 1개의 입출 기록: 장부(구입 · 기부물품 · 이벤트물품) + 사용/입고/조정
function supplyEntries(name) {
    const list = [];
    (fin.ledger || []).forEach(l => {
        if (l.supply_name !== name || !(Number(l.quantity) > 0)) return;
        const sub = SUB_INFO[l.category] || {};
        const out = sub.item === 'out';
        let text = l.category;
        if (l.category === '비품구입' || (!sub.item && Number(l.unit_price) > 0)) text = `구입 ${fmt(l.unit_price)}원`;
        else if (sub.item === 'in') text = `기부${l.person ? ` · ${l.person}` : ''}`;
        else if (sub.item === 'out') text = `이벤트${l.person ? ` · ${l.person}` : ''}`;
        if (l.memo) text += ` · ${l.memo}`;
        list.push({
            date: l.entry_date, qin: out ? 0 : Number(l.quantity), qout: out ? Number(l.quantity) : 0,
            unit: out ? 0 : Number(l.unit_price || 0), text, moveId: null, ledgerId: l.id, raw: l, seq: l.id
        });
    });
    (fin.moves || []).forEach(m => {
        if (m.supply_name !== name) return;
        const qin = Number(m.qty_in || 0);
        list.push({ date: m.move_date, qin, qout: Number(m.qty_out || 0), unit: 0, text: m.memo || (qin ? '입고' : '사용'), moveId: m.id, ledgerId: null, raw: m, seq: 1e9 + m.id });
    });
    return list.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
}

// 하루에 입 · 출을 합쳐 1줄 (입 비고 / 출 비고 따로), 계는 그날 끝 재고
function supplyDays(name) {
    const days = new Map();
    let stock = 0;
    supplyEntries(name).forEach(e => {
        if (!days.has(e.date)) days.set(e.date, { date: e.date, qin: 0, qout: 0, inNotes: [], outNotes: [], entries: [], stock: 0 });
        const d = days.get(e.date);
        d.entries.push(e);
        d.qin += e.qin;
        d.qout += e.qout;
        if (e.qin) d.inNotes.push({ text: `${e.text} (${fmtQty(e.qin)})`, moveId: e.moveId });
        if (e.qout) d.outNotes.push({ text: `${e.text} (${fmtQty(e.qout)})`, moveId: e.moveId });
        stock += e.qin - e.qout;
        d.stock = stock;
    });
    return [...days.values()];
}

function supplyStats(name) {
    const list = supplyEntries(name);
    const qin = list.reduce((a, x) => a + x.qin, 0);
    const qout = list.reduce((a, x) => a + x.qout, 0);
    return { qin, qout, stock: qin - qout, lastBuy: [...list].reverse().find(x => x.unit > 0) };
}

function renderSupplies() {
    const supplies = fin.supplies || [];
    const tbody = $id('supplyBody');
    if (supplies.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="empty-party-msg">등록된 비품이 없습니다.</td></tr>`;
        return;
    }
    tbody.innerHTML = supplies.map(s => {
        const st = supplyStats(s.name);
        return `
            <tr>
                <td class="c-gold">${esc(s.name)}</td>
                <td class="c-money">${fmtQty(st.qin)}</td>
                <td class="c-expense">${fmtQty(st.qout)}</td>
                <td class="${st.stock < 0 ? 'c-expense' : 'c-white'}">${fmtQty(st.stock)} <small class="c-muted">${esc(s.unit || '개')}</small></td>
                <td>${st.lastBuy ? `${fmt(st.lastBuy.unit)}원` : '-'}</td>
                <td class="c-soft">${st.lastBuy ? dotDate(st.lastBuy.date) : '-'}</td>
                <td><button type="button" class="btn-sm btn-sm-blue btn-xs" onclick="openSupplyModal(${ClanApp.jsArg(s.name)})">관리</button></td>
            </tr>`;
    }).join('');
}

function openSupplyModal(name) {
    openSupply = name;
    editingSupplyDay = null;
    renderSupplyModal();
    ClanApp.modal.open('supplyModal');
}

function notesHtml(notes) {
    return notes.map(n => `<span class="hist-note">${esc(n.text)}</span>`).join('');
}

// 수정 중인 날짜: 그날 기록을 한 건씩 펼쳐 수량 · (구입이면 단가) · 비고 수정
function supplyEditRowsHtml(d) {
    return d.entries.map((e, i) => {
        const isIn = e.qin > 0;
        const qty = isIn ? e.qin : e.qout;
        const rawMemo = e.moveId ? (e.raw.memo || '') : (e.raw.memo || '');
        const label = e.moveId ? (isIn ? '입고' : '사용') : e.text.split(' · ')[0];
        const unitInput = !e.moveId && e.unit > 0
            ? `<input type="number" class="tbl-input edit-small" data-f="unit" min="0" value="${e.unit}" title="개당 가격"> 원 · ` : '';
        const qtyInput = `<input type="number" class="tbl-input edit-small" data-f="qty" min="0" value="${qty}">`;
        const memoInput = `${unitInput}<input type="text" class="tbl-input edit-memo hist-memo-input" data-f="memo" value="${esc(rawMemo)}" placeholder="비고">`;
        return `
            <tr class="is-editing hist-edit-row" data-i="${i}">
                <td class="c-faint">└ <small>${esc(label)}</small></td>
                <td>${isIn ? qtyInput : ''}</td>
                <td>${isIn ? '' : qtyInput}</td>
                <td class="memo-cell">${isIn ? memoInput : ''}</td>
                <td class="memo-cell">${isIn ? '' : memoInput}</td>
                <td><small class="c-muted">${e.moveId ? '' : '장부'}</small></td>
                <td><button type="button" class="btn-row-del" onclick="deleteSupplyEntry(${i})">삭제</button></td>
            </tr>`;
    }).join('');
}

function renderSupplyModal() {
    const supply = supplyByName(openSupply) || { unit: '개' };
    const st = supplyStats(openSupply);
    $id('supplyModalTitle').textContent = `📦 ${openSupply} 관리 · 입출 내역`;
    $id('supplyModalSummary').innerHTML = `
        <span>입 <b class="c-money">${fmtQty(st.qin)}</b></span>
        <span>출 <b class="c-expense">${fmtQty(st.qout)}</b></span>
        <span>계 (현재 재고) <b class="c-white">${fmtQty(st.stock)}</b> ${esc(supply.unit || '개')}</span>
        ${st.lastBuy ? `<span>최근 구입 <b>${fmt(st.lastBuy.unit)}원</b> (${dotDate(st.lastBuy.date)})</span>` : ''}`;

    const isAdmin = ClanApp.isAdminModeOn;
    const days = supplyDays(openSupply).reverse();
    $id('supplyHistoryBody').innerHTML = days.length ? days.map(d => {
        const editing = isAdmin && editingSupplyDay === d.date;
        const action = !isAdmin ? '' : `<td>${editing
            ? `<div class="row-actions"><button type="button" class="btn-sm btn-sm-green btn-xs" onclick="saveSupplyDay()">저장</button><button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="cancelSupplyDay()">취소</button></div>`
            : `<button type="button" class="btn-row-edit" onclick="editSupplyDay('${d.date}')">수정</button>`}</td>`;
        return `
            <tr class="${editing ? 'hist-editing' : ''}">
                <td class="c-soft">${dotDate(d.date)}</td>
                <td class="c-money">${d.qin ? fmtQty(d.qin) : ''}</td>
                <td class="c-expense">${d.qout ? fmtQty(d.qout) : ''}</td>
                <td class="memo-cell">${notesHtml(d.inNotes)}</td>
                <td class="memo-cell">${notesHtml(d.outNotes)}</td>
                <td class="c-white">${fmtQty(d.stock)}</td>
                ${action}
            </tr>
            ${editing ? supplyEditRowsHtml(d) : ''}`;
    }).join('') : `<tr><td colspan="${isAdmin ? 7 : 6}" class="empty-party-msg">내역이 없습니다.</td></tr>`;
}

function editSupplyDay(date) {
    editingSupplyDay = date;
    renderSupplyModal();
}

function cancelSupplyDay() {
    editingSupplyDay = null;
    renderSupplyModal();
}

const editingDayEntries = () => ((supplyDays(openSupply).find(d => d.date === editingSupplyDay) || {}).entries || []);

// 바뀐 기록만 저장: 사용/입고 → 비품 기록, 구입 · 기부 · 이벤트 → 혈비 장부 (구입은 금액 = 단가 × 수량)
async function saveSupplyDay() {
    if (!ClanApp.isAdminModeOn || !editingSupplyDay) return;
    const entries = editingDayEntries();
    const jobs = [];
    document.querySelectorAll('#supplyHistoryBody tr.hist-edit-row').forEach(tr => {
        const e = entries[Number(tr.dataset.i)];
        if (!e) return;
        const val = (f) => { const el = tr.querySelector(`[data-f="${f}"]`); return el ? el.value : null; };
        const qty = Number(val('qty') || 0);
        const memo = (val('memo') || '').trim();
        const unit = val('unit') === null ? e.unit : Number(val('unit') || 0);
        const isIn = e.qin > 0;
        if (!(qty > 0)) return jobs.push(Promise.reject(new Error('수량은 0보다 커야 합니다. (지우려면 [삭제])')));

        if (e.moveId) {
            if (qty === (isIn ? e.qin : e.qout) && memo === (e.raw.memo || '')) return;
            jobs.push(ClanApp.send(`/api/finance/moves/${e.moveId}`, {
                method: 'PUT', failMsg: '비품 기록 수정 실패',
                body: { supply_name: openSupply, move_date: e.date, qty_in: isIn ? qty : 0, qty_out: isIn ? 0 : qty, memo, requester_role: ClanApp.role, requester_id: ClanApp.user.active_id }
            }));
            return;
        }
        const l = e.raw;
        if (qty === Number(l.quantity) && memo === (l.memo || '') && unit === Number(l.unit_price || 0)) return;
        const income = Number(l.income || 0);
        const expense = Number(l.expense || 0);
        const kind = income ? 'income' : (expense ? 'expense' : ((SUB_INFO[l.category] || {}).kind || 'none'));
        const amount = unit > 0 ? Math.round(unit * qty) : (income || expense);
        jobs.push(ClanApp.send(`/api/finance/ledger/${l.id}`, {
            method: 'PUT', failMsg: '장부 수정 실패',
            body: {
                entry_date: l.entry_date, category: l.category, kind, amount,
                unit_price: unit, quantity: qty, supply_name: l.supply_name, qty_unit: l.qty_unit || '', person: l.person || '',
                memo, requester_role: ClanApp.role, requester_id: ClanApp.user.active_id
            }
        }));
    });
    try {
        await Promise.all(jobs);
    } catch (err) {
        return alert(err.message);
    }
    editingSupplyDay = null;
    await reloadAll();
}

async function deleteSupplyEntry(i) {
    const e = editingDayEntries()[i];
    if (!e) return;
    if (e.moveId) return deleteMove(e.moveId);
    if (!confirm(`이 기록은 혈비 관리내역의 [${e.raw.category}] 기록입니다.\n장부에서도 함께 삭제됩니다. 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/finance/ledger/${e.ledgerId}?${ClanApp.roleParam('requester_role')}`)) await reloadAll();
}

async function deleteMove(id) {
    if (!confirm('이 비품 입출 기록을 삭제하시겠습니까?')) return;
    if (await ClanApp.del(`/api/finance/moves/${id}?${ClanApp.roleParam('requester_role')}`)) await reloadAll();
}

// 📤 지출 / 📥 입력: 물품명 · 수량 · 비고 한 줄 → 배지 → [저장]
function openStockModal(dir) {
    if (!ClanApp.isAdminModeOn) return;
    stockDir = dir;
    stockPending = [];
    $id('stockModalTitle').textContent = dir === 'in' ? '📥 비품 입력 (입)' : '📤 비품 지출 (출)';
    $id('sHint').textContent = dir === 'in' ? '(목록에 없는 물품은 비품으로 자동 등록)' : '(비품 목록에 있는 물품만)';
    $id('stockSaveBtn').className = `btn-sm ${dir === 'in' ? 'btn-sm-blue' : 'btn-sm-red'} btn-lg`;
    $id('sDate').value = ClanApp.today();
    ['sName', 'sQty', 'sMemo'].forEach(id => { $id(id).value = ''; });
    renderStockPending();
    ClanApp.modal.open('stockModal');
    setTimeout(() => $id('sName').focus(), 40);
}

function addStockPending() {
    const name = matchSupplyName($id('sName').value);
    const qty = Number($id('sQty').value || 0);
    if (!name || !(qty > 0)) return alert('물품명과 수량을 입력해 주세요.');
    if (stockDir === 'out' && !supplyByName(name)) return alert(`[${name}] 은(는) 비품 목록에 없습니다.`);
    stockPending.push({ name, qty, memo: $id('sMemo').value.trim() });
    ['sName', 'sQty', 'sMemo'].forEach(id => { $id(id).value = ''; });
    renderStockPending();
    $id('sName').focus();
}

function removeStockPending(i) {
    stockPending.splice(i, 1);
    renderStockPending();
}

function renderStockPending() {
    $id('sPending').innerHTML = pendingBadgesHtml(stockPending, 'removeStockPending',
        x => `${esc(x.name)} ${stockDir === 'out' ? '−' : '+'}${fmtQty(x.qty)}${x.memo ? ` · ${esc(x.memo)}` : ''}${supplyByName(x.name) ? '' : ' <small>(새 비품)</small>'}`);
}

async function saveStock() {
    if (!ClanApp.isAdminModeOn) return;
    if ($id('sName').value.trim() && $id('sQty').value) addStockPending();
    if (!stockPending.length) return alert('물품명 · 수량을 넣고 [추가]를 눌러 주세요.');
    const date = $id('sDate').value;
    if (!date) return alert('날짜를 선택해 주세요.');
    if (stockDir === 'in') await ensureSupplies(stockPending.map(x => x.name));
    for (const x of stockPending) {
        const body = {
            supply_name: x.name, move_date: date,
            qty_in: stockDir === 'in' ? x.qty : 0, qty_out: stockDir === 'out' ? x.qty : 0,
            memo: x.memo, requester_role: ClanApp.role, requester_id: ClanApp.user.active_id
        };
        if (!await ClanApp.send('/api/finance/moves', { body, failMsg: `${x.name} 기록 실패` })) break;
    }
    stockPending = [];
    ClanApp.modal.close('stockModal');
    await reloadAll();
}

async function deleteOpenSupply() {
    const s = supplyByName(openSupply);
    if (!s || !confirm(`[${s.name}] 비품을 목록에서 삭제하시겠습니까?\n(장부 · 입출 기록은 그대로 남습니다)`)) return;
    if (await ClanApp.del(`/api/finance/supplies/${s.id}?${ClanApp.roleParam('requester_role')}`)) {
        ClanApp.modal.close('supplyModal');
        openSupply = '';
        await reloadAll();
    }
}
