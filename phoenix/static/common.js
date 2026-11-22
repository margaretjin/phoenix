// 전역 상태 및 공통 유틸리티 모듈
window.ClanApp = {
    user: null,
    role: '일반회원',
    isSuperAdmin: false,
    hasAdminPrivilege: false,
    isAdminModeOn: false,
    itemAliases: Object.create(null),
    eventItems: Object.create(null),       // 이벤트템(분배금 0원) 아이템 목록
    clanOwnedItems: Object.create(null),   // 혈비귀속(분배금 제외) 아이템 목록

    RAID_TIMES: [
        '01시', '03시', '05시', '06시', '07시', '09시', '11시', '12시',
        '13시', '15시', '17시', '18시', '19시', '21시', '23시(오만)', '24시', '용레이드'
    ],

    // 일요일에만 용레이드 옆에 공성 시간 추가
    SIEGE_TIME: '공성',

    getRaidTimes(dateStr) {
        const times = this.RAID_TIMES.slice();
        if (dateStr) {
            const [y, m, d] = String(dateStr).split('-').map(Number);
            if (y && m && d && new Date(y, m - 1, d).getDay() === 0) times.push(this.SIEGE_TIME);
        }
        return times;
    },

    slotAttr(t) {
        return (t === '용레이드' || t === this.SIEGE_TIME) ? ` data-slot="${t}"` : '';
    },

    // 아이템 진행 단계: 연합분배대기(저장값 '보유중') → 연합 선택 → 내판 / 외판 / 이벤트
    // 저장값은 기존 DB 호환을 위해 '보유중' 그대로 쓰고, 화면에는 '연합분배대기'로 표기
    saleTypeLabel(t) {
        return (!t || t === '보유중') ? '연합분배대기' : t;
    },

    isEventItem(name) {
        return Boolean(this.eventItems[String(name || '').trim().toLowerCase()]);
    },

    isClanOwnedItem(name) {
        return Boolean(this.clanOwnedItems[String(name || '').trim().toLowerCase()]);
    },

    MAIN_RAID_TIMES: ['09시', '15시', '21시', '23시(오만)', '03시'],

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
        document.body.classList.toggle('page-raid-record', activePath === '/raid-record');
        this.renderNavbar(activePath);
        return this.user;
    },

    renderNavbar(activePath) {
        const nav = document.getElementById('appNavbar');
        if (!nav || !this.user) return;

        const links = [
            { href: '/raid-record', label: '보스탐기록' },
            { href: '/raid-status', label: '일별현황' },
            { href: '/item-status', label: '템보유현황' },
            { href: '/distribution', label: '분배관리' },
            { href: '/my-history', label: '참여내역' },
            { href: '/attendance', label: '참여도' }
        ];

        const adminTabs = [];
        // 관리자 모드 ON일 때만 '혈맹원관리' 표시
        if (this.hasAdminPrivilege && (this.isAdminModeOn || activePath === '/admin')) {
            adminTabs.push({ href: '/admin', label: '혈맹원관리' });
        }
        // '명단'과 '아이템'은 일반회원도 열람 가능하도록 항상 표시
        adminTabs.push({ href: '/member-list', label: '명단' });
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
        return m ? parseInt(m[1], 10) : null;
    },

    getDefaultRaidTime(now = new Date()) {
        const currentHour = now.getHours();
        let selected = this.RAID_TIMES[0];

        for (const slot of this.RAID_TIMES) {
            const slotHour = this.parseRaidHour(slot);
            if (slotHour === null) continue;
            if (slotHour <= currentHour) {
                selected = slot;
            }
        }
        return selected;
    },

    getSlotStatus(dateStr, timeLabel, now = new Date()) {
        const hourNum = this.parseRaidHour(timeLabel);
        // 용레이드 등 고정 시각이 없는 특수 타임은 날짜·시간 상관없이 항시 입력 가능
        if (hourNum === null) {
            return 'open';
        }

        const [y, m, d] = dateStr.split('-').map(Number);
        const slotTime = new Date(y, m - 1, d, hourNum, 0, 0);
        const diffHours = (now - slotTime) / (1000 * 60 * 60);

        if (diffHours < 0) return 'future';
        if (diffHours <= 3.0) return 'open';
        return 'expired';
    },

    setItemAliases(items = []) {
        const aliases = Object.create(null);
        const owned = Object.create(null);
        const events = Object.create(null);
        items.forEach(item => {
            const fullName = String(item.item_name || '').trim();
            if (!fullName) return;
            if (item.clan_owned) owned[fullName.toLowerCase()] = true;
            if (item.event_item) events[fullName.toLowerCase()] = true;
            const alias = String(item.aliases || '')
                .split(/[,，]+/)
                .map(value => value.trim())
                .find(Boolean);
            aliases[fullName.toLowerCase()] = alias || fullName;
        });
        this.itemAliases = aliases;
        this.clanOwnedItems = owned;
        this.eventItems = events;
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

        const resolveItemObj = (name, foundObj) => {
            const policyPrice = Number(priceMap[name] || 0);
            const winner = foundObj ? (foundObj.winner || '').trim() : '';
            const rawSaleType = foundObj && foundObj.sale_type ? foundObj.sale_type : '보유중';
            const savedPrice = foundObj ? Number(foundObj.price || 0) : 0;

            const alliance = foundObj ? String(foundObj.alliance || '').trim() : '';

            let sType = '보유중';
            let finalPrice = policyPrice;

            // 진행 단계: 연합분배대기(alliance 없음) → 피닉스 선택 시 내판/외판/이벤트, 반항·세븐 선택 시 연합(분배 없음)
            if (alliance === '반항' || alliance === '세븐') {
                sType = '연합';
                finalPrice = savedPrice > 0 ? savedPrice : policyPrice;
            } else if (alliance === '피닉스') {
                if (rawSaleType === '이벤트') {
                    sType = '이벤트';
                    finalPrice = 0;
                } else if (rawSaleType === '내판' || rawSaleType === '외판') {
                    sType = rawSaleType;
                    finalPrice = savedPrice > 0 ? savedPrice : policyPrice;
                } else {
                    sType = '보유중';   // 피닉스 선택 후 판매구분 대기
                    finalPrice = savedPrice > 0 ? savedPrice : policyPrice;
                }
            } else if (winner) {
                const isEvent = (rawSaleType === '이벤트') || (savedPrice === 0);
                if (isEvent) {
                    sType = '이벤트';
                    finalPrice = 0;
                } else {
                    if (rawSaleType === '외판') sType = '외판';
                    else if (rawSaleType === '연합') sType = '연합';
                    else sType = '내판';
                    finalPrice = savedPrice > 0 ? savedPrice : policyPrice;
                }
            } else {
                sType = '보유중';
                finalPrice = savedPrice > 0 ? savedPrice : policyPrice;
            }

            // 이벤트템: 분배금 0원, 구분 '이벤트'로 고정
            if (this.isEventItem(name)) {
                return {
                    name,
                    sale_type: '이벤트',
                    price: 0,
                    policy_price: policyPrice,
                    winner,
                    taken_date: (foundObj && winner) ? (foundObj.taken_date || '') : '',
                    dist_date: '',
                    dist_checked: false,
                    alliance,
                    event_item: true
                };
            }

            // 혈비귀속 아이템: 판매금(정책가) 자동 표시, 분배 대상에서 제외
            if (this.isClanOwnedItem(name)) {
                return {
                    name,
                    sale_type: '연합',
                    price: policyPrice,
                    policy_price: policyPrice,
                    winner,
                    taken_date: (foundObj && winner) ? (foundObj.taken_date || '') : '',
                    dist_date: '',
                    dist_checked: false,
                    alliance,
                    clan_owned: true
                };
            }

            const canDist = Boolean(foundObj && winner && (sType === '내판' || sType === '외판'));
            const distDate = canDist ? (foundObj.dist_date || '') : '';
            const isChecked = canDist ? Boolean(foundObj.dist_checked || distDate) : false;

            return {
                name,
                sale_type: sType,
                price: finalPrice,
                policy_price: policyPrice,
                winner,
                taken_date: (foundObj && winner) ? (foundObj.taken_date || '') : '',
                dist_date: distDate,
                dist_checked: isChecked,
                alliance
            };
        };

        if (savedDetails.length > 0 && rawTokens.length === 0) {
            return savedDetails.map(d => resolveItemObj(d.name || '', d));
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
            return resolveItemObj(token, found);
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

// 용레이드(:last-child) 버튼: 렌더링 즉시 적용되는 순수 CSS로 깜빡임 원천 차단
(function initDragonRaidInstantStyle() {
    const style = document.createElement('style');
    style.textContent = `
        .common-time-grid .common-time-btn[data-slot]:not(.active):not(.selected):not(.participated) {
            background-color: #141414 !important;
            border-color: #27272a !important;
            color: #71717a !important;
        }
        .common-time-grid .common-time-btn[data-slot]:not(.active):not(.selected):not(.participated) .common-time-sub {
            color: #52525b !important;
        }
        body.page-raid-record .common-time-grid .common-time-btn[data-slot] .common-time-sub {
            display: none !important;
        }
    `;
    document.head.appendChild(style);
})();

let itemFullNameToast = null;
let itemFullNameToastTimer = null;

function ensureItemToastElement() {
    if (itemFullNameToast && document.body.contains(itemFullNameToast)) {
        return itemFullNameToast;
    }
    itemFullNameToast = document.createElement('div');
    itemFullNameToast.className = 'item-full-name-toast';
    itemFullNameToast.setAttribute('role', 'status');
    itemFullNameToast.setAttribute('aria-live', 'polite');
    document.body.appendChild(itemFullNameToast);
    return itemFullNameToast;
}

function showItemFullNameToast(itemLabel, autoHideMs = 2600) {
    const toast = ensureItemToastElement();
    const fullName = itemLabel.getAttribute('data-item-full-name') || itemLabel.getAttribute('title') || '';
    const aliasText = (itemLabel.textContent || '').trim();
    if (!fullName) return;

    toast.textContent = (aliasText && aliasText !== fullName)
        ? `💎 ${aliasText} → ${fullName}`
        : `💎 ${fullName}`;
    toast.classList.add('visible');

    window.clearTimeout(itemFullNameToastTimer);
    if (autoHideMs > 0) {
        itemFullNameToastTimer = window.setTimeout(() => {
            toast.classList.remove('visible');
        }, autoHideMs);
    }
}

function hideItemFullNameToast() {
    if (!itemFullNameToast) return;
    window.clearTimeout(itemFullNameToastTimer);
    itemFullNameToast.classList.remove('visible');
}

document.addEventListener('mouseover', event => {
    const itemLabel = event.target instanceof Element
        ? event.target.closest('.item-alias-label')
        : null;
    if (itemLabel) {
        showItemFullNameToast(itemLabel, 0);
    }
});

document.addEventListener('mouseout', event => {
    const itemLabel = event.target instanceof Element
        ? event.target.closest('.item-alias-label')
        : null;
    if (itemLabel) {
        const related = event.relatedTarget instanceof Element
            ? event.relatedTarget.closest('.item-alias-label')
            : null;
        if (related !== itemLabel) {
            hideItemFullNameToast();
        }
    }
});

document.addEventListener('touchend', event => {
    const itemLabel = event.target instanceof Element
        ? event.target.closest('.item-alias-label')
        : null;
    if (!itemLabel) {
        hideItemFullNameToast();
        return;
    }
    showItemFullNameToast(itemLabel, 2600);
}, { passive: true });