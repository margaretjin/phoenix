// =========================================================
// [common.js] 전역 상태 + 전 페이지 공통 유틸리티
//  - 로그인/네비게이션/관리자 모드
//  - 초기 데이터(혈비율·아이템·회원) 1회 로딩: ClanApp.loadMeta()
//  - 날짜·아이템·분배상태 계산, API 저장 헬퍼, 배지, 자동완성
// =========================================================
window.ClanApp = {
    user: null,
    role: '일반회원',
    isSuperAdmin: false,
    hasAdminPrivilege: false,
    isAdminModeOn: false,

    // ---- 초기 데이터 (loadMeta 로 채워짐) ----
    taxRate: 20,
    items: [],
    members: [],
    priceMap: Object.create(null),        // 아이템명 -> 내판가
    itemNameMap: Object.create(null),     // 소문자(아이템명/별칭) -> 아이템명
    itemAliases: Object.create(null),     // 소문자 아이템명 -> 대표 별칭(표시용)
    eventItems: Object.create(null),      // 이벤트템(분배금 0원)
    clanOwnedItems: Object.create(null),  // 혈비귀속(분배금 제외)
    aliasMap: Object.create(null),        // 소문자(본캐/보조캐) -> 본캐
    charPool: [],                         // 자동완성 후보 [{charId, labelInfo, searchKey}]
    charSet: new Set(),                   // 소문자 본캐/보조캐 전체
    subMap: Object.create(null),          // 본캐 -> 본인 캐릭터 후보 목록

    RAID_TIMES: [
        '01시', '03시', '05시', '06시', '07시', '09시', '11시', '12시',
        '13시', '15시', '17시', '18시', '19시', '21시', '23시(오만)', '24시', '용레이드'
    ],
    SIEGE_TIME: '공성',                    // 일요일에만 용레이드 옆에 추가
    MAIN_RAID_TIMES: ['09시', '15시', '21시', '23시(오만)', '03시'],
    WEEKDAYS: ['일', '월', '화', '수', '목', '금', '토'],

    // 보유상태 / 분배상태 → 배지 색상
    HOLD_TONE: { 보유중: 'amber', 내판: 'blue', 외판: 'green', 연합: 'teal', 이벤트: 'purple', 성세금포함: 'indigo', 분배금혈귀: 'rose' },
    DIST_TONE: {
        분배대기: 'amber', 연합분배대기: 'amber', 분배시작: 'sky', 분배중: 'blue',
        분배완료: 'gray', 수령완료: 'gray', 연합: 'teal', 혈비귀속: 'teal',
        이벤트: 'purple', 이벤트템: 'purple', 성세금포함: 'indigo', 분배금혈귀: 'rose'
    },

    // =====================================================
    // 페이지 초기화 / 네비게이션
    // =====================================================
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
            { href: '/attendance', label: '참여도' },
            { href: '/bids', label: '입찰' },
            { href: '/finance', label: '재정' }
        ];

        const adminTabs = [];
        if (this.hasAdminPrivilege && (this.isAdminModeOn || activePath === '/admin')) {
            adminTabs.push({ href: '/admin', label: '혈맹원관리' });
        }
        adminTabs.push({ href: '/member-list', label: '명단' });
        adminTabs.push({ href: '/item-manage', label: '아이템' });

        const linkHtml = (l, cls) => `<a href="${l.href}" class="${cls} ${activePath === l.href ? 'active' : ''}">${l.label}</a>`;
        const adminToggleHtml = this.hasAdminPrivilege
            ? `<button id="adminModeBtn" type="button" onclick="ClanApp.toggleAdminMode()" class="admin-mode-toggle ${this.isAdminModeOn ? 'active' : ''}">
                 👑 관리자 ${this.isAdminModeOn ? 'ON' : 'OFF'}
               </button>`
            : '';

        nav.innerHTML = `
            <div class="nav-inner-container">
                <div class="nav-top-bar">
                    <div class="nav-user-box">
                        <span class="nav-user-name">${this.escapeHtml(this.user.active_id)} <small>(${this.escapeHtml(this.role)})</small></span>
                        <button type="button" onclick="ClanApp.logout()" class="btn-logout-mini">로그아웃</button>
                    </div>
                    <div class="nav-admin-box">
                        ${adminTabs.map(l => linkHtml(l, 'nav-admin-link')).join('')}
                        ${adminToggleHtml}
                    </div>
                </div>
                <div class="nav-menu-grid cols-${links.length}">
                    ${links.map(l => linkHtml(l, 'nav-link')).join('')}
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

    // =====================================================
    // 네트워크 헬퍼
    // =====================================================
    async getJSON(url, fallback = null) {
        try {
            const res = await fetch(url);
            if (!res.ok) return fallback;
            return await res.json();
        } catch (e) {
            return fallback;
        }
    },

    // 성공 시 응답 JSON(객체), 실패 시 알림 후 null
    async send(url, { method = 'POST', body = null, failMsg = '요청 처리 중 오류가 발생했습니다.' } = {}) {
        try {
            const opts = { method };
            if (body !== null) {
                opts.headers = { 'Content-Type': 'application/json' };
                opts.body = JSON.stringify(body);
            }
            const res = await fetch(url, opts);
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                alert(data.detail || failMsg);
                return null;
            }
            return data || {};
        } catch (e) {
            alert('서버 통신 오류가 발생했습니다.');
            return null;
        }
    },

    del(url, failMsg = '삭제 실패') {
        return this.send(url, { method: 'DELETE', failMsg });
    },

    roleParam(key = 'role') {
        return `${key}=${encodeURIComponent(this.role)}`;
    },

    saveRaid(payload, failMsg = '저장 중 오류가 발생했습니다.') {
        return this.send('/api/raids', { body: payload, failMsg });
    },

    saveItemDetails(raidId, details, failMsg = '저장 실패') {
        return this.send('/api/raids/item-details', {
            body: { raid_id: raidId, item_details: details.map(d => this.toDetailPayload(d)), requester_role: this.role },
            failMsg
        });
    },

    saveDistributions(raidId, distributions, failMsg = '분배 정보 저장 실패') {
        return this.send('/api/raids/distributions', {
            body: { raid_id: raidId, distributions, requester_role: this.role },
            failMsg
        });
    },

    fetchRaids(params = {}) {
        const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString();
        return this.getJSON(`/api/raids${qs ? `?${qs}` : ''}`, []);
    },

    // 혈비율 + 아이템 목록 + 회원 명단을 한 번에 로딩 (/api/meta, 없으면 기존 API로 대체)
    async loadMeta() {
        let data = await this.getJSON('/api/meta', null);
        if (!data) {
            const [tax, items, members] = await Promise.all([
                this.getJSON('/api/raids/tax-rate', {}),
                this.getJSON('/api/items', []),
                this.getJSON('/api/auth/search-members', [])
            ]);
            data = { tax_rate: (tax || {}).tax_rate, items, members };
        }
        this.taxRate = Number(data.tax_rate ?? 20);
        this.setItemAliases(data.items || []);
        this.setMembers(data.members || []);
        return data;
    },

    // =====================================================
    // 날짜 유틸
    // =====================================================
    formatYMD(d = new Date()) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    },

    formatYM(d = new Date()) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    },

    today() {
        return this.formatYMD(new Date());
    },

    parseYMD(dateStr) {
        const [y, m, d] = String(dateStr).split('-').map(Number);
        return new Date(y, m - 1, d);
    },

    shiftDate(dateStr, offset) {
        const d = this.parseYMD(dateStr);
        d.setDate(d.getDate() + offset);
        return this.formatYMD(d);
    },

    // 2026-11-23 → 26-11-23
    toShortDate(dateStr) {
        if (!dateStr || dateStr.length < 8) return '-';
        return dateStr.length >= 10 ? dateStr.slice(2, 10) : dateStr;
    },

    // 26-11-17 화 06시
    formatHeaderLabel(dateStr, timeLabel) {
        const wd = this.WEEKDAYS[this.parseYMD(dateStr).getDay()];
        return `${dateStr.slice(2)} ${wd} ${timeLabel}`;
    },

    getWeekRange(dateStr) {
        const base = this.parseYMD(dateStr);
        const dow = (base.getDay() + 6) % 7;
        return { start: this.shiftDate(dateStr, -dow), end: this.shiftDate(dateStr, 6 - dow) };
    },

    getPlusSevenDaysRange(startDateStr) {
        const start = startDateStr;
        const end = this.shiftDate(startDateStr, 7);
        const shortLabel = `${start.slice(2).replace(/-/g, '.')}~${end.slice(2).replace(/-/g, '.')}`;
        return { start, end, shortLabel };
    },

    getRaidTimes(dateStr) {
        const times = this.RAID_TIMES.slice();
        if (dateStr && this.parseYMD(dateStr).getDay() === 0) times.push(this.SIEGE_TIME);
        return times;
    },

    slotAttr(t) {
        return (t === '용레이드' || t === this.SIEGE_TIME) ? ` data-slot="${t}"` : '';
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
            if (slotHour !== null && slotHour <= currentHour) selected = slot;
        }
        return selected;
    },

    getSlotStatus(dateStr, timeLabel, now = new Date()) {
        const hourNum = this.parseRaidHour(timeLabel);
        if (hourNum === null) return 'open';
        const slotTime = this.parseYMD(dateStr);
        slotTime.setHours(hourNum, 0, 0, 0);
        const diffHours = (now - slotTime) / (1000 * 60 * 60);
        if (diffHours < 0) return 'future';
        if (diffHours <= 3.0) return 'open';
        return 'expired';
    },

    // 혈비 공제 후 금액
    netOf(price) {
        return Math.floor(Number(price || 0) * (1 - this.taxRate / 100));
    },

    // =====================================================
    // 아이템 / 회원 디렉터리
    // =====================================================
    splitTokens(text) {
        return String(text || '').split(/[\s,，]+/).map(t => t.trim()).filter(Boolean);
    },

    splitCsv(text) {
        return String(text || '').split(/[,，]+/).map(t => t.trim()).filter(Boolean);
    },

    setItemAliases(items = []) {
        const aliases = Object.create(null);
        const owned = Object.create(null);
        const events = Object.create(null);
        const prices = Object.create(null);
        const names = Object.create(null);
        items.forEach(item => {
            const fullName = String(item.item_name || '').trim();
            if (!fullName) return;
            const low = fullName.toLowerCase();
            const aliasList = this.splitCsv(item.aliases);
            if (item.clan_owned) owned[low] = true;
            if (item.event_item) events[low] = true;
            prices[fullName] = Number(item.default_price || 0);
            names[low] = fullName;
            aliasList.forEach(a => { names[a.toLowerCase()] = fullName; });
            aliases[low] = aliasList[0] || fullName;
        });
        this.items = items;
        this.itemAliases = aliases;
        this.clanOwnedItems = owned;
        this.eventItems = events;
        this.priceMap = prices;
        this.itemNameMap = names;
    },

    setMembers(members = []) {
        const aliasMap = Object.create(null);
        const subMap = Object.create(null);
        const pool = [];
        const set = new Set();
        const seen = new Set();

        members.forEach(m => {
            const mainId = String(m.active_id || '').trim();
            if (!mainId) return;
            const subs = this.splitCsv(m.sub_chars);
            const ownList = [
                { charId: mainId, labelInfo: `${m.char_class || ''} · 본캐`, searchKey: `${mainId} ${subs.join(' ')}`.toLowerCase() },
                ...subs.map(subId => ({ charId: subId, labelInfo: `쫄 (본캐: ${mainId})`, searchKey: `${subId} ${mainId}`.toLowerCase() }))
            ];
            subMap[mainId] = ownList;
            aliasMap[mainId.toLowerCase()] = mainId;
            subs.forEach(s => { aliasMap[s.toLowerCase()] = mainId; });
            ownList.forEach(entry => {
                const low = entry.charId.toLowerCase();
                set.add(low);
                if (!seen.has(low)) {
                    seen.add(low);
                    pool.push(entry);
                }
            });
        });

        this.members = members;
        this.aliasMap = aliasMap;
        this.subMap = subMap;
        this.charPool = pool;
        this.charSet = set;
    },

    isClanChar(name) {
        return this.charSet.has(String(name || '').trim().toLowerCase());
    },

    // 자동완성: 캐릭터명이 직접 일치하는 항목을 먼저
    searchChars(q, limit = 12) {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return [];
        return this.charPool.filter(e => e.searchKey.includes(query))
            .sort((a, b) => (a.charId.toLowerCase().includes(query) ? 0 : 1) - (b.charId.toLowerCase().includes(query) ? 0 : 1))
            .slice(0, limit);
    },

    findSuggestedItem(token) {
        const lower = String(token).toLowerCase();
        for (const key of Object.keys(this.itemNameMap)) {
            if (key.includes(lower) || lower.includes(key)) return this.itemNameMap[key];
        }
        return null;
    },

    // 입력 토큰 → 아이템 목록 매칭 결과
    resolveItemTokens(text) {
        const hasMaster = Object.keys(this.itemNameMap).length > 0;
        return this.splitTokens(text).map(tok => {
            const main = this.itemNameMap[tok.toLowerCase()] || null;
            if (main) return { raw: tok, name: main, isMatched: true, suggestion: null };
            if (!hasMaster) return { raw: tok, name: tok, isMatched: true, suggestion: null };
            return { raw: tok, name: tok, isMatched: false, suggestion: this.findSuggestedItem(tok) };
        });
    },

    isEventItem(name) {
        return Boolean(this.eventItems[String(name || '').trim().toLowerCase()]);
    },

    isClanOwnedItem(name) {
        return Boolean(this.clanOwnedItems[String(name || '').trim().toLowerCase()]);
    },

    getItemAlias(fullName) {
        const name = String(fullName || '').trim();
        return this.itemAliases[name.toLowerCase()] || name;
    },

    itemMatches(name, kw) {
        if (!kw) return true;
        return String(name).toLowerCase().includes(kw) || this.getItemAlias(name).toLowerCase().includes(kw);
    },

    isCastleTaxItem(name) {
        const n = String(name || '').trim();
        return n === '성세금' || this.getItemAlias(n) === '성세금';
    },

    // =====================================================
    // HTML 헬퍼
    // =====================================================
    escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    },

    // onclick="fn(${ClanApp.jsArg(x)})" 처럼 인라인 핸들러 인자로 안전하게 넣기
    jsArg(value) {
        return this.escapeHtml(JSON.stringify(String(value ?? '')));
    },

    itemNameHtml(fullName) {
        const name = String(fullName || '').trim();
        const safeName = this.escapeHtml(name);
        const alias = this.escapeHtml(this.getItemAlias(name));
        return `<span class="item-alias-label" data-item-full-name="${safeName}" title="${safeName}">${alias}</span>`;
    },

    badge(label, tone = 'gray', extraClass = '', id = '') {
        return `<span${id ? ` id="${id}"` : ''} class="badge badge-${tone}${extraClass ? ` ${extraClass}` : ''}">${this.escapeHtml(label)}</span>`;
    },

    // 같은 이름 n개 → "이름 ×n" 칩 목록
    countChips(names, chipClass) {
        const countMap = new Map();
        names.forEach(n => countMap.set(n, (countMap.get(n) || 0) + 1));
        return [...countMap.entries()].map(([n, c]) =>
            `<span class="${chipClass}">${this.itemNameHtml(n)}${c > 1 ? ` ×${c}` : ''}</span>`).join('');
    },

    // <div id="..."> 안의 .tab-btn[data-tab] 중 key 와 같은 버튼만 active
    setActiveTab(containerId, key) {
        const box = document.getElementById(containerId);
        if (!box) return;
        box.querySelectorAll('.tab-btn[data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === key));
    },

    uniqueMembers(leader, members) {
        const seen = new Set([leader]);
        const out = [];
        (members || []).forEach(m => {
            if (m && !seen.has(m)) { seen.add(m); out.push(m); }
        });
        return out;
    },

    // =====================================================
    // 보스탐 기록 / 아이템 상세 계산
    // =====================================================
    toDetailPayload(it, overrides = {}) {
        return Object.assign({
            name: it.name,
            sale_type: it.sale_type || '보유중',
            alliance: it.alliance || '',
            price: Number(it.price || 0),
            winner: it.winner || '',
            taken_date: it.taken_date || '',
            dist_date: it.dist_date || '',
            dist_checked: Boolean(it.dist_checked),
            castle_tax_date: it.castle_tax_date || ''
        }, overrides);
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

    participantIds(record) {
        return this.extractParticipants(record).map(p => p.id);
    },

    extractItemDetails(record, priceMap = this.priceMap) {
        if (!record) return [];
        const rawTokens = (record.dropped_items || '').split(/[\s,，\n]+/).map(s => s.trim()).filter(Boolean);
        const savedDetails = Array.isArray(record.item_details) ? record.item_details : [];

        const resolveItemObj = (name, foundObj) => {
            const policyPrice = Number(priceMap[name] || 0);
            const winner = foundObj ? (foundObj.winner || '').trim() : '';
            const rawSaleType = foundObj && foundObj.sale_type ? foundObj.sale_type : '보유중';
            const savedPrice = foundObj ? Number(foundObj.price || 0) : 0;
            const alliance = foundObj ? String(foundObj.alliance || '').trim() : '';
            const castleTaxDate = foundObj ? String(foundObj.castle_tax_date || '').trim() : '';
            const takenDate = (foundObj && winner) ? (foundObj.taken_date || '') : '';
            const keepPrice = savedPrice > 0 ? savedPrice : policyPrice;

            let sType = '보유중';
            let finalPrice = keepPrice;

            if (alliance === '반항' || alliance === '세븐') {
                sType = '연합';
            } else if (alliance === '피닉스') {
                if (rawSaleType === '이벤트') {
                    sType = '이벤트';
                    finalPrice = 0;
                } else if (['성세금포함', '분배금혈귀', '내판', '외판'].includes(rawSaleType)) {
                    sType = rawSaleType;
                }
            } else if (winner) {
                if (rawSaleType === '이벤트' || savedPrice === 0) {
                    sType = '이벤트';
                    finalPrice = 0;
                } else {
                    sType = (rawSaleType === '외판' || rawSaleType === '연합') ? rawSaleType : '내판';
                }
            }

            const base = { name, policy_price: policyPrice, winner, taken_date: takenDate, alliance };

            if (this.isEventItem(name)) {
                return { ...base, sale_type: '이벤트', price: 0, dist_date: '', dist_checked: false, castle_tax_date: '', event_item: true };
            }
            if (this.isClanOwnedItem(name)) {
                return { ...base, sale_type: '연합', price: policyPrice, dist_date: '', dist_checked: false, castle_tax_date: '', clan_owned: true };
            }

            // 성세금 아이템 및 성세금포함 아이템도 수령자 없이 체크(분배관리 연동) 가능
            const isCastleTax = this.isCastleTaxItem(name);
            const canDist = Boolean(foundObj && (
                (winner && (sType === '내판' || sType === '외판')) ||
                sType === '성세금포함' ||
                (isCastleTax && !['연합', '이벤트', '분배금혈귀'].includes(sType))
            ));
            const distDate = canDist ? (foundObj.dist_date || '') : '';

            return {
                ...base,
                sale_type: sType,
                price: finalPrice,
                dist_date: distDate,
                dist_checked: canDist ? Boolean(foundObj.dist_checked || distDate) : false,
                castle_tax_date: sType === '성세금포함' ? castleTaxDate : ''
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

    // '성세금포함' 아이템 금액을 지정된 날짜(없으면 가장 가까운 날짜)의 '성세금' 풀에 합산
    // bonusMap: 성세금 아이템 key -> 합산 정보 / sourceMap: 성세금포함 아이템 key -> 합산 대상 성세금 정보
    _resolveCastleTax(raids = [], priceMap = this.priceMap) {
        const taxTargets = [];
        const includedEntries = [];

        (raids || []).forEach(r => {
            this.extractItemDetails(r, priceMap).forEach((item, idx) => {
                if (this.isCastleTaxItem(item.name)) {
                    taxTargets.push({ key: `${r.id}_${idx}`, raid_id: r.id, raid_date: r.raid_date || '' });
                } else if (item.sale_type === '성세금포함') {
                    includedEntries.push({
                        source_key: `${r.id}_${idx}`,
                        name: item.name,
                        price: Number(item.price || 0),
                        raid_date: r.raid_date || '',
                        raid_time: r.raid_time || '',
                        castle_tax_date: (item.castle_tax_date || '').trim()
                    });
                }
            });
        });

        taxTargets.sort((a, b) => a.raid_date.localeCompare(b.raid_date) || (a.raid_id - b.raid_id));

        const bonusMap = Object.create(null);
        const sourceMap = Object.create(null);
        if (taxTargets.length === 0) return { bonusMap, sourceMap };

        includedEntries.forEach(entry => {
            let target = null;
            if (entry.castle_tax_date) {
                target = taxTargets.find(t => t.raid_date === entry.castle_tax_date) || null;
            } else {
                target = taxTargets.find(t => t.raid_date >= entry.raid_date);
                if (!target) {
                    const ym = entry.raid_date.slice(0, 7);
                    const sameMonth = taxTargets.filter(t => t.raid_date.startsWith(ym));
                    target = sameMonth.length ? sameMonth[sameMonth.length - 1] : taxTargets[taxTargets.length - 1];
                }
            }
            if (!target) return;
            if (!bonusMap[target.key]) bonusMap[target.key] = { bonusPrice: 0, includedItems: [] };
            bonusMap[target.key].bonusPrice += entry.price;
            bonusMap[target.key].includedItems.push(entry);
            sourceMap[entry.source_key] = { target_key: target.key, target_raid_id: target.raid_id };
        });

        return { bonusMap, sourceMap };
    },

    buildCastleTaxMaps(raids = [], priceMap = this.priceMap) {
        return this._resolveCastleTax(raids, priceMap);
    },

    buildCastleTaxBonusMap(raids = [], priceMap = this.priceMap) {
        return this._resolveCastleTax(raids, priceMap).bonusMap;
    },

    buildCastleTaxSourceMap(raids = [], priceMap = this.priceMap) {
        return this._resolveCastleTax(raids, priceMap).sourceMap;
    },

    // 성세금포함 아이템의 분배 대상이 되는 공성 기록 찾기
    findSiegeRaid(allRaids, sourceMap, raid, idx, item) {
        const src = sourceMap[`${raid.id}_${idx}`];
        let siegeRaid = src ? allRaids.find(x => x.id === src.target_raid_id) : null;
        if (!siegeRaid && item.castle_tax_date) {
            siegeRaid = allRaids.find(x => x.raid_date === item.castle_tax_date && x.raid_time === this.SIEGE_TIME) || null;
        }
        return siegeRaid || null;
    },

    // 분배관리 대상 아이템 목록 (분배관리 · 재정 페이지 공용)
    // 체크된 아이템 + 성세금포함 합산분이 있는 성세금 + 성세금포함 아이템
    buildDistEntries(allRaids = []) {
        const entries = [];
        const { bonusMap, sourceMap } = this.buildCastleTaxMaps(allRaids);
        const todayStr = this.today();

        allRaids.forEach(r => {
            const details = this.extractItemDetails(r);
            const participants = this.extractParticipants(r);

            details.forEach((item, idx) => {
                const entryKey = `${r.id}_${idx}`;
                const bonusInfo = this.isCastleTaxItem(item.name) ? bonusMap[entryKey] : null;
                const hasIncludedBonus = Boolean(bonusInfo && bonusInfo.includedItems.length > 0);
                const isIncludedType = item.sale_type === '성세금포함';
                if (!item.dist_checked && !hasIncludedBonus && !isIncludedType) return;

                // 합산 대상 성세금 아이템이 없으면 → 성세금포함 아이템을 공성 참여자 대상 일반 항목처럼 분배
                const isCastleTaxIncluded = isIncludedType && Boolean((sourceMap[entryKey] || {}).target_key);
                // 성세금포함 아이템의 분배 대상은 드랍탐이 아니라 해당 일자 공성 참여자
                const siegeParticipants = isIncludedType
                    ? this.extractParticipants(this.findSiegeRaid(allRaids, sourceMap, r, idx, item))
                    : null;
                const effParticipants = siegeParticipants || participants;
                const effCount = effParticipants.length;

                // 혈분배일 미지정 성세금(합산분 있음)은 오늘 날짜를 혈분배일로 간주
                const distDate = (item.dist_date || '').trim() || (hasIncludedBonus ? todayStr : '');
                const hasDistDate = Boolean(distDate);
                const doneMemberCount = (hasDistDate && !isCastleTaxIncluded)
                    ? this.countDistDone(r, idx, distDate, effParticipants).done
                    : 0;

                const isFullyDone = isCastleTaxIncluded || (hasDistDate && effCount > 0 && doneMemberCount === effCount);
                const itemState = isCastleTaxIncluded ? 'done' : (!hasDistDate ? 'wait' : (isFullyDone ? 'done' : 'progress'));

                const basePrice = Number(item.price || 0);
                const bonusPrice = bonusInfo ? bonusInfo.bonusPrice : 0;
                const price = basePrice + bonusPrice;
                const netPool = isCastleTaxIncluded ? 0 : this.netOf(price);
                const infoNet = isCastleTaxIncluded ? this.netOf(price) : 0;

                entries.push({
                    key: entryKey,
                    raid_id: r.id,
                    item_idx: idx,
                    raid_date: r.raid_date,
                    raid_time: r.raid_time,
                    name: item.name,
                    is_castle_tax_included: isCastleTaxIncluded,
                    castle_tax_date: item.castle_tax_date || '',
                    target_key: isCastleTaxIncluded ? sourceMap[entryKey].target_key : '',
                    base_price: basePrice,
                    bonus_price: bonusPrice,
                    included_items: bonusInfo ? bonusInfo.includedItems : [],
                    price,
                    net_pool: netPool,
                    info_net: infoNet,
                    info_share: (isCastleTaxIncluded && effCount > 0) ? Math.floor(infoNet / effCount) : 0,
                    per_share: (!isCastleTaxIncluded && effCount > 0 && netPool > 0) ? Math.floor(netPool / effCount) : 0,
                    dist_date: distDate,
                    item_state: itemState,
                    is_done: isFullyDone,
                    done_count: doneMemberCount,
                    participants: effParticipants,
                    raid_ref: r,
                    full_details_ref: details
                });
            });
        });
        return entries;
    },

    // 참여자 1명의 분배 정보 (혈분배일 키 → 아이템 키 → 구버전 키 순서)
    getDistInfo(raid, itemIdx, itemDistDate, memberId, defaultProxy = memberId) {
        const distMap = (raid && raid.distributions) || {};
        const dDate = (itemDistDate || '').trim();
        const waiting = { status: '분배대기', method: '본인수령', proxy_name: defaultProxy, paid_date: '' };

        if (dDate && distMap[`${memberId}__date_${dDate}`]) return distMap[`${memberId}__date_${dDate}`];
        if (distMap[`${memberId}__item_${itemIdx}`]) return distMap[`${memberId}__item_${itemIdx}`];

        const legacy = distMap[memberId];
        if (!legacy) return waiting;
        if (legacy.status === '분배완료') {
            const paidDate = (legacy.paid_date || '').trim();
            if (paidDate && dDate && dDate > paidDate) return waiting;
        }
        return legacy;
    },

    // 아이템 1개의 분배완료 인원 / 전체 인원
    countDistDone(raid, itemIdx, distDate, participants = null) {
        const list = participants || this.extractParticipants(raid);
        const dDate = (distDate || '').trim();
        let done = 0;
        if (dDate) {
            list.forEach(p => {
                if (this.getDistInfo(raid, itemIdx, dDate, p.id).status === '분배완료') done++;
            });
        }
        return { done, total: list.length };
    },

    // 내판/외판/성세금 분배 진행 단계: 분배대기 → 분배시작 → 분배중(n/m) → 분배완료(n/m)
    distProgress(raid, item, itemIdx) {
        const distDate = (item.dist_date || '').trim();
        const isChecked = Boolean(item.dist_checked || distDate);
        const { done, total } = this.countDistDone(raid, itemIdx, distDate);
        if (!isChecked) return { state: '분배대기', label: '분배대기', done, total };
        if (!distDate) return { state: '분배시작', label: '분배시작', done, total };
        if (total > 0 && done === total) return { state: '분배완료', label: `분배완료(${done}/${total})`, done, total };
        return { state: '분배중', label: `분배중(${done}/${total})`, done, total };
    },

    // =====================================================
    // 아이디 자동완성 드롭다운 (.suggest-wrap > input + .suggest-list)
    // =====================================================
    suggest: {
        open(box, entries, onPick) {
            if (!box) return;
            document.querySelectorAll('.suggest-list').forEach(el => { if (el !== box) ClanApp.suggest.close(el); });
            if (!entries || entries.length === 0) return ClanApp.suggest.close(box);
            box.innerHTML = entries.map((e, idx) => `
                <div class="suggest-item ${idx === 0 ? 'active' : ''}" data-char-id="${ClanApp.escapeHtml(e.charId)}">
                    <span class="suggest-main">${ClanApp.escapeHtml(e.charId)}</span>
                    <span class="suggest-sub">${ClanApp.escapeHtml(e.labelInfo)}</span>
                </div>`).join('');
            box.dataset.idx = '0';
            box._onPick = onPick;
            box.onmousedown = (ev) => {
                const item = ev.target.closest('.suggest-item');
                if (!item) return;
                ev.preventDefault();
                ev.stopPropagation();
                ClanApp.suggest.pick(box, item.getAttribute('data-char-id'));
            };
            box.classList.remove('hidden');
            ClanApp.suggest.place(box);
        },

        // 입력창 바로 아래(공간이 없으면 위)에 목록 배치 — 표 스크롤 영역에 잘리지 않도록 화면 기준 좌표 사용
        place(box) {
            const wrap = box.closest('.suggest-wrap');
            const input = wrap ? wrap.querySelector('input') : null;
            if (!input) return;
            const r = input.getBoundingClientRect();
            const h = box.offsetHeight;
            const below = window.innerHeight - r.bottom;
            box.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - box.offsetWidth - 4))}px`;
            box.style.top = (below < h + 8 && r.top > h + 8) ? `${r.top - h - 3}px` : `${r.bottom + 3}px`;
        },

        close(box) {
            if (!box) return;
            box.innerHTML = '';
            box.dataset.idx = '-1';
            box.classList.add('hidden');
        },

        isOpen(box) {
            return Boolean(box && !box.classList.contains('hidden') && box.querySelector('.suggest-item'));
        },

        pick(box, charId) {
            const onPick = box._onPick;
            ClanApp.suggest.close(box);
            if (typeof onPick === 'function' && charId) onPick(charId);
        },

        // 방향키/엔터/ESC 처리. 엔터로 후보를 골랐으면 true
        handleKey(event, box) {
            if (event.isComposing || event.keyCode === 229) return false;
            const items = box ? [...box.querySelectorAll('.suggest-item')] : [];
            const open = ClanApp.suggest.isOpen(box);
            let cur = Number(box && box.dataset.idx) || 0;

            if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && open) {
                event.preventDefault();
                cur = (cur + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
                box.dataset.idx = String(cur);
                items.forEach((el, idx) => el.classList.toggle('active', idx === cur));
                items[cur].scrollIntoView({ block: 'nearest' });
            } else if (event.key === 'Enter' && open) {
                event.preventDefault();
                const target = items[cur >= 0 && cur < items.length ? cur : 0];
                ClanApp.suggest.pick(box, target.getAttribute('data-char-id'));
                return true;
            } else if (event.key === 'Escape' && box) {
                ClanApp.suggest.close(box);
            }
            return false;
        }
    },

    // =====================================================
    // 팝업창 (모달): .modal 바깥 클릭 · ESC · [data-close-modal] 버튼으로 닫힘
    // =====================================================
    modal: {
        open(id) {
            const el = document.getElementById(id);
            if (!el) return;
            el.classList.remove('hidden');
            document.body.classList.add('modal-open');
            const first = el.querySelector('input:not([type=hidden]):not([disabled]), select, textarea');
            if (first) setTimeout(() => first.focus(), 30);
        },
        close(id) {
            const el = id ? document.getElementById(id) : null;
            (el ? [el] : document.querySelectorAll('.modal:not(.hidden)')).forEach(m => m.classList.add('hidden'));
            if (!document.querySelector('.modal:not(.hidden)')) document.body.classList.remove('modal-open');
        }
    },

    // =====================================================
    // 엑셀(CSV) 다운로드
    // =====================================================
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
    },

    // kind: day | week | month | all,  weekRange: 주간 범위 함수(기본 월~일)
    exportExcel(kind, refDate, refMonth = '', weekRange = null) {
        if (!this.isAdminModeOn) return;
        const date = refDate || this.today();
        if (kind === 'day') return this.downloadExcel({ date });
        if (kind === 'week') return this.downloadExcel((weekRange || this.getWeekRange).call(this, date));
        if (kind === 'month') return this.downloadExcel({ month: refMonth || date.slice(0, 7) });
        return this.downloadExcel({});
    }
};

// document.getElementById 단축
window.$id = (id) => document.getElementById(id);

// 팝업창: 배경 클릭 / 닫기 버튼 / ESC
document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element)) return;
    if (e.target.classList.contains('modal')) ClanApp.modal.close(e.target.id);
    const closer = e.target.closest('[data-close-modal]');
    if (closer) ClanApp.modal.close(closer.closest('.modal').id);
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.modal:not(.hidden)')) ClanApp.modal.close();
});

// 자동완성 박스 바깥을 누르거나, 화면/표를 스크롤하면 닫기 (목록 자체 스크롤은 제외)
const closeAllSuggest = () => document.querySelectorAll('.suggest-list:not(.hidden)').forEach(el => ClanApp.suggest.close(el));
document.addEventListener('click', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.suggest-wrap')) closeAllSuggest();
});
document.addEventListener('scroll', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest('.suggest-list')) return;            // 목록 안 스크롤
    if (t) return closeAllSuggest();                         // 표 등 내부 영역 스크롤
    document.querySelectorAll('.suggest-list:not(.hidden)').forEach(el => ClanApp.suggest.place(el)); // 페이지 스크롤: 따라가기
}, true);
window.addEventListener('resize', () => {
    document.querySelectorAll('.suggest-list:not(.hidden)').forEach(el => ClanApp.suggest.place(el));
});

// ---------------------------------------------------------
// 아이템 별칭 → 풀네임 토스트 (마우스오버 / 터치)
// ---------------------------------------------------------
(function initItemNameToast() {
    let toast = null;
    let timer = null;

    function ensureToast() {
        if (toast && document.body.contains(toast)) return toast;
        toast = document.createElement('div');
        toast.className = 'item-full-name-toast';
        toast.setAttribute('role', 'status');
        toast.setAttribute('aria-live', 'polite');
        document.body.appendChild(toast);
        return toast;
    }

    function show(label, autoHideMs) {
        const fullName = label.getAttribute('data-item-full-name') || label.getAttribute('title') || '';
        if (!fullName) return;
        const aliasText = (label.textContent || '').trim();
        const el = ensureToast();
        el.textContent = (aliasText && aliasText !== fullName) ? `💎 ${aliasText} → ${fullName}` : `💎 ${fullName}`;
        el.classList.add('visible');
        window.clearTimeout(timer);
        if (autoHideMs > 0) timer = window.setTimeout(() => el.classList.remove('visible'), autoHideMs);
    }

    function hide() {
        if (!toast) return;
        window.clearTimeout(timer);
        toast.classList.remove('visible');
    }

    const labelOf = (node) => (node instanceof Element ? node.closest('.item-alias-label') : null);

    document.addEventListener('mouseover', e => {
        const label = labelOf(e.target);
        if (label) show(label, 0);
    });

    document.addEventListener('mouseout', e => {
        const label = labelOf(e.target);
        if (label && labelOf(e.relatedTarget) !== label) hide();
    });

    document.addEventListener('touchend', e => {
        const label = labelOf(e.target);
        if (label) show(label, 2600);
        else hide();
    }, { passive: true });
})();
