import os
import json
import time
import datetime
import requests
import gspread
import uvicorn
import traceback
from google.oauth2.service_account import Credentials
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response

app = FastAPI(title="피닉스")

app.mount("/static", StaticFiles(directory="static"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

SCOPE = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

# 💡 [보안 업그레이드] credentials.json 또는 서버 환경변수에서 API 키 및 ID 안전하게 읽어오기
if "GOOGLE_CREDENTIALS" in os.environ:
    creds_info = json.loads(os.environ["GOOGLE_CREDENTIALS"])
else:
    json_path = os.path.join(os.path.dirname(__file__), "credentials.json")
    with open(json_path, "r", encoding="utf-8") as f:
        creds_info = json.load(f)

# 💡 private_key 문자열의 줄바꿈(\n) 오류 자동 복구 (PEM 에러 방지)
if "private_key" in creds_info:
    creds_info["private_key"] = creds_info["private_key"].replace("\\n", "\n")

CREDS = Credentials.from_service_account_info(creds_info, scopes=SCOPE)
client = gspread.authorize(CREDS)

# 1. 명부 스프레드시트 ID (인원 시트)
SPREADSHEET_ID = creds_info.get("SPREADSHEET_ID")
SHEET_NAME = "인원"

# 2. 분배금 정산 스프레드시트 ID
DIST_SPREADSHEET_ID = creds_info.get("DIST_SPREADSHEET_ID")
DIST_SHEET_NAME = "분배금정산"

# --- [Supabase REST API 연동 설정] ---
SUPABASE_URL = creds_info.get("SUPABASE_URL")
SUPABASE_KEY = creds_info.get("SUPABASE_KEY")

# --- [초경량 캐싱 시스템] (60초 주기) ---
CACHE_TTL = 60
_cache = {"rows": None, "timestamp": 0}
_dist_cache = {
    "f3_total_gold": 0.0,
    "c_start": "", "c_end": "",
    "d_start": "", "d_end": "",
    "timestamp": 0
}

def get_all_rows():
    now = time.time()
    if _cache["rows"] is None or (now - _cache["timestamp"]) > CACHE_TTL:
        try:
            doc = client.open_by_key(SPREADSHEET_ID)
            sheet = doc.worksheet(SHEET_NAME)
            _cache["rows"] = sheet.get_all_values()
            _cache["timestamp"] = now
            print(f"--- [시스템] 인원 시트 새로고침 완료 ({len(_cache['rows'])}행) ---")
        except Exception as e:
            if _cache["rows"] is not None:
                print("--- [경고] 인원 시트 연결 실패로 기존 캐시 반환 ---")
                return _cache["rows"]
            raise HTTPException(status_code=500, detail=f"인원 시트 로드 실패: {str(e)}")
    return _cache["rows"]

def get_distribution_config():
    """
    분배금정산 시트를 열어 F3(총 분배금), C2~C3(2주간 날짜), D2~D3(1주간 날짜)를 실시간 가져옵니다.
    """
    now = time.time()
    if (now - _dist_cache["timestamp"]) > CACHE_TTL or not _dist_cache["d_start"]:
        try:
            doc = client.open_by_key(DIST_SPREADSHEET_ID)
            sheet = doc.worksheet(DIST_SHEET_NAME)
            
            # F3 셀 추출 (총 분배금 액수)
            f3_str = str(sheet.acell("F3").value or "0")
            clean_f3 = "".join(c for c in f3_str if c.isdigit() or c == '.')
            _dist_cache["f3_total_gold"] = float(clean_f3) if clean_f3 else 0.0
            
            # C2, C3 추출 (2주간 날짜)
            _dist_cache["c_start"] = str(sheet.acell("C2").value or "").strip()
            _dist_cache["c_end"] = str(sheet.acell("C3").value or "").strip()
            
            # D2, D3 추출 (1주간 날짜 - 분배금 계산 기준)
            _dist_cache["d_start"] = str(sheet.acell("D2").value or "").strip()
            _dist_cache["d_end"] = str(sheet.acell("D3").value or "").strip()
            
            _dist_cache["timestamp"] = now
            print(f"--- [시스템] 분배금정산 시트 설정 동기화 완료 (F3 총분배금: {_dist_cache['f3_total_gold']:,.0f}) ---")
        except Exception as e:
            print(f"--- [경고] 분배금정산 시트 로드 실패: {str(e)} ---")
            
    return _dist_cache

def get_supabase_attendance_stats(user_id: str):
    """
    Supabase DB에서 유저 점수와 전체 혈맹원 점수를 조회하여 기여도(%)와 받을 분배금을 파이썬이 직접 연산합니다.
    오늘 참석한 보스탐 시각(Hour)을 추출하여 함께 반환합니다.
    """
    headers = {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}"
    }
    
    tz_kst = datetime.timezone(datetime.timedelta(hours=9))
    now_kst = datetime.datetime.now(tz_kst)
    today_str = now_kst.strftime("%Y-%m-%d")
    
    # 1. 엑셀 시트에서 기간 날짜 및 F3 총 분배금 설정 읽어오기
    config = get_distribution_config()
    f3_total_gold = config["f3_total_gold"]
    
    d_start = config["d_start"] or (now_kst - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
    d_end = config["d_end"] or today_str
    
    c_start = config["c_start"] or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
    c_end = config["c_end"] or today_str
    
    stats = {
        "today_count": 0,
        "today_points": 0.0,
        "today_hours": [],             # 🎯 당일 참여한 시각 목록 (예: [1, 5, 12, 23])
        "d_period_points": 0.0,        # D2~D3 (1주간) 유저 점수
        "c_period_points": 0.0,        # C2~C3 (2주간) 유저 점수
        "d_period_label": f"{d_start} ~ {d_end}",
        "c_period_label": f"{c_start} ~ {c_end}",
        "contribution_rate": 0.0,      # 총 분배금 기여도 (%)
        "total_distribution_gold": int(f3_total_gold),
        "distribution_gold": 0 
    }
    
    # 2. 💡 [전체 혈맹원 조회] 기여도 분모가 될 D2~D3 기간 '혈맹 전체 합산 점수' 연산
    total_guild_d_points = 0.0
    try:
        all_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=points&attendance_date=gte.{d_start}&attendance_date=lte.{d_end}"
        res_all = requests.get(all_url, headers=headers, timeout=5)
        if res_all.status_code == 200:
            for r in res_all.json():
                total_guild_d_points += float(r.get("points", 0) or 0)
    except Exception as e:
        print(f"--- [에러] 전체 혈맹 점수 조회 실패: {str(e)} ---")
        
    # 3. 💡 [개인 유저 조회] 검색된 유저의 C2~C3(2주) 및 D2~D3(1주) 및 오늘 점수/시간 조회
    try:
        user_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=attendance_date,attendance_time,created_at,points&user_id=ilike.{user_id}&attendance_date=gte.{c_start}&attendance_date=lte.{max(c_end, today_str)}"
        res_user = requests.get(user_url, headers=headers, timeout=5)
        if res_user.status_code == 200:
            for r in res_user.json():
                r_date = r.get("attendance_date", "")
                pts = float(r.get("points", 0) or 0)
                
                # C2 ~ C3 기간 점수 누적
                if c_start <= r_date <= c_end:
                    stats["c_period_points"] += pts
                    
                # D2 ~ D3 기간 점수 누적
                if d_start <= r_date <= d_end:
                    stats["d_period_points"] += pts
                    
                # 오늘 참여 횟수, 점수 및 시간대 추출
                if r_date == today_str:
                    stats["today_count"] += 1
                    stats["today_points"] += pts
                    
                    # 시간대(Hour) 추출 (attendance_time 컬럼 우선, 없으면 created_at 활용)
                    hour = None
                    if r.get("attendance_time"):
                        try:
                            time_str = str(r.get("attendance_time"))
                            hour = int(time_str.split(":")[0])
                        except Exception:
                            pass
                    elif r.get("created_at"):
                        try:
                            dt = datetime.datetime.fromisoformat(r.get("created_at").replace('Z', '+00:00')).astimezone(tz_kst)
                            hour = dt.hour
                        except Exception:
                            pass

                    # 24시 케이스 대응 (0시는 보통 24시로 표현)
                    if hour is not None:
                        if hour == 0:
                            hour = 24
                        if hour not in stats["today_hours"]:
                            stats["today_hours"].append(hour)

    except Exception as e:
        print(f"--- [에러] 유저 개인 점수 조회 실패 ({user_id}): {str(e)} ---")
        
    # 4. 💡 [기여도 및 분배금 자동 산출]
    if total_guild_d_points > 0 and stats["d_period_points"] > 0:
        # 기여도(%) = (유저의 1주간 점수 / 혈맹 전체 1주간 점수) * 100
        stats["contribution_rate"] = round((stats["d_period_points"] / total_guild_d_points) * 100, 2)
        # 받을 분배금 = F3 총 분배금 * (기여도 / 100)
        stats["distribution_gold"] = int(f3_total_gold * (stats["contribution_rate"] / 100))
        
    return stats

# --- 라우터 시작 ---
@app.api_route("/", methods=["GET", "HEAD"])
def read_index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "main.html"))

@app.get("//.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools():
    return Response(status_code=204)

@app.get("/kurtz.html")
def kurtz(): return FileResponse("kurtz.html")

@app.get("/fire.html")
def fire(): return FileResponse("fire.html")

@app.get("/dragon.html")
def dragon(): return FileResponse("dragon.html")

@app.get("/adena.html")
def adena(): return FileResponse("adena.html")

# --- 유저 검색 API ---
@app.get("/search/{name}")
def search_user(name: str):
    rows = get_all_rows()
    search = name.strip().replace(" ", "").lower()
    
    for row in rows[2:]:
        if len(row) < 3: 
            continue
            
        char_name = row[2].strip()
        if not char_name:
            continue
            
        clean_name = char_name.split("(")[0].strip().replace(" ", "").lower()
        
        if clean_name == search or search in clean_name:
            db_stats = get_supabase_attendance_stats(char_name.split("(")[0].strip())
            
            return {
                "status": "success",
                "name": char_name,
                "character_class": row[3].strip() if len(row) > 3 else "",
                "skill": row[4].strip() if len(row) > 4 else "",
                "bloodline": row[5].strip() if len(row) > 5 else "",
                "blood_member": row[6].strip() if len(row) > 6 else "",
                "attendance_stats": db_stats
            }
            
    raise HTTPException(status_code=404, detail="유저를 찾을 수 없습니다.")

@app.get("/bloodlines")
def get_bloodlines():
    try:
        rows = get_all_rows()
        bloodlines = []
        seen = set()
        for row in rows[2:]:
            if len(row) <= 12:
                continue
            name = row[12].strip()
            if not name:
                continue
            normalized = name.lower()
            if normalized in {"", "혈없음", "혈 없음", "없음", "none", "null", "undefined"}:
                continue
            if normalized not in seen:
                seen.add(normalized)
                bloodlines.append(name)
        return {"bloodlines": bloodlines}
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="혈 목록 로드 실패")

@app.get("/members/{bloodline}")
def get_bloodline_members(bloodline: str):
    if not bloodline or bloodline.lower() in ["undefined", "없음", ""]:
        return {"bloodline": "없음", "remaining": 40, "members": []}

    try:
        rows = get_all_rows()
        target = bloodline.strip().lower()
        members = []
        for row in rows[2:]:
            if len(row) <= 6: 
                continue
            
            member_id = row[2].strip()
            member_job = row[3].strip()
            bloodline_val = row[5].strip().lower()
            castle_val = row[6].strip().lower()
            
            if not member_id:
                continue
                
            if bloodline_val == target or castle_val == target:
                members.append({"id": member_id, "job": member_job})

        job_order = {"군주": 0, "기사": 1, "요정": 2, "법사": 3}
        members.sort(key=lambda item: (job_order.get(item.get("job", ""), 99), item.get("id", "").lower()))
        
        return {
            "bloodline": bloodline, 
            "remaining": 40 - len(members), 
            "members": members
        }
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="데이터 로드 실패")


# --- [분배금 정산 전체 표 API] ---
@app.get("/api/adena-summary")
def get_adena_summary():
    """
    '인원' 시트에 등록된 전체 유저의 정보와 
    Supabase DB의 참여 점수, 기여도, 분배금을 계산하여 전체 리스트로 반환합니다.
    """
    try:
        rows = get_all_rows()
        config = get_distribution_config()
        f3_total_gold = config["f3_total_gold"]
        
        tz_kst = datetime.timezone(datetime.timedelta(hours=9))
        now_kst = datetime.datetime.now(tz_kst)
        today_str = now_kst.strftime("%Y-%m-%d")
        
        d_start = config["d_start"] or (now_kst - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
        d_end = config["d_end"] or today_str
        c_start = config["c_start"] or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
        c_end = config["c_end"] or today_str
        
        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}"
        }

        # 1. 혈맹 전체 D2~D3 (1주간) 총점 구하기
        total_guild_d_points = 0.0
        all_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=points&attendance_date=gte.{d_start}&attendance_date=lte.{d_end}"
        res_all = requests.get(all_url, headers=headers, timeout=5)
        if res_all.status_code == 200:
            for r in res_all.json():
                total_guild_d_points += float(r.get("points", 0) or 0)

        # 2. 개인별 점수 조회
        user_db_map = {}
        user_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=user_id,attendance_date,points&attendance_date=gte.{c_start}&attendance_date=lte.{max(c_end, today_str)}"
        res_user = requests.get(user_url, headers=headers, timeout=5)
        if res_user.status_code == 200:
            for r in res_user.json():
                u_id = str(r.get("user_id", "")).strip().lower()
                r_date = r.get("attendance_date", "")
                pts = float(r.get("points", 0) or 0)

                if u_id not in user_db_map:
                    user_db_map[u_id] = {"c_pts": 0.0, "d_pts": 0.0, "today_pts": 0.0}

                if c_start <= r_date <= c_end:
                    user_db_map[u_id]["c_pts"] += pts
                if d_start <= r_date <= d_end:
                    user_db_map[u_id]["d_pts"] += pts
                if r_date == today_str:
                    user_db_map[u_id]["today_pts"] += pts

        # 3. 유저 명단 매핑
        summary_list = []
        for row in rows[2:]:
            if len(row) < 3:
                continue
            char_name = row[2].strip()
            if not char_name:
                continue

            char_class = row[3].strip() if len(row) > 3 else ""
            clean_id = char_name.split("(")[0].strip()
            lookup_key = clean_id.lower()

            user_pts = user_db_map.get(lookup_key, {"c_pts": 0.0, "d_pts": 0.0, "today_pts": 0.0})
            
            d_pts = user_pts["d_pts"]
            c_pts = user_pts["c_pts"]
            today_pts = user_pts["today_pts"]

            contrib_rate = 0.0
            dist_gold = 0
            if total_guild_d_points > 0 and d_pts > 0:
                contrib_rate = round((d_pts / total_guild_d_points) * 100, 2)
                dist_gold = int(f3_total_gold * (contrib_rate / 100))

            summary_list.append({
                "name": char_name,
                "character_class": char_class,
                "c_period_points": c_pts,
                "d_period_points": d_pts,
                "today_points": today_pts,
                "contribution_rate": contrib_rate,
                "distribution_gold": dist_gold
            })

        return {
            "status": "success",
            "total_dist_gold": int(f3_total_gold),
            "c_period_label": f"{c_start} ~ {c_end}",  # C2 ~ C3
            "d_period_label": f"{d_start} ~ {d_end}",  # 💡 D2 ~ D3
            "today_date": today_str,                    # 💡 오늘 날짜
            "data": summary_list
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"분배금 요약 로드 실패: {str(e)}")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)