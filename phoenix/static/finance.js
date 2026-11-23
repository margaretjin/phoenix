// =========================================================
// [finance.js] 혈비 재정 관리
//  - 장부는 엑셀(구글 시트)과 같은 형식: 연번 · 날짜 · 항목 · 수입 · 지출 · 비고 + 합계줄(총금액)
//  - [+ 추가] → 팝업으로 새 기록 / [수정] → 그 행 안에서 바로 수정
//  - 수동 장부(서버 저장) + 분배 기록에서 계산한 자동 줄을 합쳐 날짜순 정렬
//  - 비품 재고 = 장부 구입수량 + 입고 - 사용, [내역]은 팝업
// =========================================================
const KIND_LABEL = { income: '수입', expense: '지출', none: '기록만' };
let fin = { ledger: [], categories: [], supplies: [], moves: [], auto_start: '' };
let allRaids = [];
let rows = [];               // 화면용 장부 (수동 + 자동, 날짜순)
let editingId = null;        // 행 안에서 수정 중인 장부 id
let newestFirst = false;     // 엑셀처럼 오래된순 기본
let openSupply = '';         // 팝업에 열린 비품

window.onload = async () => {
    const user = ClanApp.initPage('/finance', () => {
        editingId = null;
        renderAll();
    });
    if (!user) return;

    $id('periodMonth').value = ClanApp.today().slice(0, 7);
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

async function reloadAll() {
    const [data, raids] = await Promise.all([ClanApp.getJSON('/api/finance', null), ClanApp.fetchRaids()]);
    if (!data) {
        $id('ledgerBody').innerHTML = `<tr><td colspan="7" class="empty-party-msg">재정 데이터를 불러오지 못했습니다. (Supabase 테이블 생성 여부 확인)</td></tr>`;
        return;
    }
    fin = data;
    allRaids = raids || [];
    $id('autoStartInput').value = fin.auto_start || '';
    $id('autoStartLabel').textContent = fin.auto_start ? `자동 기록: ${dotDate(fin.auto_start)}부터` : '';
    fillSelects();
    renderAll();
}

function renderAll() {
    buildRows();
    renderKpis();
    renderLedger();
    renderSupplies();
    renderCategories();
    if (openSupply) renderSupplyModal();
}

// ---------------------------------------------------------
// 자동 줄: 분배 기록 → 혈비 / 혈귀속 / 분배금지급 (날짜별로 묶음)
// ---------------------------------------------------------
function buildAutoRows() {
    const start = fin.auto_start || '0000-00-00';
    const groups = new Map();   // `${type}|${date}` -> { type, date, amount, details[] }
    const add = (type, date, amount, detail) => {
        if (!date || date < start || amount <= 0) return;
        const k = `${type}|${date}`;
        if (!groups.has(k)) groups.set(k, { type, date, amount: 0, details: [] });
        const g = groups.get(k);
        g.amount += amount;
        g.details.push(detail);
    };
    const alias = (n) => ClanApp.getItemAlias(n);

    ClanApp.buildDistEntries(allRaids).forEach(e => {
        if (e.is_castle_tax_included || !e.dist_date) return;   // 성세금포함 합산분은 성세금 쪽에서 계산
        const count = e.participants.length;

        // 1) 혈비: 아이템 분배가 모두 끝나면 혈분배일 기준으로 판매가 - 분배금
        if (e.is_done) {
            const kept = e.price - e.per_share * count;
            add('혈비', e.dist_date, kept, `${alias(e.name)} ${fmt(e.price)} → 혈비 ${fmt(kept)}`);
        }

        // 2) 참여자별 지급 / 혈귀속: 지급일 기준
        e.participants.forEach(p => {
            const info = ClanApp.getDistInfo(e.raid_ref, e.item_idx, e.dist_date, p.id);
            if (info.status !== '분배완료' || e.per_share <= 0) return;
            const paidDate = info.paid_date || e.dist_date;
            if (info.method === '혈귀속') add('혈귀속', paidDate, e.per_share, `${p.id} 분배금 (${alias(e.name)}) ${fmt(e.per_share)}`);
            else add('분배금지급', paidDate, e.per_share, `${p.id} ← ${alias(e.name)} ${fmt(e.per_share)}`);
        });
    });

    // 3) 분배금혈귀 아이템: 수령완료일 기준 판매가 전액
    allRaids.forEach(r => {
        ClanApp.extractItemDetails(r).forEach(it => {
            if (it.sale_type === '분배금혈귀' && it.winner && it.taken_date) {
                add('혈귀속', it.taken_date, Number(it.price || 0), `${alias(it.name)} 분배금혈귀 ${fmt(it.price)} (${it.winner})`);
            }
        });
    });

    return [...groups.values()].map(g => ({
        key: `auto_${g.type}_${g.date}`,
        id: null,
        auto: true,
        counted: g.type !== '분배금지급',
        date: g.date,
        category: g.type,
        income: g.type === '분배금지급' ? 0 : g.amount,
        expense: g.type === '분배금지급' ? g.amount : 0,
        memo: g.type === '분배금지급' ? `${g.details.length}건 지급 · 판매대금에서 지급 (총금액 제외)` : `${g.details.length}건`,
        details: g.details
    }));
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
        memo: l.memo || '',
        details: []
    }));

    rows = manual.concat(buildAutoRows()).sort((a, b) =>
        a.date.localeCompare(b.date) || (a.auto - b.auto) || ((a.id || 0) - (b.id || 0)) || a.category.localeCompare(b.category));
    rows.forEach((r, i) => { r.seq = i + 1; });
}

// ---------------------------------------------------------
// 요약 / 장부
// ---------------------------------------------------------
function sumOf(list) {
    const counted = list.filter(r => r.counted);
    const income = counted.reduce((a, r) => a + r.income, 0);
    const expense = counted.reduce((a, r) => a + r.expense, 0);
    return { income, expense, net: income - expense };
}

function periodRows() {
    const mode = $id('periodMode').value;
    const month = $id('periodMonth').value;
    const cat = $id('categoryFilter').value;
    const kw = $id('ledgerSearch').value.trim().toLowerCase();
    const showAuto = $id('showAuto').checked;

    return rows.filter(r => {
        if (mode === 'month' && month && !r.date.startsWith(month)) return false;
        if (cat && r.category !== cat) return false;
        if (!showAuto && r.auto) return false;
        if (kw && !`${r.category} ${r.memo} ${r.supply_name || ''} ${r.details.join(' ')}`.toLowerCase().includes(kw)) return false;
        return true;
    });
}

function renderKpis() {
    const total = sumOf(rows);
    $id('kpiIncome').textContent = fmt(total.income);
    $id('kpiExpense').textContent = fmt(total.expense);
    $id('kpiBalance').textContent = fmt(total.net);
}

function onPeriodChange() {
    $id('monthBox').classList.toggle('hidden', $id('periodMode').value !== 'month');
    renderLedger();
}

function toggleSort() {
    newestFirst = !newestFirst;
    $id('sortToggleBtn').textContent = newestFirst ? '최신순 ▼' : '오래된순 ▲';
    renderLedger();
}

function memoHtml(r) {
    const parts = [];
    if (r.unit_price && r.quantity) {
        parts.push(`<span class="qty-tag">${fmt(r.unit_price)} × ${fmtQty(r.quantity)}${r.supply_name ? ` ${esc(r.supply_name)}` : ''}</span>`);
    } else if (r.quantity && r.supply_name) {
        parts.push(`<span class="qty-tag">${esc(r.supply_name)} ${fmtQty(r.quantity)}</span>`);
    }
    if (r.memo) parts.push(esc(r.memo));
    let html = parts.join(' ');
    if (r.details.length) {
        html = `<details><summary>${html}</summary><ul class="auto-detail">${r.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul></details>`;
    }
    return html;
}

// 엑셀 2행처럼 표 맨 위에 합계줄 (수입합 · 지출합 · 총금액)
function sumRowHtml(list, isAdmin) {
    const s = sumOf(list);
    const filtered = $id('periodMode').value === 'month' || $id('categoryFilter').value || $id('ledgerSearch').value.trim() || !$id('showAuto').checked;
    return `
        <tr class="sum-row">
            <td colspan="3" class="sum-label">${filtered ? '조회 합계' : '합계'}</td>
            <td class="c-money" data-label="수입 합계">${fmt(s.income)}</td>
            <td class="c-expense" data-label="지출 합계">${fmt(s.expense)}</td>
            <td class="sum-net mc-full">${filtered ? '차액' : '총금액'} <b>${fmt(s.net)}</b></td>
            ${isAdmin ? '<td class="mc-hide"></td>' : ''}
        </tr>`;
}

function viewRowHtml(r, isAdmin) {
    const catHtml = r.auto
        ? `${esc(r.category)} ${ClanApp.badge('🔄 자동', r.counted ? 'sky' : 'gray', 'badge-sm')}`
        : esc(r.category);
    const action = !isAdmin ? '' : (r.auto
        ? `<td class="mc-hide"><span class="c-faint">-</span></td>`
        : `<td class="mc-full">
               <div class="row-actions">
                   <button type="button" class="btn-row-edit" onclick="startInlineEdit(${r.id})">수정</button>
                   <button type="button" class="btn-row-del" onclick="deleteLedger(${r.id})">삭제</button>
               </div>
           </td>`);
    return `
        <tr class="${r.auto ? 'auto-row' : ''}">
            <td class="c-dim mc-hide">${r.seq}</td>
            <td class="c-soft mc-meta">${dotDate(r.date)}</td>
            <td class="cat-cell mc-title">${catHtml}</td>
            <td class="c-money ${r.income ? '' : 'mc-hide'}" data-label="수입">${r.income ? fmt(r.income) : ''}</td>
            <td class="${r.counted ? 'c-expense' : 'c-dim info-amount'} ${r.expense ? '' : 'mc-hide'}" data-label="${r.counted ? '지출' : '지급(총금액 제외)'}">${r.expense ? fmt(r.expense) : ''}</td>
            <td class="memo-cell mc-full">${memoHtml(r)}</td>
            ${action}
        </tr>`;
}

// 행 안에서 수정: 날짜 · 항목 · 수입 · 지출 · 비고(+ 개당가격 × 수량 · 비품)
function editRowHtml(r) {
    const cats = fin.categories || [];
    const catOptions = (cats.some(c => c.name === r.category) ? '' : `<option value="${esc(r.category)}">${esc(r.category)}</option>`)
        + cats.map(c => `<option value="${esc(c.name)}" ${c.name === r.category ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
    const supplyOptions = `<option value="">비품 없음</option>` + (fin.supplies || []).map(s =>
        `<option value="${esc(s.name)}" ${s.name === r.supply_name ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    return `
        <tr class="is-editing">
            <td class="c-dim mc-hide">${r.seq}</td>
            <td data-label="날짜"><input type="date" id="eDate" class="tbl-input edit-date" value="${r.date}"></td>
            <td data-label="항목"><select id="eCategory" class="tbl-select edit-cat" onchange="onInlineCategoryChange()">${catOptions}</select></td>
            <td data-label="수입"><input type="number" id="eIncome" class="tbl-input edit-money" min="0" value="${r.income || ''}" placeholder="0"></td>
            <td data-label="지출"><input type="number" id="eExpense" class="tbl-input edit-money" min="0" value="${r.expense || ''}" placeholder="0"></td>
            <td class="memo-cell mc-full">
                <input type="text" id="eMemo" class="tbl-input edit-memo" value="${esc(r.memo)}" placeholder="비고"
                       onkeydown="if(event.key==='Enter'){event.preventDefault();saveInlineEdit();}">
                <div class="edit-qty-line">
                    <input type="number" id="eUnit" class="tbl-input edit-small" min="0" value="${r.unit_price || ''}" placeholder="개당" oninput="calcInlineAmount()">
                    <span>×</span>
                    <input type="number" id="eQty" class="tbl-input edit-small" min="0" value="${r.quantity || ''}" placeholder="수량" oninput="calcInlineAmount()">
                    <select id="eSupply" class="tbl-select edit-supply">${supplyOptions}</select>
                </div>
            </td>
            <td class="mc-full">
                <div class="row-actions">
                    <button type="button" class="btn-sm btn-sm-green btn-xs" onclick="saveInlineEdit()">저장</button>
                    <button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="cancelInlineEdit()">취소</button>
                </div>
            </td>
        </tr>`;
}

function renderLedger() {
    const list = periodRows();
    const shown = newestFirst ? [...list].reverse() : list;
    const p = sumOf(list);
    $id('kpiPeriodIncome').textContent = fmt(p.income);
    $id('kpiPeriodExpense').textContent = fmt(p.expense);
    $id('kpiPeriodLabel').textContent = $id('periodMode').value === 'month'
        ? `${$id('periodMonth').value || ''} 수입 / 지출` : '조회 기간 수입 / 지출';

    const isAdmin = ClanApp.isAdminModeOn;
    const tbody = $id('ledgerBody');
    if (shown.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${isAdmin ? 7 : 6}" class="empty-party-msg">해당 조건의 기록이 없습니다.</td></tr>`;
        return;
    }
    tbody.innerHTML = sumRowHtml(list, isAdmin) + shown.map(r =>
        (isAdmin && !r.auto && r.id === editingId) ? editRowHtml(r) : viewRowHtml(r, isAdmin)).join('');
}

// ---------------------------------------------------------
// 행 안에서 수정
// ---------------------------------------------------------
function categoryByName(name) {
    return (fin.categories || []).find(c => c.name === name) || null;
}

function startInlineEdit(id) {
    if (!ClanApp.isAdminModeOn) return;
    editingId = id;
    renderLedger();
    const el = $id('eMemo');
    if (el) el.closest('tr').scrollIntoView({ block: 'nearest' });
}

function cancelInlineEdit() {
    editingId = null;
    renderLedger();
}

function onInlineCategoryChange() {
    const c = categoryByName($id('eCategory').value);
    if (c && c.supply_name && !$id('eSupply').value) $id('eSupply').value = c.supply_name;
    calcInlineAmount();
}

// 개당가격 × 수량 → 항목 구분(수입/지출) 칸에 금액 자동 입력
function calcInlineAmount() {
    const unit = Number($id('eUnit').value || 0);
    const qty = Number($id('eQty').value || 0);
    if (!unit || !qty) return;
    const c = categoryByName($id('eCategory').value);
    const target = (c && c.kind === 'income') || (!c && Number($id('eIncome').value) > 0) ? 'eIncome' : 'eExpense';
    $id(target).value = Math.round(unit * qty);
    $id(target === 'eIncome' ? 'eExpense' : 'eIncome').value = '';
}

async function saveInlineEdit() {
    if (!ClanApp.isAdminModeOn || !editingId) return;
    const income = Number($id('eIncome').value || 0);
    const expense = Number($id('eExpense').value || 0);
    if (income && expense) return alert('수입과 지출 중 한 칸만 입력해 주세요.');
    const body = {
        entry_date: $id('eDate').value,
        category: $id('eCategory').value,
        kind: income ? 'income' : (expense ? 'expense' : 'none'),
        amount: income || expense,
        unit_price: Number($id('eUnit').value || 0),
        quantity: Number($id('eQty').value || 0),
        supply_name: $id('eSupply').value,
        memo: $id('eMemo').value.trim(),
        requester_role: ClanApp.role,
        requester_id: ClanApp.user.active_id
    };
    if (!body.entry_date || !body.category) return alert('날짜와 항목을 입력해 주세요.');
    if (await ClanApp.send(`/api/finance/ledger/${editingId}`, { method: 'PUT', body, failMsg: '수정 실패' })) {
        editingId = null;
        await reloadAll();
    }
}

async function deleteLedger(id) {
    const l = (fin.ledger || []).find(x => x.id === id);
    if (!l || !confirm(`${dotDate(l.entry_date)} [${l.category}] ${fmt(l.income || l.expense)} 기록을 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/finance/ledger/${id}?${ClanApp.roleParam('requester_role')}`)) {
        if (editingId === id) editingId = null;
        await reloadAll();
    }
}

// ---------------------------------------------------------
// [+ 추가] 팝업
// ---------------------------------------------------------
function fillSelects() {
    const cats = fin.categories || [];
    const autoCats = ['혈비', '혈귀속', '분배금지급'];
    const usedCats = [...new Set(cats.map(c => c.name).concat(autoCats, (fin.ledger || []).map(l => l.category)))];

    $id('fCategory').innerHTML = cats.map(c => `<option value="${esc(c.name)}">${esc(c.name)} (${KIND_LABEL[c.kind] || c.kind})</option>`).join('');
    const prevFilter = $id('categoryFilter').value;
    $id('categoryFilter').innerHTML = `<option value="">전체 항목</option>` + usedCats.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    $id('categoryFilter').value = usedCats.includes(prevFilter) ? prevFilter : '';

    const supplyOpts = (fin.supplies || []).map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    $id('fSupply').innerHTML = `<option value="">(비품 아님)</option>` + supplyOpts;
    $id('newCatSupply').innerHTML = `<option value="">연결 비품 없음</option>` + supplyOpts;
}

function onFormCategoryChange() {
    const c = categoryByName($id('fCategory').value);
    if (!c) return;
    $id('fKind').value = c.kind;
    $id('fSupply').value = c.supply_name || '';
}

function calcFormAmount() {
    const unit = Number($id('fUnitPrice').value || 0);
    const qty = Number($id('fQty').value || 0);
    if (unit && qty) $id('fAmount').value = Math.round(unit * qty);
}

function openAddModal(categoryName = '', title = '✍️ 재정 기록 추가') {
    if (!ClanApp.isAdminModeOn) return;
    $id('ledgerModalTitle').textContent = title;
    $id('fDate').value = ClanApp.today();
    ['fUnitPrice', 'fQty', 'fAmount', 'fMemo'].forEach(id => { $id(id).value = ''; });
    if ($id('fCategory').options.length) {
        if (categoryName && categoryByName(categoryName)) $id('fCategory').value = categoryName;
        else $id('fCategory').selectedIndex = 0;
        onFormCategoryChange();
    }
    ClanApp.modal.open('ledgerModal');
}

// 🛒 비품 구입: 비품이 연결된 지출 항목(예: 마돌구입)으로 추가 팝업 열기
function openSupplyBuy(supplyName = '') {
    const cats = fin.categories || [];
    const cat = cats.find(c => c.kind === 'expense' && supplyName && c.supply_name === supplyName)
        || cats.find(c => c.kind === 'expense' && c.supply_name);
    openAddModal(cat ? cat.name : '', '🛒 비품 구입 (혈비 지출 + 재고 증가)');
    if (supplyName) $id('fSupply').value = supplyName;
}

// 📤 비품 사용 / 📥 입고·재고조정: 비품을 골라 기록하는 팝업
function openSupplyMove(type = 'out', supplyName = '') {
    const first = (fin.supplies || [])[0];
    const name = supplyName || openSupply || (first ? first.name : '');
    if (!name) return alert('먼저 비품을 추가해 주세요.');
    openSupplyModal(name);
    $id('mType').value = type;
    onMoveTypeChange();
    setTimeout(() => $id('mQty').focus(), 40);
}

async function saveNewLedger() {
    if (!ClanApp.isAdminModeOn) return;
    const body = {
        entry_date: $id('fDate').value,
        category: $id('fCategory').value,
        kind: $id('fKind').value,
        amount: Number($id('fAmount').value || 0),
        unit_price: Number($id('fUnitPrice').value || 0),
        quantity: Number($id('fQty').value || 0),
        supply_name: $id('fSupply').value,
        memo: $id('fMemo').value.trim(),
        requester_role: ClanApp.role,
        requester_id: ClanApp.user.active_id
    };
    if (!body.entry_date || !body.category) return alert('날짜와 항목을 입력해 주세요.');
    if (body.kind !== 'none' && !body.amount && !(body.unit_price && body.quantity)) return alert('금액(또는 개당 가격 × 수량)을 입력해 주세요.');

    if (await ClanApp.send('/api/finance/ledger', { body, failMsg: '저장 실패' })) {
        ClanApp.modal.close('ledgerModal');
        await reloadAll();
    }
}

// ---------------------------------------------------------
// 비품 재고 + 내역 팝업
// ---------------------------------------------------------
// 비품 1개의 입출 내역 (장부 구입 + 입고/사용/조정), 날짜순 누계 포함
function supplyHistory(name) {
    const list = [];
    (fin.ledger || []).forEach(l => {
        if (l.supply_name === name && Number(l.quantity) > 0) {
            list.push({
                date: l.entry_date, qin: Number(l.quantity), qout: 0, unit: Number(l.unit_price || 0),
                memo: `${l.category}${l.unit_price ? ` · ${fmt(l.unit_price)}원` : ''}${l.memo ? ` · ${l.memo}` : ''}`, moveId: null, seq: l.id
            });
        }
    });
    (fin.moves || []).forEach(m => {
        if (m.supply_name === name) {
            list.push({ date: m.move_date, qin: Number(m.qty_in || 0), qout: Number(m.qty_out || 0), unit: 0, memo: m.memo || '', moveId: m.id, seq: 1e9 + m.id });
        }
    });
    list.sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
    let stock = 0;
    list.forEach(x => { stock += x.qin - x.qout; x.stock = stock; });
    return list;
}

function supplyStats(name) {
    const h = supplyHistory(name);
    const qin = h.reduce((a, x) => a + x.qin, 0);
    const qout = h.reduce((a, x) => a + x.qout, 0);
    return { h, qin, qout, stock: qin - qout, lastBuy: [...h].reverse().find(x => x.unit > 0) };
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
                <td>
                    <div class="row-actions">
                        ${ClanApp.isAdminModeOn ? `<button type="button" class="btn-sm btn-sm-red btn-xs" onclick="openSupplyMove('out', ${ClanApp.jsArg(s.name)})">사용</button>` : ''}
                        <button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="openSupplyModal(${ClanApp.jsArg(s.name)})">내역</button>
                        ${ClanApp.isAdminModeOn ? `<button type="button" class="btn-row-del" onclick="deleteSupply(${s.id}, ${ClanApp.jsArg(s.name)})">✕</button>` : ''}
                    </div>
                </td>
            </tr>`;
    }).join('');
}

function openSupplyModal(name) {
    openSupply = name;
    $id('mType').value = 'out';
    onMoveTypeChange();
    $id('mDate').value = ClanApp.today();
    $id('mQty').value = '';
    $id('mMemo').value = '';
    renderSupplyModal();
    ClanApp.modal.open('supplyModal');
}

function onMoveSupplyChange() {
    openSupply = $id('mSupply').value;
    renderSupplyModal();
}

function renderSupplyModal() {
    const supply = (fin.supplies || []).find(s => s.name === openSupply) || { unit: '개' };
    $id('mSupply').innerHTML = (fin.supplies || []).map(s =>
        `<option value="${esc(s.name)}" ${s.name === openSupply ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    const st = supplyStats(openSupply);
    $id('supplyModalTitle').textContent = `📦 ${openSupply} 입출 내역`;
    $id('supplyModalSummary').innerHTML = `
        <span>입 <b class="c-money">${fmtQty(st.qin)}</b></span>
        <span>출 <b class="c-expense">${fmtQty(st.qout)}</b></span>
        <span>계 (현재 재고) <b class="c-white">${fmtQty(st.stock)}</b> ${esc(supply.unit || '개')}</span>
        ${st.lastBuy ? `<span>최근 구입 <b>${fmt(st.lastBuy.unit)}원</b> (${dotDate(st.lastBuy.date)})</span>` : ''}`;

    const isAdmin = ClanApp.isAdminModeOn;
    $id('supplyHistoryBody').innerHTML = st.h.length ? [...st.h].reverse().map(x => `
        <tr>
            <td class="c-soft">${dotDate(x.date)}</td>
            <td class="c-money">${x.qin ? fmtQty(x.qin) : ''}</td>
            <td class="c-expense">${x.qout ? fmtQty(x.qout) : ''}</td>
            <td class="c-white">${fmtQty(x.stock)}</td>
            <td class="memo-cell">${esc(x.memo)}</td>
            ${isAdmin ? `<td>${x.moveId ? `<button type="button" class="btn-row-del" onclick="deleteMove(${x.moveId})">삭제</button>` : '<span class="c-faint">장부</span>'}</td>` : ''}
        </tr>`).join('') : `<tr><td colspan="${isAdmin ? 6 : 5}" class="empty-party-msg">내역이 없습니다.</td></tr>`;
}

function onMoveTypeChange() {
    $id('mQty').placeholder = $id('mType').value === 'adjust' ? '실제 재고 수량' : '수량';
}

async function saveMove() {
    if (!ClanApp.isAdminModeOn || !openSupply) return;
    const type = $id('mType').value;
    const qty = Number($id('mQty').value);
    let memo = $id('mMemo').value.trim();
    if (!$id('mDate').value || $id('mQty').value === '' || !(qty >= 0)) return alert('날짜와 수량을 입력해 주세요.');

    let qtyIn = 0;
    let qtyOut = 0;
    if (type === 'in') qtyIn = qty;
    else if (type === 'out') qtyOut = qty;
    else {
        const current = supplyStats(openSupply).stock;
        const diff = qty - current;
        if (diff === 0) return alert('현재 재고와 같습니다.');
        if (diff > 0) qtyIn = diff; else qtyOut = -diff;
        memo = `재고조정 (장부 ${fmtQty(current)} → 실제 ${fmtQty(qty)})${memo ? ` · ${memo}` : ''}`;
    }
    if (!qtyIn && !qtyOut) return alert('수량을 입력해 주세요.');

    const ok = await ClanApp.send('/api/finance/moves', {
        body: { supply_name: openSupply, move_date: $id('mDate').value, qty_in: qtyIn, qty_out: qtyOut, memo, requester_role: ClanApp.role, requester_id: ClanApp.user.active_id },
        failMsg: '비품 기록 실패'
    });
    if (ok) {
        $id('mQty').value = '';
        $id('mMemo').value = '';
        await reloadAll();
    }
}

async function deleteMove(id) {
    if (!confirm('이 비품 입출 기록을 삭제하시겠습니까?')) return;
    if (await ClanApp.del(`/api/finance/moves/${id}?${ClanApp.roleParam('requester_role')}`)) await reloadAll();
}

async function addSupply() {
    const name = $id('newSupplyName').value.trim();
    if (!name) return alert('비품명을 입력해 주세요.');
    const ok = await ClanApp.send('/api/finance/supplies', {
        body: { name, unit: $id('newSupplyUnit').value.trim() || '개', requester_role: ClanApp.role }, failMsg: '비품 추가 실패'
    });
    if (ok) {
        $id('newSupplyName').value = '';
        await reloadAll();
    }
}

async function deleteSupply(id, name) {
    if (!confirm(`[${name}] 비품을 목록에서 삭제하시겠습니까?\n(장부 기록은 그대로 남습니다)`)) return;
    if (await ClanApp.del(`/api/finance/supplies/${id}?${ClanApp.roleParam('requester_role')}`)) await reloadAll();
}

// ---------------------------------------------------------
// 항목 / 자동 기록 시작일
// ---------------------------------------------------------
function renderCategories() {
    const tone = { income: 'green', expense: 'rose', none: 'gray' };
    $id('categoryChips').innerHTML = (fin.categories || []).map(c => `
        <span class="badge badge-${tone[c.kind] || 'gray'} category-chip">
            ${esc(c.name)} · ${KIND_LABEL[c.kind] || c.kind}${c.supply_name ? ` → ${esc(c.supply_name)}` : ''}
            <button type="button" class="chip-x" title="삭제" onclick="deleteCategory(${c.id}, ${ClanApp.jsArg(c.name)})">✕</button>
        </span>`).join('') || '<span class="c-dim">항목이 없습니다.</span>';
}

async function addCategory() {
    const name = $id('newCatName').value.trim();
    if (!name) return alert('항목명을 입력해 주세요.');
    const ok = await ClanApp.send('/api/finance/categories', {
        body: { name, kind: $id('newCatKind').value, supply_name: $id('newCatSupply').value, requester_role: ClanApp.role },
        failMsg: '항목 추가 실패'
    });
    if (ok) {
        $id('newCatName').value = '';
        await reloadAll();
    }
}

async function deleteCategory(id, name) {
    if (!confirm(`[${name}] 항목을 목록에서 삭제하시겠습니까?\n(이미 기록된 장부는 그대로 남습니다)`)) return;
    if (await ClanApp.del(`/api/finance/categories/${id}?${ClanApp.roleParam('requester_role')}`)) await reloadAll();
}

async function saveAutoStart() {
    const date = $id('autoStartInput').value;
    if (!date) return alert('날짜를 선택해 주세요.');
    if (!confirm(`${dotDate(date)} 부터의 분배 기록을 장부에 자동 반영합니다.\n이 날짜 이전 내역을 직접 입력했다면 겹치지 않는지 확인해 주세요.`)) return;
    if (await ClanApp.send('/api/finance/auto-start', { body: { date, requester_role: ClanApp.role }, failMsg: '저장 실패' })) {
        await reloadAll();
    }
}