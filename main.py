import os
import re
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

if "GOOGLE_CREDENTIALS" in os.environ:
    creds_info = json.loads(os.environ["GOOGLE_CREDENTIALS"])
else:
    json_path = os.path.join(os.path.dirname(__file__), "credentials.json")
    with open(json_path, "r", encoding="utf-8") as f:
        creds_info = json.load(f)

if "private_key" in creds_info:
    creds_info["private_key"] = creds_info["private_key"].replace("\\n", "\n")

CREDS = Credentials.from_service_account_info(creds_info, scopes=SCOPE)
client = gspread.authorize(CREDS)

SPREADSHEET_ID = creds_info.get("SPREADSHEET_ID") or os.environ.get("SPREADSHEET_ID")
SHEET_NAME = "인원"

DIST_SPREADSHEET_ID = creds_info.get("DIST_SPREADSHEET_ID") or os.environ.get("DIST_SPREADSHEET_ID")
DIST_SHEET_NAME = "분배금정산"

SUPABASE_URL = creds_info.get("SUPABASE_URL") or os.environ.get("SUPABASE_URL")
SUPABASE_KEY = creds_info.get("SUPABASE_KEY") or os.environ.get("SUPABASE_KEY")

CACHE_TTL = 60
_cache = {"rows": None, "timestamp": 0}
_dist_cache = {
    "f3_total_gold": 0.0,
    "c_start": "", "c_end": "",
    "d_start": "", "d_end": "",
    "timestamp": 0
}

# 💡 아이디 정제 함수 (괄호 및 내부 텍스트, 공백 제거 후 소문자 변환)
def clean_id_string(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'[\(\（].*?[\)\）]', '', str(text))
    text = re.sub(r'\s+', '', text)
    return text.strip().lower()

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
                return _cache["rows"]
            raise HTTPException(status_code=500, detail=f"인원 시트 로드 실패: {str(e)}")
    return _cache["rows"]

def get_distribution_config():
    now = time.time()
    if (now - _dist_cache["timestamp"]) > CACHE_TTL or not _dist_cache["d_start"]:
        try:
            doc = client.open_by_key(DIST_SPREADSHEET_ID)
            sheet = doc.worksheet(DIST_SHEET_NAME)
            
            f3_str = str(sheet.acell("F3").value or "0")
            clean_f3 = "".join(c for c in f3_str if c.isdigit() or c == '.')
            _dist_cache["f3_total_gold"] = float(clean_f3) if clean_f3 else 0.0
            
            _dist_cache["c_start"] = str(sheet.acell("C2").value or "").strip()
            _dist_cache["c_end"] = str(sheet.acell("C3").value or "").strip()
            _dist_cache["d_start"] = str(sheet.acell("D2").value or "").strip()
            _dist_cache["d_end"] = str(sheet.acell("D3").value or "").strip()
            
            _dist_cache["timestamp"] = now
            print("--- [시스템] 분배금정산 시트 설정 동기화 완료 ---")
        except Exception as e:
            print(f"--- [경고] 분배금정산 시트 로드 실패: {str(e)} ---")
            
    return _dist_cache

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

# --- 💰 전체 분배금 정산 API (어제 날짜 데이터 연동 추가) ---
@app.get("/api/adena-summary")
def get_adena_summary():
    try:
        rows = get_all_rows()
        config = get_distribution_config()
        f3_total_gold = config["f3_total_gold"]
        
        tz_kst = datetime.timezone(datetime.timedelta(hours=9))
        now_kst = datetime.datetime.now(tz_kst)
        today_str = now_kst.strftime("%Y-%m-%d")
        
        # 🌟 어제 날짜 계산 (KST 기준)
        yesterday_str = (now_kst - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        
        raw_d_start = config["d_start"] or (now_kst - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
        raw_d_end = config["d_end"] or today_str
        raw_c_start = config["c_start"] or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
        raw_c_end = config["c_end"] or today_str

        d_start = raw_d_start.replace(".", "-").replace("/", "-")
        d_end = raw_d_end.replace(".", "-").replace("/", "-")
        c_start = raw_c_start.replace(".", "-").replace("/", "-")
        c_end = raw_c_end.replace(".", "-").replace("/", "-")

        d_start, d_end = min(d_start, d_end), max(d_start, d_end)
        c_start, c_end = min(c_start, c_end), max(c_start, c_end)

        print(f"\n==================== [정산 연산 시작] ====================")
        print(f"📅 C기간(2주): {c_start} ~ {c_end}")
        print(f"📅 D기간(1주): {d_start} ~ {d_end}")
        print(f"📅 오늘 날짜  : {today_str}")
        print(f"📅 어제 날짜  : {yesterday_str}")

        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}"
        }

        # 어제 날짜도 커버될 수 있도록 query_start 계산 시 yesterday_str 포함
        query_start = min(c_start, d_start, yesterday_str)
        query_end = max(c_end, d_end, today_str)
        
        user_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=user_id,attendance_date,attendance_hour,points&attendance_date=gte.{query_start}&attendance_date=lte.{query_end}&order=attendance_date.desc&limit=5000"
        res_user = requests.get(user_url, headers=headers, timeout=8)
        
        user_db_map = {}
        total_guild_d_points = 0.0

        if res_user.status_code == 200:
            records = res_user.json()
            print(f"📥 Supabase 응답 데이터: 총 {len(records)}건")
            
            for r in records:
                raw_u_id = str(r.get("user_id", "")).strip()
                u_id = clean_id_string(raw_u_id)
                
                raw_date = str(r.get("attendance_date", "")).strip()
                r_date = raw_date.split("T")[0].split(" ")[0].replace(".", "-").replace("/", "-")
                pts = float(r.get("points", 0) or 0)
                
                try:
                    att_hour = int(r.get("attendance_hour", 0))
                except (ValueError, TypeError):
                    att_hour = None

                if u_id not in user_db_map:
                    user_db_map[u_id] = {
                        "c_pts": 0.0, 
                        "d_pts": 0.0, 
                        "today_pts": 0.0, 
                        "today_hours": [],
                        "yesterday_pts": 0.0,
                        "yesterday_hours": []
                    }

                if c_start <= r_date <= c_end:
                    user_db_map[u_id]["c_pts"] += pts
                if d_start <= r_date <= d_end:
                    user_db_map[u_id]["d_pts"] += pts
                    total_guild_d_points += pts

                # 오늘 보스탐 데이터
                if r_date == today_str:
                    user_db_map[u_id]["today_pts"] += pts
                    if att_hour is not None and att_hour > 0:
                        if att_hour not in user_db_map[u_id]["today_hours"]:
                            user_db_map[u_id]["today_hours"].append(att_hour)

                # 🌟 어제 보스탐 데이터 집계 추가
                if r_date == yesterday_str:
                    user_db_map[u_id]["yesterday_pts"] += pts
                    if att_hour is not None and att_hour > 0:
                        if att_hour not in user_db_map[u_id]["yesterday_hours"]:
                            user_db_map[u_id]["yesterday_hours"].append(att_hour)

            print(f"💎 혈맹 전체 D기간 총 점수: {total_guild_d_points} 점")

        # 구글 시트 B열 매칭
        summary_list = []
        for row in rows[2:]:
            if len(row) < 2: continue
            
            char_name = row[1].strip()  # B열: 아이디
            if not char_name: continue

            char_class = row[3].strip() if len(row) > 3 else ""  # D열: 클래스
            clean_id = clean_id_string(char_name)

            user_pts = user_db_map.get(clean_id, None)
            pts_dict = user_pts if user_pts else {
                "c_pts": 0.0, 
                "d_pts": 0.0, 
                "today_pts": 0.0, 
                "today_hours": [],
                "yesterday_pts": 0.0,
                "yesterday_hours": []
            }
            
            d_pts = pts_dict["d_pts"]
            c_pts = pts_dict["c_pts"]

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
                "today_points": pts_dict["today_pts"],
                "today_hours": pts_dict["today_hours"],
                "yesterday_points": pts_dict["yesterday_pts"],       # 🌟 어제 점수 추가
                "yesterday_hours": pts_dict["yesterday_hours"],     # 🌟 어제 타임 추가
                "contribution_rate": contrib_rate,
                "distribution_gold": dist_gold
            })

        print(f"==================== [정산 연산 완료] ====================\n")

        return {
            "status": "success",
            "total_dist_gold": int(f3_total_gold),
            "c_period_label": f"{c_start} ~ {c_end}",
            "d_period_label": f"{d_start} ~ {d_end}",
            "today_date": today_str,
            "yesterday_date": yesterday_str,
            "data": summary_list
        }
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"분배금 요약 로드 실패: {str(e)}")

# --- 🔍 유저 검색 API ---
@app.get("/search/{name}")
def search_user(name: str):
    rows = get_all_rows()
    search = clean_id_string(name)
    
    summary_data = get_adena_summary()
    data_list = summary_data.get("data", [])
    
    for row in rows[2:]:
        if len(row) < 2: continue
        
        char_name_b = row[1].strip()  # B열: 검색 비교용 키값
        if not char_name_b: continue
            
        clean_name = clean_id_string(char_name_b)
        
        # B열 기준으로 유저 검색
        if clean_name == search or search in clean_name:
            matched_stats = next((item for item in data_list if clean_id_string(item["name"]) == clean_name), {})
            
            # C열의 실제 아이디 텍스트 추출
            real_id_c = row[2].strip() if len(row) > 2 else char_name_b
            
            return {
                "status": "success",
                "name": real_id_c,
                "character_class": row[3].strip() if len(row) > 3 else "",  # D열: 클래스
                "skill": row[4].strip() if len(row) > 4 else "",            # E열
                "bloodline": row[5].strip() if len(row) > 5 else "",        # F열
                "blood_member": row[6].strip() if len(row) > 6 else "",     # G열
                "attendance_stats": {
                    "total_distribution_gold": summary_data.get("total_dist_gold", 0),
                    "contribution_rate": matched_stats.get("contribution_rate", 0.0),
                    "distribution_gold": matched_stats.get("distribution_gold", 0),
                    "today_points": matched_stats.get("today_points", 0.0),
                    "today_hours": matched_stats.get("today_hours", []),
                    "yesterday_points": matched_stats.get("yesterday_points", 0.0), # 🌟 어제 점수 전달
                    "yesterday_hours": matched_stats.get("yesterday_hours", []),   # 🌟 어제 타임 전달
                    "d_period_points": matched_stats.get("d_period_points", 0.0),
                    "c_period_points": matched_stats.get("c_period_points", 0.0),
                    "d_period_label": summary_data.get("d_period_label", ""),
                    "c_period_label": summary_data.get("c_period_label", "")
                }
            }
            
    raise HTTPException(status_code=404, detail="유저를 찾을 수 없습니다.")

@app.get("/bloodlines")
def get_bloodlines():
    try:
        rows = get_all_rows()
        bloodlines = []
        seen = set()
        for row in rows[2:]:
            if len(row) <= 12: continue
            name = row[12].strip()
            if not name: continue
            normalized = name.lower()
            if normalized in {"", "혈없음", "혈 없음", "없음", "none", "null", "undefined"}: continue
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
            if len(row) <= 5: continue
            
            member_id = row[1].strip()                                # B열: 아이디
            member_job = row[3].strip() if len(row) > 3 else ""       # D열: 클래스
            bloodline_val = row[5].strip().lower() if len(row) > 5 else ""
            castle_val = row[6].strip().lower() if len(row) > 6 else ""
            
            if not member_id: continue
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

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
