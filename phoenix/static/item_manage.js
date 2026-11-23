// =========================================================
// [item_manage.js] 아이템 내판가 · 혈비제외가 목록
// (일반회원 열람 / 관리자 모드에서 추가·수정·삭제)
// =========================================================
let editingId = null;

window.onload = async () => {
    const user = ClanApp.initPage('/item-manage', () => {
        editingId = null;
        renderItems();
    });
    if (!user) return;

    await ClanApp.loadMeta();
    applyTaxRateUI();
    renderItems();
};

const esc = (v) => ClanApp.escapeHtml(v);
const isAdminOn = () => ClanApp.hasAdminPrivilege && ClanApp.isAdminModeOn;
const kindOf = (it) => (it.event_item ? 'event' : (it.clan_owned ? 'clan' : 'normal'));

function applyTaxRateUI() {
    $id('clanTaxRateInput').value = ClanApp.taxRate;
    $id('taxRateLabelText').textContent = `혈비 ${ClanApp.taxRate}% 제외 기준`;
}

async function reloadItems() {
    ClanApp.setItemAliases(await ClanApp.getJSON('/api/items', []));
    renderItems();
}

async function saveGlobalTaxRate() {
    if (!isAdminOn()) return;
    const val = Number($id('clanTaxRateInput').value);
    if (isNaN(val) || val < 0 || val > 100) return alert('혈비율은 0~100% 사이로 입력해 주세요.');

    if (await ClanApp.send('/api/raids/tax-rate', { body: { tax_rate: val, requester_role: ClanApp.role }, failMsg: '혈비 저장 실패' })) {
        ClanApp.taxRate = val;
        applyTaxRateUI();
        renderItems();
        alert(`혈맹 혈비 공제율이 ${val}%로 저장되었습니다.`);
    }
}

function kindBadge(it) {
    if (it.event_item) return ClanApp.badge('이벤트템 (분배 0원)', 'purple');
    if (it.clan_owned) return ClanApp.badge('혈비귀속 (분배제외)', 'teal');
    return '<span class="c-faint">-</span>';
}

function renderItems() {
    const admin = isAdminOn();
    const items = ClanApp.items;
    const q = $id('itemSearch').value.trim().toLowerCase();
    const list = items.filter(it => !q || it.item_name.toLowerCase().includes(q) || (it.aliases || '').toLowerCase().includes(q));
    $id('itemCountBadge').textContent = `총 ${items.length}개`;

    const tbody = $id('itemTableBody');
    if (list.length === 0) {
        tbody.innerHTML = `<tr><td colspan="${admin ? 6 : 5}" class="empty-party-msg">${items.length === 0 ? '등록된 아이템이 없습니다.' : '검색 결과가 없습니다.'}</td></tr>`;
        return;
    }

    tbody.innerHTML = list.map(it => {
        const gross = Number(it.default_price || 0);
        const net = ClanApp.netOf(gross);

        if (admin && it.id === editingId) {
            const opt = (v, label) => `<option value="${v}" ${kindOf(it) === v ? 'selected' : ''}>${label}</option>`;
            return `
                <tr>
                    <td><input type="text" id="editName" class="input-common edit-inline-input" value="${esc(it.item_name)}" placeholder="아이템명 (풀네임)"></td>
                    <td><input type="text" id="editAliases" class="input-common edit-inline-input" value="${esc(it.aliases)}" placeholder="별칭(콤마 구분)"></td>
                    <td><input type="number" id="editPrice" class="input-common edit-inline-input" value="${gross}" min="0" oninput="updateLiveNetPreview(this.value)"></td>
                    <td id="editNetPreview" class="item-net-cell">${net.toLocaleString()}</td>
                    <td>
                        <select id="editKind" class="input-common edit-inline-input">
                            ${opt('normal', '일반')}${opt('clan', '혈비귀속')}${opt('event', '이벤트템')}
                        </select>
                    </td>
                    <td>
                        <div class="row-actions">
                            <button type="button" class="btn-sm btn-sm-green" onclick="saveEdit(${it.id})">저장</button>
                            <button type="button" class="btn-sm btn-sm-dark" onclick="startEdit(null)">취소</button>
                        </div>
                    </td>
                </tr>`;
        }

        // 첫 번째 별칭이 사이트 전체에서 아이템 표기로 공통 사용됨
        const aliasList = ClanApp.splitCsv(it.aliases);
        const aliasCellHtml = aliasList.length
            ? aliasList.map((a, i) => `<span class="${i === 0 ? 'c-gold' : 'c-muted'}">${esc(a)}</span>`).join(', ')
            : '<span class="c-faint">-</span>';

        return `
            <tr>
                <td class="item-name-cell">${esc(it.item_name)}</td>
                <td>${aliasCellHtml}</td>
                <td class="item-gross-cell">${gross.toLocaleString()}</td>
                <td class="item-net-cell">${net.toLocaleString()}</td>
                <td>${kindBadge(it)}</td>
                ${admin ? `<td>
                    <div class="row-actions">
                        <button type="button" class="btn-sm btn-sm-dark" onclick="startEdit(${it.id})">수정</button>
                        <button type="button" class="btn-sm btn-sm-red" onclick="deleteItem(${it.id})">삭제</button>
                    </div>
                </td>` : ''}
            </tr>`;
    }).join('');
}

function updateLiveNetPreview(val) {
    const el = $id('editNetPreview');
    if (el) el.textContent = ClanApp.netOf(val).toLocaleString();
}

function itemPayload(name, aliases, price, kind) {
    return {
        item_name: name,
        aliases,
        default_price: Number(price || 0),
        clan_owned: kind === 'clan',
        event_item: kind === 'event',
        requester_role: ClanApp.role
    };
}

async function addItem() {
    if (!isAdminOn()) return;
    const nameEl = $id('newItemName');
    const aliasEl = $id('newItemAliases');
    const priceEl = $id('newItemPrice');
    const name = nameEl.value.trim();
    if (!name) return alert('아이템명을 입력해 주세요.');

    const body = itemPayload(name, aliasEl.value.trim(), priceEl.value, $id('newItemKind').value);
    if (await ClanApp.send('/api/items', { body, failMsg: '추가 중 오류가 발생했습니다.' })) {
        $id('newItemKind').value = 'normal';
        nameEl.value = '';
        aliasEl.value = '';
        priceEl.value = '';
        await reloadItems();
    }
}

function startEdit(id) {
    if (id !== null && !isAdminOn()) return;
    editingId = id;
    renderItems();
}

async function saveEdit(id) {
    if (!isAdminOn()) return;
    const name = $id('editName').value.trim();
    if (!name) return alert('아이템명을 입력해 주세요.');

    const body = itemPayload(name, $id('editAliases').value.trim(), $id('editPrice').value, $id('editKind').value);
    if (await ClanApp.send(`/api/items/${id}`, { method: 'PUT', body, failMsg: '수정 중 오류가 발생했습니다.' })) {
        editingId = null;
        await reloadItems();
    }
}

async function deleteItem(id) {
    if (!isAdminOn()) return;
    const it = ClanApp.items.find(x => x.id === id);
    if (!it || !confirm(`[${it.item_name}] 아이템을 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/items/${id}?${ClanApp.roleParam()}`)) await reloadItems();
}
