// 전역 상태 및 공통 유틸리티 모듈
window.ClanApp = {
    user: null,
    role: '일반회원',
    isSuperAdmin: false,
    hasAdminPrivilege: false,
    isAdminModeOn: false,
    itemAliases: Object.create(null),

    RAID_TIMES: [
        '01시', '03시', '05시', '07시', '09시', '11시', '12시', '13시',
        '15시', '17시', '18시', '19시', '21시', '22시(오만)', '23시', '24시'
    ],

    MAIN_RAID_TIMES: ['09시', '15시', '21시', '22시(오만)', '03시'],

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

        document.body.classList.toggle('admin-mode', this.isAdminModeOn);
        this.renderNavbar(activePath);
        return this.user;
    },

    renderNavbar(activePath) {
        const nav = document.getElementById('appNavbar');
        if (!nav || !this.user) return;

        // '분배금관리' -> '분배관리' 변경
        const links = [
            { href: '/raid-record', label: '보스탐기록' },
            { href: '/raid-status', label: '일별현황' },
            { href: '/item-status', label: '템보유현황' },
            { href: '/distribution', label: '분배관리' },
            { href: '/my-history', label: '참여내역' },
            { href: '/attendance', label: '참여도' }
        ];

        const adminTabs = [];
        if (this.hasAdminPrivilege && (this.isAdminModeOn || activePath === '/admin')) {
            adminTabs.push({ href: '/admin', label: '회원관리' });
        }
        adminTabs.push({ href: '/item-manage', label: '아이템' });

        const adminTabsHtml = adminTabs.map(l =>
            `<a href="${l.href}" class="nav-admin-link ${activePath === l.href ? 'active' : ''}">${l.label}</a>`
        ).join('');

        const menuGridHtml = links.map(l =>
            `<a href="${l.href}" class="nav-link ${activePath === l.href ? 'active' : ''}">${l.label}</a>`
        ).join('');

        const adminToggleHtml = this.hasAdminPrivilege
            ? `<button id="adminModeBtn" type="button" onclick="ClanApp.toggleAdminMode()" class="admin-mode-toggle ${this.isAdminModeOn ? 'active' : ''}">
                 👑 관리자 ${this.isAdminModeOn ? 'ON' : 'OFF'}
               </button>`
            : '';

        nav.innerHTML = `
            <div class="nav-inner-container">
                <div class="nav-top-bar">
                    <div class="nav-user-box">
                        <span class="nav-user-name">${this.user.active_id} <small>(${this.role})</small></span>
                        <button type="button" onclick="ClanApp.logout()" class="btn-logout-mini">로그아웃</button>
                    </div>
                    <div class="nav-admin-box">
                        ${adminTabsHtml}
                        ${adminToggleHtml}
                    </div>
                </div>
                <div class="nav-menu-grid cols-${links.length}">
                    ${menuGridHtml}
                </div>
            </div>
        `;
    },

    toggleAdminMode() {
        if (!this.hasAdminPrivilege) return;
        this.isAdminModeOn = !this.isAdminModeOn;
        localStorage.setItem('clan_admin_mode', this.isAdminModeOn ? 'true' : 'false');
        document.body.classList.toggle('admin-mode', this.isAdminModeOn);
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

    getWeekRange(dateStr) {
        const [y, m, d] = dateStr.split('-').map(Number);
        const dow = (new Date(y, m - 1, d).getDay() + 6) % 7;
        const start = this.formatYMD(new Date(y, m - 1, d - dow));
        const end = this.formatYMD(new Date(y, m - 1, d - dow + 6));
        return { start, end };
    },

    parseRaidHour(timeLabel) {
        const m = String(timeLabel || '').match(/^(\d{1,2})시/);
        return m ? parseInt(m[1], 10) : 0;
    },

    getDefaultRaidTime(now = new Date()) {
        const currentHour = now.getHours();
        let selected = this.RAID_TIMES[0];

        for (const slot of this.RAID_TIMES) {
            const slotHour = this.parseRaidHour(slot);
            if (slotHour <= currentHour) {
                selected = slot;
            }
        }
        return selected;
    },

    getSlotStatus(dateStr, timeLabel, now = new Date()) {
        const hourNum = this.parseRaidHour(timeLabel);
        const [y, m, d] = dateStr.split('-').map(Number);
        const slotTime = new Date(y, m - 1, d, hourNum, 0, 0);
        const diffHours = (now - slotTime) / (1000 * 60 * 60);

        if (diffHours < 0) return 'future';
        if (diffHours <= 3.0) return 'open';
        return 'expired';
    },

    setItemAliases(items = []) {
        const aliases = Object.create(null);
        items.forEach(item => {
            const fullName = String(item.item_name || '').trim();
            if (!fullName) return;
            const alias = String(item.aliases || '')
                .split(/[,，]+/)
                .map(value => value.trim())
                .find(Boolean);
            aliases[fullName.toLowerCase()] = alias || fullName;
        });
        this.itemAliases = aliases;
    },

    getItemAlias(fullName) {
        const name = String(fullName || '').trim();
        return this.itemAliases[name.toLowerCase()] || name;
    },

    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[char]);
    },

    itemNameHtml(fullName) {
        const name = String(fullName || '').trim();
        const safeName = this.escapeHtml(name);
        const alias = this.escapeHtml(this.getItemAlias(name));
        return `<span class="item-alias-label" data-item-full-name="${safeName}" title="${safeName}">${alias}</span>`;
    },

    extractItemDetails(record, priceMap = {}) {
        if (!record) return [];
        const rawTokens = (record.dropped_items || '').split(/[\s,，\n]+/).map(s => s.trim()).filter(Boolean);
        const savedDetails = Array.isArray(record.item_details) ? record.item_details : [];

        if (savedDetails.length > 0 && rawTokens.length === 0) {
            return savedDetails.map(d => {
                const name = d.name || '';
                const winner = (d.winner || '').trim();
                const sType = winner ? (d.sale_type || '내판') : '보유중';
                const hasExplicitZero = winner && ((sType === '이벤트') || Number(d.price) === 0);
                const savedPrice = Number(d.price || 0);
                const finalPrice = hasExplicitZero ? 0 : (savedPrice > 0 ? savedPrice : Number(priceMap[name] || 0));
                const distDate = winner ? (d.dist_date || '') : '';
                const isChecked = winner ? Boolean(d.dist_checked || distDate) : false;

                return {
                    name,
                    sale_type: sType,
                    price: finalPrice,
                    winner,
                    taken_date: d.taken_date || '',
                    dist_date: distDate,
                    dist_checked: isChecked
                };
            });
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
            const winner = found ? (found.winner || '').trim() : '';
            const sType = winner ? (found && found.sale_type ? found.sale_type : '내판') : '보유중';
            const hasExplicitZero = found && winner && ((sType === '이벤트') || Number(found.price) === 0);
            const savedPrice = found ? Number(found.price || 0) : 0;
            const finalPrice = hasExplicitZero ? 0 : (savedPrice > 0 ? savedPrice : Number(priceMap[token] || 0));
            const distDate = (found && winner) ? (found.dist_date || '') : '';
            const isChecked = (found && winner) ? Boolean(found.dist_checked || distDate) : false;

            return {
                name: token,
                sale_type: sType,
                price: finalPrice,
                winner,
                taken_date: found ? (found.taken_date || '') : '',
                dist_date: distDate,
                dist_checked: isChecked
            };
        });
    },

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

    downloadExcel({ date = '', month = '', start = '', end = '' } = {}) {
        const params = new URLSearchParams();
        if (date) params.set('date', date);
        else if (start && end) {
            params.set('start', start);
            params.set('end', end);
        } else if (month) {
            params.set('month', month);
        }
        window.location.href = `/api/raids/export-excel?${params.toString()}`;
    }
};

const itemFullNameToast = document.createElement('div');
itemFullNameToast.className = 'item-full-name-toast';
itemFullNameToast.setAttribute('role', 'status');
itemFullNameToast.setAttribute('aria-live', 'polite');
document.body.appendChild(itemFullNameToast);

let itemFullNameToastTimer;
document.addEventListener('touchend', event => {
    const itemLabel = event.target instanceof Element
        ? event.target.closest('.item-alias-label')
        : null;
    if (!itemLabel) {
        itemFullNameToast.classList.remove('visible');
        return;
    }

    itemFullNameToast.textContent = itemLabel.dataset.itemFullName || itemLabel.title;
    itemFullNameToast.classList.add('visible');
    window.clearTimeout(itemFullNameToastTimer);
    itemFullNameToastTimer = window.setTimeout(() => {
        itemFullNameToast.classList.remove('visible');
    }, 2600);
}, { passive: true });