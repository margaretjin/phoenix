// =========================================================
// [member_list.js] 등록된 혈원 명단
// =========================================================
const ROLE_ORDER = { '슈퍼관리자': 1, '관리자': 2, '일반회원': 3 };
let sortColumn = 'active_id';
let sortDirection = 'asc';

window.onload = async () => {
    const user = ClanApp.initPage('/member-list', renderMembersTable);
    if (!user) return;

    document.querySelectorAll('.sortable-th').forEach(th => {
        th.addEventListener('click', () => toggleMemberSort(th.dataset.sort));
    });
    updateSortArrowsUI();
    await reloadMembers();
};

async function reloadMembers() {
    ClanApp.setMembers(await ClanApp.getJSON('/api/auth/search-members', []));
    renderMembersTable();
}

function toggleMemberSort(col) {
    if (sortColumn === col) {
        sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
        sortColumn = col;
        sortDirection = col === 'skills' ? 'desc' : 'asc';
    }
    updateSortArrowsUI();
    renderMembersTable();
}

function updateSortArrowsUI() {
    document.querySelectorAll('.sortable-th').forEach(th => {
        const el = th.querySelector('.sort-arrow');
        const isActive = th.dataset.sort === sortColumn;
        el.textContent = isActive ? (sortDirection === 'asc' ? '▲' : '▼') : '⇅';
        el.classList.toggle('active', isActive);
    });
}

const skillsText = (m) => (Array.isArray(m.skills) ? m.skills.join(', ') : String(m.skills || ''));
const byName = (a, b) => (a.active_id || '').localeCompare(b.active_id || '', 'ko');

function compareMembers(a, b) {
    const dir = sortDirection === 'asc' ? 1 : -1;
    if (sortColumn === 'skills') {
        const aSkills = skillsText(a).trim();
        const bSkills = skillsText(b).trim();
        if (!aSkills && !bSkills) return byName(a, b);
        if (!aSkills) return 1;
        if (!bSkills) return -1;
        const aLen = Array.isArray(a.skills) ? a.skills.length : aSkills.split(',').length;
        const bLen = Array.isArray(b.skills) ? b.skills.length : bSkills.split(',').length;
        if (aLen !== bLen) return (aLen - bLen) * dir;
        return (aSkills.localeCompare(bSkills, 'ko') * dir) || byName(a, b);
    }
    if (sortColumn === 'role') {
        const diff = (ROLE_ORDER[a.role] || 99) - (ROLE_ORDER[b.role] || 99);
        return diff ? diff * dir : byName(a, b);
    }
    const cmp = String(a[sortColumn] || '').localeCompare(String(b[sortColumn] || ''), 'ko', { numeric: true });
    return cmp ? cmp * dir : byName(a, b);
}

function renderMembersTable() {
    const tbody = $id('memberTableBody');
    const keyword = $id('memberSearchInput').value.trim().toLowerCase();
    const isAdmin = ClanApp.isAdminModeOn;
    const esc = (v) => ClanApp.escapeHtml(v);

    const filtered = ClanApp.members.filter(m => !keyword
        || [m.active_id, m.unique_id, m.sub_chars, m.char_class, skillsText(m)].some(v => String(v || '').toLowerCase().includes(keyword))
    ).sort(compareMembers);

    $id('memberSearchResultCount').textContent = `총 ${filtered.length}명`;
    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="9" class="empty-party-msg">검색 결과가 없습니다.</td></tr>`;
        return;
    }

    tbody.innerHTML = filtered.map(m => {
        const hasEmail = Boolean(m.has_email || (m.google_email && m.google_email.trim()));
        let actionCell = '';
        if (isAdmin) {
            const canModify = ClanApp.isSuperAdmin || m.role !== '슈퍼관리자';
            const idArg = ClanApp.jsArg(m.active_id);
            actionCell = canModify
                ? `<td><div class="row-actions">
                       <a href="/admin?edit_id=${m.id}" class="btn-row-edit">수정</a>
                       <button type="button" class="btn-sm btn-sm-dark btn-xs" onclick="resetEmail(${m.id}, ${idArg})">이메일초기화</button>
                       <button type="button" class="btn-row-del" onclick="deleteMember(${m.id}, ${idArg})">삭제</button>
                   </div></td>`
                : `<td><span class="c-dim">슈퍼관리자 전용</span></td>`;
        }

        return `
            <tr>
                <td class="c-muted uid-cell">${esc(m.unique_id)}</td>
                <td class="c-gold">${esc(m.active_id)}</td>
                <td>${m.sub_chars ? `<span class="c-mint">${esc(m.sub_chars)}</span>` : `<span class="c-dim">-</span>`}</td>
                <td>${esc(m.char_class)}</td>
                <td>${esc(skillsText(m) || '-')}</td>
                <td>${esc(m.clan)}</td>
                <td class="role-cell">${esc(m.role)}</td>
                <td>${hasEmail ? `<span class="masked-email-text">****</span>` : `<span class="unregistered-email-text">미등록</span>`}</td>
                ${actionCell}
            </tr>`;
    }).join('');
}

async function resetEmail(memberId, activeId) {
    if (!ClanApp.isAdminModeOn) return;
    if (!confirm(`[${activeId}] 회원의 등록된 이메일을 초기화하시겠습니까?\n초기화 후 해당 회원이 로그인 화면에서 새 이메일을 직접 등록할 수 있습니다.`)) return;
    if (await ClanApp.send(`/api/auth/reset-email/${memberId}?${ClanApp.roleParam('requester_role')}`, { failMsg: '초기화 실패' })) {
        alert(`[${activeId}] 이메일이 초기화되었습니다.`);
        await reloadMembers();
    }
}

async function deleteMember(memberId, activeId) {
    if (!ClanApp.isAdminModeOn) return;
    if (!confirm(`[${activeId}] 회원을 명단에서 삭제하시겠습니까?`)) return;
    if (await ClanApp.del(`/api/admin/members/${memberId}?${ClanApp.roleParam('requester_role')}`)) {
        alert('삭제되었습니다.');
        await reloadMembers();
    }
}
