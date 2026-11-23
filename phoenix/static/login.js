// =========================================================
// [login.js] 캐릭터 선택 + 이메일(비밀번호 대체) 로그인
// =========================================================
let allMembers = [];
let selectedMember = null;

window.onload = async () => {
    // 로그아웃 전까지 자동 로그인 유지
    if (localStorage.getItem('clan_user')) {
        window.location.href = '/raid-record';
        return;
    }
    try {
        const res = await fetch('/api/auth/search-members');
        allMembers = await res.json();
        renderSearchChips();
    } catch (e) {
        showChipMessage('회원 명단을 불러오지 못했습니다.');
    }
};

function showChipMessage(text) {
    document.getElementById('memberChipList').textContent = text;
}

function renderSearchChips() {
    const keyword = document.getElementById('memberSearchBox').value.trim().toLowerCase();
    const chipBox = document.getElementById('memberChipList');

    const filtered = allMembers.filter(m => !keyword
        || [m.active_id, m.unique_id, m.sub_chars].some(v => (v || '').toLowerCase().includes(keyword)));

    if (filtered.length === 0) return showChipMessage('검색 결과가 없습니다.');

    chipBox.innerHTML = '';
    filtered.forEach(m => {
        const chip = document.createElement('span');
        chip.className = 'login-chip';
        if (selectedMember && selectedMember.active_id === m.active_id) chip.classList.add('selected');
        chip.textContent = `${m.has_email ? '🔒' : '🆕'} ${m.active_id}`;
        chip.onclick = () => selectMemberForLogin(m);
        chipBox.appendChild(chip);
    });
}

function selectMemberForLogin(member) {
    selectedMember = member;
    document.getElementById('selectedActiveId').value = member.active_id;
    const statusEl = document.getElementById('selectedIdStatus');
    const btn = document.getElementById('loginBtn');

    if (member.has_email) {
        statusEl.innerHTML = `🔒 <b class="c-mint">가입 완료 회원</b>: 등록하신 이메일 주소를 입력하면 로그인됩니다.`;
        btn.textContent = `[${member.active_id}] 로그인`;
    } else {
        statusEl.innerHTML = `🆕 <b class="c-gold">최초 가입 회원</b>: 본인이 사용할 이메일 주소를 입력하면 즉시 등록 및 로그인됩니다.`;
        btn.textContent = `[${member.active_id}] 이메일 등록 및 로그인`;
    }

    btn.disabled = false;
    renderSearchChips();
    document.getElementById('loginEmail').focus();
}

async function handleEmailLogin(e) {
    e.preventDefault();
    if (!selectedMember) return;

    const email = document.getElementById('loginEmail').value.trim();
    const msgEl = document.getElementById('loginMessage');
    const btn = document.getElementById('loginBtn');
    const fail = (text) => {
        msgEl.classList.add('error');
        msgEl.textContent = text;
        btn.disabled = false;
    };

    btn.disabled = true;
    msgEl.classList.remove('error');
    msgEl.textContent = '인증 확인 중...';

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_id: selectedMember.active_id, email })
        });
        const data = await res.json();
        if (!res.ok) return fail(data.detail || '로그인에 실패했습니다.');

        if (data.status === 'email_registered') {
            alert(`[${data.user.active_id}] 아이디에 이메일(${email})이 등록되었습니다!`);
        }
        localStorage.setItem('clan_user', JSON.stringify(data.user));
        window.location.href = '/raid-record';
    } catch (err) {
        fail('서버 통신 오류가 발생했습니다.');
    }
}
