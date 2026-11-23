// =========================================================
// [admin.js] 혈맹원 계정 · 권한 · 스킬 관리
// =========================================================
const CLASSES = ['기사', '요정', '법사', '군주', '다크엘프'];
const EMAIL_PLACEHOLDER_NEW = '미입력 시 회원 직접 등록 (등록된 회원은 ****로 보호됨)';
let skillsByClass = {
    기사: ['스턴', '리덕', '솔캐', '바운스', '카베', '투망'],
    요정: ['소울', '트리플', '왕바람', '왕어스', '소프', '씽', '게일', '어바', '똥물', '캔슬', '투망'],
    법사: ['뮨', '캔슬', '미티어', '라톰', '파톰', '블리자드', '인비지', '투망'],
    군주: [],
    다크엘프: []
};
let skillRowsDb = [];

window.onload = async () => {
    const user = ClanApp.initPage('/admin', () => {
        renderSkillOptions(getCheckedSkills());
        renderSkillManageChips();
    });
    if (!user) return;

    if (!ClanApp.hasAdminPrivilege) {
        alert('관리자 권한이 없습니다.');
        window.location.href = '/raid-record';
        return;
    }

    const classOptions = CLASSES.map(c => `<option value="${c}">${c}</option>`).join('');
    $id('memClass').innerHTML = classOptions;
    $id('skillTargetClass').innerHTML = classOptions;
    $id('skillTargetClass').value = '요정';
    $id('memEmail').placeholder = EMAIL_PLACEHOLDER_NEW;
    populateRoleOptions();

    await Promise.all([reloadMembers(), loadClassSkills()]);
    renderSkillOptions([]);
    renderSkillManageChips();

    // 명단 페이지에서 [수정] 클릭해 넘어온 경우 해당 회원 폼 자동 오픈
    const editIdParam = new URLSearchParams(window.location.search).get('edit_id');
    if (editIdParam) editMember(Number(editIdParam));
};

async function reloadMembers() {
    ClanApp.setMembers(await ClanApp.getJSON('/api/auth/search-members', []));
}

function populateRoleOptions(selectedRole = '일반회원') {
    const roles = ClanApp.isSuperAdmin ? ['일반회원', '관리자', '슈퍼관리자'] : ['일반회원', '관리자'];
    $id('memRole').innerHTML = roles.map(r => `<option value="${r}" ${r === selectedRole ? 'selected' : ''}>${r}</option>`).join('');
}

async function loadClassSkills() {
    const data = await ClanApp.getJSON('/api/admin/skills', null);
    if (!data) return;   // 실패 시 기본 스킬 맵 유지
    if (data.skills_by_class) {
        skillsByClass = Object.fromEntries(CLASSES.map(c => [c, data.skills_by_class[c] || []]));
    }
    skillRowsDb = data.rows || [];
}

// ---------------------------------------------------------
// 스킬 선택 칩
// ---------------------------------------------------------
function getCheckedSkills() {
    return [...document.querySelectorAll('#memSkills input[name="memberSkill"]:checked')].map(i => i.value);
}

function onMemberClassChange() {
    const cls = $id('memClass').value;
    if (skillsByClass[cls] !== undefined) {
        $id('skillTargetClass').value = cls;
        renderSkillManageChips();
    }
    renderSkillOptions([]);
}

function renderSkillOptions(selectedSkills = []) {
    const container = $id('memSkills');
    const cls = $id('memClass').value;
    const skills = skillsByClass[cls] || [];
    container.innerHTML = '';

    if (skills.length === 0) {
        container.innerHTML = `<span class="c-dim">[${cls}] 클래스에 등록된 스킬이 없습니다. 아래 스킬 관리에서 추가해 주세요.</span>`;
        return;
    }

    skills.forEach(skill => {
        const checked = selectedSkills.includes(skill);
        const label = document.createElement('label');
        label.className = `skill-chip-label ${checked ? 'selected' : ''}`;
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'memberSkill';
        checkbox.value = skill;
        checkbox.checked = checked;
        checkbox.onchange = () => label.classList.toggle('selected', checkbox.checked);
        label.append(checkbox, document.createTextNode(skill));
        container.appendChild(label);
    });
}

function renderSkillManageChips() {
    const cls = $id('skillTargetClass').value;
    const list = skillsByClass[cls] || [];
    const box = $id('skillManageListBox');

    if (list.length === 0) {
        box.innerHTML = `<span class="c-dim">[${cls}] 클래스에 등록된 스킬이 없습니다.</span>`;
        return;
    }
    box.innerHTML = list.map(sk => {
        const dbRow = skillRowsDb.find(r => r.char_class === cls && r.skill_name === sk);
        const delBtn = dbRow
            ? `<button type="button" class="skill-del-x" title="스킬 삭제" onclick="deleteClassSkill(${dbRow.id}, ${ClanApp.jsArg(sk)})">✕</button>`
            : '';
        return `<span class="skill-manage-badge">${ClanApp.escapeHtml(sk)}${delBtn}</span>`;
    }).join('');
}

async function addNewClassSkill() {
    if (!ClanApp.isAdminModeOn) return;
    const cls = $id('skillTargetClass').value;
    const inputEl = $id('newSkillNameInput');
    const skillName = (inputEl.value || '').trim();
    if (!skillName) return alert('추가할 스킬명을 입력해 주세요.');

    const prevChecked = getCheckedSkills();
    const ok = await ClanApp.send('/api/admin/skills', {
        body: { char_class: cls, skill_name: skillName, requester_role: ClanApp.role },
        failMsg: '스킬 추가 중 오류가 발생했습니다.'
    });
    if (!ok) return;

    inputEl.value = '';
    await loadClassSkills();
    renderSkillManageChips();
    if ($id('memClass').value === cls) renderSkillOptions([...prevChecked, skillName]);
    alert(`[${cls}] 클래스에 [${skillName}] 스킬이 추가되었습니다.`);
}

async function deleteClassSkill(skillId, skillName) {
    if (!ClanApp.isAdminModeOn) return;
    if (!confirm(`[${skillName}] 스킬을 목록에서 삭제하시겠습니까?`)) return;

    const prevChecked = getCheckedSkills();
    if (await ClanApp.del(`/api/admin/skills/${skillId}?${ClanApp.roleParam('requester_role')}`, '스킬 삭제 중 오류가 발생했습니다.')) {
        await loadClassSkills();
        renderSkillManageChips();
        renderSkillOptions(prevChecked.filter(s => s !== skillName));
    }
}

// ---------------------------------------------------------
// 회원 추가 / 수정
// ---------------------------------------------------------
function setSubChars(list) {
    [1, 2, 3].forEach(n => { $id(`subChar${n}`).value = list[n - 1] || ''; });
}

function editMember(id) {
    if (!ClanApp.isAdminModeOn) return;
    const m = ClanApp.members.find(x => x.id === id);
    if (!m) return;
    if (m.role === '슈퍼관리자' && !ClanApp.isSuperAdmin) {
        return alert('슈퍼관리자 정보는 슈퍼관리자만 수정할 수 있습니다.');
    }

    $id('editMemberId').value = m.id;
    $id('memUniqueId').value = m.unique_id || '';
    $id('memActiveId').value = m.active_id || '';
    $id('memEmail').value = '';
    $id('memEmail').placeholder = (m.has_email || m.google_email)
        ? '현재 등록됨 (****) - 변경할 때만 새 이메일 입력'
        : '미입력 시 회원 직접 등록';
    $id('memClass').value = m.char_class || '기사';
    $id('memClan').value = m.clan || '피닉스';
    populateRoleOptions(m.role);
    setSubChars(ClanApp.splitCsv(m.sub_chars));

    renderSkillOptions(Array.isArray(m.skills) ? m.skills : ClanApp.splitCsv(m.skills));
    $id('formTitle').textContent = `✏️ [${m.active_id}] 회원 정보 수정`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetMemberForm() {
    ['editMemberId', 'memUniqueId', 'memActiveId', 'memEmail'].forEach(id => { $id(id).value = ''; });
    $id('memEmail').placeholder = EMAIL_PLACEHOLDER_NEW;
    setSubChars([]);
    populateRoleOptions('일반회원');
    renderSkillOptions([]);
    $id('formTitle').textContent = '➕ 혈맹원 계정 및 권한 관리 (추가 / 수정)';
}

async function saveMember() {
    if (!ClanApp.isAdminModeOn) return;
    const editId = $id('editMemberId').value;
    const typedEmail = $id('memEmail').value.trim();
    let finalEmail = typedEmail || null;

    // 수정 시 이메일을 비워두면 기존 이메일 유지
    if (editId && !typedEmail) {
        const existing = ClanApp.members.find(x => String(x.id) === String(editId));
        if (existing && existing.google_email) finalEmail = existing.google_email;
    }

    const payload = {
        unique_id: $id('memUniqueId').value.trim(),
        active_id: $id('memActiveId').value.trim(),
        google_email: finalEmail,
        char_class: $id('memClass').value,
        clan: $id('memClan').value,
        role: $id('memRole').value,
        sub_chars: [1, 2, 3].map(n => $id(`subChar${n}`).value.trim()).filter(Boolean).join(', '),
        skills: getCheckedSkills(),
        requester_role: ClanApp.role
    };
    if (!payload.unique_id || !payload.active_id) return alert('고유 아이디(UID)와 본캐릭명을 입력해 주세요.');

    const ok = await ClanApp.send(editId ? `/api/admin/members/${editId}` : '/api/admin/members', {
        method: editId ? 'PUT' : 'POST',
        body: payload,
        failMsg: '저장 중 오류가 발생했습니다.'
    });
    if (ok) {
        alert('회원 정보가 저장되었습니다.');
        resetMemberForm();
        await reloadMembers();
    }
}
