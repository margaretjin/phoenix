-- 기존 테이블 삭제 후 재생성 (초기화 및 구조 변경)
DROP TABLE IF EXISTS raid_logs CASCADE;
DROP TABLE IF EXISTS members CASCADE;

-- 1. 회원 테이블
CREATE TABLE IF NOT EXISTS members (
    id SERIAL PRIMARY KEY,
    unique_id TEXT UNIQUE NOT NULL,          -- 고유 아이디
    active_id TEXT UNIQUE NOT NULL,          -- 사용중인 아이디
    char_class TEXT NOT NULL DEFAULT '기사', -- 클래스 (기사, 법사, 요정)
    skills JSONB DEFAULT '[]'::jsonb,        -- 보유 기술 배열
    clan TEXT NOT NULL DEFAULT '피닉스',     -- 혈맹 (피닉스, 미가입, 보류)
    sub_chars TEXT DEFAULT '',               -- 보유 쫄캐릭 아이디
    role TEXT NOT NULL DEFAULT '일반회원',   -- 권한 (슈퍼관리자, 관리자, 일반회원)
    google_email TEXT UNIQUE                 -- 1:1 매칭된 구글 이메일
);

-- 2. 보스탐 기록 테이블 (여러 파티 구조 지원: parties JSONB 배열)
CREATE TABLE IF NOT EXISTS raid_logs (
    id SERIAL PRIMARY KEY,
    raid_date TEXT NOT NULL,                 -- 날짜 (YYYY-MM-DD)
    raid_time TEXT NOT NULL,                 -- 보스탐 시간 (16개 타임)
    dropped_items TEXT DEFAULT '',           -- 드랍 아이템 (관리자 이상 입력)
    parties JSONB DEFAULT '[]'::jsonb,       -- 파티별 데이터 ([{"leader": "월은", "members": ["김스턴", "꽃씨"]}, ...])
    created_by TEXT DEFAULT '',
    UNIQUE(raid_date, raid_time)
);

-- 초기 샘플 데이터
INSERT INTO members (unique_id, active_id, char_class, skills, clan, sub_chars, role)
VALUES 
('UID_001', '월은', '요정', '["트리플", "소울", "왕바람", "소프"]', '피닉스', '월은쫄1, 월은법사', '슈퍼관리자'),
('UID_002', '꽃씨', '법사', '["뮨", "캔", "미티어"]', '피닉스', '꽃씨요정', '관리자'),
('UID_003', '검성', '기사', '["스턴", "리덕션", "바운스"]', '피닉스', '', '일반회원')
ON CONFLICT (unique_id) DO NOTHING;