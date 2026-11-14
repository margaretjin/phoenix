// 전역 상태 객체
window.ClanApp = {
    user: null,
    role: '일반회원',
    isSuperAdmin: false,
    hasAdminPrivilege: false,
    isAdminModeOn: false,

    // 1. 로그인 세션 확인 (로그아웃 누르기 전까지 영구 유지) 및 상단 네비게이션 자동 렌더링
    initPage(activePath, onAdminToggleCallback = null) {
        const saved = localStorage.getItem('clan_user');
        if (!saved) {
            window.location.href = '/login';
            return null;
        }
        this.user = JSON.parse(saved);
        this.role = (this.user.role || '일반회원').trim();
        this.isSuperAdmin = this.role === '슈퍼관리자';
        this.hasAdminPrivilege = this.role === '관리자' || this.isSuperAdmin;
        this.isAdminModeOn = this.hasAdminPrivilege && (localStorage.getItem('clan_admin_mode') === 'true');
        this.onAdminToggle = onAdminToggleCallback;

        this.renderNavbar(activePath);
        return this.user;
    },

    renderNavbar(activePath) {
        const nav = document.getElementById('appNavbar');
        if (!nav || !this.user) return;

        const links = [
            { href: '/raid-record', label: '보스탐 기록' },
            { href: '/raid-status', label: '일별기록현황' },
            { href: '/item-status', label: '템 보유현황' },
            { href: '/distribution', label: '분배금 관리' },
            { href: '/my-history', label: `${this.user.active_id} 참여내역` }
        ];

        const leftHtml = links.map(l =>
            `<a href="${l.href}" class="nav-link ${activePath === l.href ? 'active' : ''}">${l.label}</a>`
        ).join('');

        const adminToggleHtml = this.hasAdminPrivilege
            ? `<button id="adminModeBtn" onclick="ClanApp.toggleAdminMode()" class="admin-mode-toggle ${this.isAdminModeOn ? 'active' : ''}">
                 👑 관리자 모드: ${this.isAdminModeOn ? 'ON' : 'OFF'}
               </button>
               <a href="/admin" id="navAdminBtn" class="nav-link admin-btn ${activePath === '/admin' ? 'active' : ''} ${this.isAdminModeOn || activePath === '/admin' ? '' : 'hidden'}">회원관리</a>`
            : '';

        nav.innerHTML = `
            <div class="nav-left">${leftHtml}</div>
            <div class="nav-right">
                <span style="color: var(--accent-gold); font-weight: 700; font-size: 0.86rem; margin-right: 0.25rem; white-space: nowrap;">
                    ${this.user.active_id} (${this.role})
                </span>
                ${adminToggleHtml}
                <button onclick="ClanApp.logout()" class="btn btn-dark" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;">로그아웃</button>
            </div>
        `;
    },

    toggleAdminMode() {
        if (!this.hasAdminPrivilege) return;
        this.isAdminModeOn = !this.isAdminModeOn;
        localStorage.setItem('clan_admin_mode', this.isAdminModeOn ? 'true' : 'false');
        this.renderNavbar(window.location.pathname);
        if (typeof this.onAdminToggle === 'function') {
            this.onAdminToggle(this.isAdminModeOn);
        }
    },

    logout() {
        if (confirm('로그아웃 하시겠습니까?')) {
            localStorage.removeItem('clan_user');
            localStorage.removeItem('clan_admin_mode');
            window.location.href = '/login';
        }
    },

    formatYMD(d = new Date()) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${yyyy}-${mm}-${dd}`;
    },

    formatYM(d = new Date()) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        return `${yyyy}-${mm}`;
    },

    // 레코드에서 아이템 상세 배열 추출 (분배일자 dist_date 포함)
    extractItemDetails(record) {
        if (!record) return [];
        const rawTokens = (record.dropped_items || '').split(/[\s,，\n]+/).map(s => s.trim()).filter(Boolean);
        const savedDetails = Array.isArray(record.item_details) ? record.item_details : [];

        if (savedDetails.length > 0 && rawTokens.length === 0) {
            return savedDetails.map(d => ({
                name: d.name || '',
                price: Number(d.price || 0),
                winner: d.winner || '',
                taken_date: d.taken_date || '',
                dist_date: d.dist_date || ''
            }));
        }

        const usedIdx = new Set();
        return rawTokens.map(token => {
            let found = null;
            for (let i = 0; i < savedDetails.length; i++) {
                if (!usedIdx.has(i) && savedDetails[i].name === token) {
                    found = savedDetails[i];
                    usedIdx.add(i);
                    break;
                }
            }
            return {
                name: token,
                price: found ? Number(found.price || 0) : 0,
                winner: found ? (found.winner || '') : '',
                taken_date: found ? (found.taken_date || '') : '',
                dist_date: found ? (found.dist_date || '') : ''
            };
        });
    },

    // 레코드에서 중복 제거된 참여자 목록 추출
    extractParticipants(record) {
        const ordered = [];
        const seen = new Set();
        ((record && record.parties) || []).forEach(p => {
            if (p.leader && !seen.has(p.leader)) {
                seen.add(p.leader);
                ordered.push({ id: p.leader, isLeader: true });
            }
            (p.members || []).forEach(m => {
                if (m && !seen.has(m)) {
                    seen.add(m);
                    ordered.push({ id: m, isLeader: false });
                }
            });
        });
        return ordered;
    },

    // 일별 또는 월별 엑셀(CSV) 다운로드 실행
    downloadExcel({ date = '', month = '' } = {}) {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        else if (month) params.set('month', month);
        window.location.href = `/api/raids/export-excel?${params.toString()}`;
    }
};