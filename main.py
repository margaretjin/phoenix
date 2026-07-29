import os
import re
import json
import time
import datetime
import requests
import gspread
import uvicorn
import asyncio
import traceback
from contextlib import asynccontextmanager
from google.oauth2.service_account import Credentials
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response

SCOPE = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

# 🔑 Credentials & 환경 변수 설정
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

# 🌟 전역 캐시 저장소
_global_cache = {
    "rows": None,
    "dist_config": {
        "c_total_gold": 0.0,
        "d_total_gold": 0.0,
        "c_start": "", "c_end": "",
        "d_start": "", "d_end": ""
    },
    "summary_data": None,
    "last_updated": 0
}

def clean_id_string(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'[\(\（].*?[\)\）]', '', str(text))
    text = re.sub(r'\s+', '', text)
    return text.strip().lower()

# 🔄 백그라운드 데이터 동기화
def refresh_all_data():
    try:
        print("🔄 [시스템] 구글 시트 및 Supabase 데이터 동기화 시작...")
        
        # 1. 인원 시트 로드
        doc = client.open_by_key(SPREADSHEET_ID)
        sheet = doc.worksheet(SHEET_NAME)
        rows = sheet.get_all_values()
        
        # 2. 분배금정산 시트 로드 (C1:D3 영역 한 번에 조회)
        doc_dist = client.open_by_key(DIST_SPREADSHEET_ID)
        sheet_dist = doc_dist.worksheet(DIST_SHEET_NAME)
        val = sheet_dist.get("C1:D3")

        # 🎯 C1(저번주 총 분배금), D1(이번주 총 분배금)
        c_f1_str = str(val[0][0]) if len(val) > 0 and len(val[0]) > 0 else "0"
        d_f1_str = str(val[0][1]) if len(val) > 0 and len(val[0]) > 1 else "0"

        # 🎯 C2~C3(저번주 기간), D2~D3(이번주 기간)
        c_start = val[1][0].strip() if len(val) > 1 and len(val[1]) > 0 else ""
        d_start = val[1][1].strip() if len(val) > 1 and len(val[1]) > 1 else ""
        c_end   = val[2][0].strip() if len(val) > 2 and len(val[2]) > 0 else ""
        d_end   = val[2][1].strip() if len(val) > 2 and len(val[2]) > 1 else ""

        clean_c_f1 = "".join(c for c in c_f1_str if c.isdigit() or c == '.')
        clean_d_f1 = "".join(c for c in d_f1_str if c.isdigit() or c == '.')
        
        c_total_gold = float(clean_c_f1) if clean_c_f1 else 0.0
        d_total_gold = float(clean_d_f1) if clean_d_f1 else 0.0

        dist_config = {
            "c_total_gold": c_total_gold,
            "d_total_gold": d_total_gold,
            "c_start": c_start, "c_end": c_end,
            "d_start": d_start, "d_end": d_end
        }

        # 3. 정산 연산 수행
        summary_data = compute_summary(rows, dist_config)

        # 4. 캐시 동시 업데이트
        _global_cache["rows"] = rows
        _global_cache["dist_config"] = dist_config
        _global_cache["summary_data"] = summary_data
        _global_cache["last_updated"] = time.time()
        print("✅ [시스템] 데이터 동기화 완료!")
    except Exception as e:
        print(f"❌ [시스템] 데이터 동기화 실패: {str(e)}")
        traceback.print_exc()

def compute_summary(rows, config):
    c_total_gold = config.get("c_total_gold", 0.0)
    d_total_gold = config.get("d_total_gold", 0.0)
    
    tz_kst = datetime.timezone(datetime.timedelta(hours=9))
    now_kst = datetime.datetime.now(tz_kst)
    today_str = now_kst.strftime("%Y-%m-%d")
    yesterday_str = (now_kst - datetime.timedelta(days=1)).strftime("%Y-%m-%d")

    raw_d_start = config.get("d_start") or (now_kst - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
    raw_d_end = config.get("d_end") or today_str
    raw_c_start = config.get("c_start") or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
    raw_c_end = config.get("c_end") or today_str

    d_start, d_end = min(raw_d_start, raw_d_end), max(raw_d_start, raw_d_end)
    c_start, c_end = min(raw_c_start, raw_c_end), max(raw_c_start, raw_c_end)
    b_start, b_end = min(c_start, d_start), max(c_end, d_end)

    headers = {"apikey": SUPABASE_KEY, "Authorization": f"Bearer {SUPABASE_KEY}"}
    query_start = min(b_start, yesterday_str)
    query_end = max(b_end, today_str)

    user_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=user_id,attendance_date,attendance_hour&attendance_date=gte.{query_start}&attendance_date=lte.{query_end}&order=attendance_date.desc&limit=5000"
    
    user_db_map = {}
    total_guild_c_points = 0.0
    total_guild_d_points = 0.0

    try:
        res_user = requests.get(user_url, headers=headers, timeout=8)
        if res_user.status_code == 200:
            records = res_user.json()
            for r in records:
                raw_u_id = str(r.get("user_id", "")).strip()
                u_id = clean_id_string(raw_u_id)
                if not u_id:
                    continue

                raw_date = str(r.get("attendance_date", "")).strip()
                dt_obj = None

                try:
                    if "T" in raw_date:
                        dt_obj = datetime.datetime.fromisoformat(raw_date.replace("Z", "+00:00")).astimezone(tz_kst)
                    elif raw_date:
                        clean_d_str = raw_date.split(" ")[0].replace(".", "-").replace("/", "-")
                        dt_obj = datetime.datetime.strptime(clean_d_str, "%Y-%m-%d")
                except Exception:
                    dt_obj = None

                if dt_obj:
                    r_date = dt_obj.strftime("%Y-%m-%d")
                    weekday_idx = dt_obj.weekday()  # 0: 월, 1: 화, ..., 6: 일
                    is_sunday = (weekday_idx == 6)
                else:
                    r_date = raw_date.split("T")[0].split(" ")[0].replace(".", "-").replace("/", "-")
                    weekday_idx = None
                    is_sunday = False

                try:
                    raw_att_hour = int(r.get("attendance_hour")) if r.get("attendance_hour") is not None else None
                except (ValueError, TypeError):
                    raw_att_hour = None

                if is_sunday and raw_att_hour == 21:
                    pts = 10.0
                    display_hour = 20
                else:
                    pts = 1.0
                    display_hour = raw_att_hour

                if u_id not in user_db_map:
                    user_db_map[u_id] = {
                        "c_pts": 0.0, "d_pts": 0.0, "b_pts": 0.0,
                        "today_pts": 0.0, "today_hours": [],
                        "yesterday_pts": 0.0, "yesterday_hours": [],
                        "c_daily_points": [0.0] * 7,
                        "d_daily_points": [0.0] * 7
                    }

                # B기간 (통합)
                if b_start <= r_date <= b_end:
                    user_db_map[u_id]["b_pts"] += pts

                # C기간 (저번주)
                if c_start <= r_date <= c_end:
                    user_db_map[u_id]["c_pts"] += pts
                    total_guild_c_points += pts
                    if weekday_idx is not None:
                        user_db_map[u_id]["c_daily_points"][weekday_idx] += pts

                # D기간 (이번주)
                if d_start <= r_date <= d_end:
                    user_db_map[u_id]["d_pts"] += pts
                    total_guild_d_points += pts
                    if weekday_idx is not None:
                        user_db_map[u_id]["d_daily_points"][weekday_idx] += pts

                if r_date == today_str:
                    user_db_map[u_id]["today_pts"] += pts
                    if display_hour is not None and display_hour > 0 and display_hour not in user_db_map[u_id]["today_hours"]:
                        user_db_map[u_id]["today_hours"].append(display_hour)

                if r_date == yesterday_str:
                    user_db_map[u_id]["yesterday_pts"] += pts
                    if display_hour is not None and display_hour > 0 and display_hour not in user_db_map[u_id]["yesterday_hours"]:
                        user_db_map[u_id]["yesterday_hours"].append(display_hour)

    except Exception as e:
        print(f"❌ Supabase 데이터 연산 중 오류 발생: {str(e)}")
        traceback.print_exc()

    summary_list = []
    for row in rows[2:]:
        if len(row) < 2 or not row[1].strip():
            continue
        char_name = row[1].strip()
        char_class = row[3].strip() if len(row) > 3 else ""
        clean_id = clean_id_string(char_name)

        user_pts = user_db_map.get(clean_id, {
            "c_pts": 0.0, "d_pts": 0.0, "b_pts": 0.0,
            "today_pts": 0.0, "today_hours": [],
            "yesterday_pts": 0.0, "yesterday_hours": [],
            "c_daily_points": [0.0] * 7,
            "d_daily_points": [0.0] * 7
        })

        b_pts = float(user_pts.get("b_pts", 0.0))
        c_pts = float(user_pts.get("c_pts", 0.0))
        d_pts = float(user_pts.get("d_pts", 0.0))
        today_pts = float(user_pts.get("today_pts", 0.0))
        yesterday_pts = float(user_pts.get("yesterday_pts", 0.0))

        # 기여도 및 분배금 연산 (C기간/D기간 각자)
        c_contrib_rate = 0.0
        c_dist_gold = 0
        if total_guild_c_points > 0 and c_pts > 0:
            c_contrib_rate = round((c_pts / total_guild_c_points) * 100, 2)
            c_dist_gold = int(c_total_gold * (c_contrib_rate / 100))

        d_contrib_rate = 0.0
        d_dist_gold = 0
        if total_guild_d_points > 0 and d_pts > 0:
            d_contrib_rate = round((d_pts / total_guild_d_points) * 100, 2)
            d_dist_gold = int(d_total_gold * (d_contrib_rate / 100))

        summary_list.append({
            "name": char_name,
            "character_class": char_class,
            "b_period_points": b_pts,
            "c_period_points": c_pts,
            "d_period_points": d_pts,
            "today_points": today_pts,
            "today_hours": user_pts.get("today_hours", []),
            "yesterday_points": yesterday_pts,
            "yesterday_hours": user_pts.get("yesterday_hours", []),
            "c_daily_points": user_pts.get("c_daily_points", [0.0] * 7),
            "d_daily_points": user_pts.get("d_daily_points", [0.0] * 7),
            
            # 이번주 (D기간)
            "d_contribution_rate": d_contrib_rate,
            "d_distribution_gold": d_dist_gold,
            "contribution_rate": d_contrib_rate,
            "distribution_gold": d_dist_gold,

            # 저번주 (C기간)
            "c_contribution_rate": c_contrib_rate,
            "c_distribution_gold": c_dist_gold
        })

    return {
        "status": "success",
        "total_dist_gold": int(d_total_gold),
        "c_dist_gold": int(c_total_gold),
        "d_dist_gold": int(d_total_gold),
        "b_period_label": f"{b_start} ~ {b_end}",
        "c_period_label": f"{c_start} ~ {c_end}",
        "d_period_label": f"{d_start} ~ {d_end}",
        "today_date": today_str,
        "yesterday_date": yesterday_str,
        "data": summary_list
    }

async def auto_refresh_loop():
    while True:
        await asyncio.to_thread(refresh_all_data)
        await asyncio.sleep(60)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # 앱 시작 시 즉시 최초 1회 동기화
    await asyncio.to_thread(refresh_all_data)
    # 이후 백그라운드 60초 주기 갱신
    asyncio.create_task(auto_refresh_loop())
    yield

app = FastAPI(title="피닉스", lifespan=lifespan)

app.mount("/static", StaticFiles(directory="static"), name="static")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 📄 라우터 (HTML 페이지 이동)
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

# 🔍 데이터 조회 API
@app.get("/api/adena-summary")
def get_adena_summary():
    if _global_cache["summary_data"] is None:
        refresh_all_data()
    return _global_cache["summary_data"]

@app.get("/search/{name}")
def search_user(name: str):
    if _global_cache["rows"] is None:
        refresh_all_data()

    rows = _global_cache["rows"] or []
    search = clean_id_string(name)
    summary_data = _global_cache["summary_data"] or {}
    data_list = summary_data.get("data", [])

    for row in rows[2:]:
        if len(row) < 2 or not row[1].strip():
            continue
        char_name_b = row[1].strip()
        clean_name = clean_id_string(char_name_b)

        if clean_name == search or search in clean_name:
            matched_stats = next((item for item in data_list if clean_id_string(item["name"]) == clean_name), {})
            real_id_c = row[2].strip() if len(row) > 2 else char_name_b

            return {
                "status": "success",
                "name": real_id_c,
                "character_class": row[3].strip() if len(row) > 3 else "",
                "skill": row[4].strip() if len(row) > 4 else "",
                "bloodline": row[5].strip() if len(row) > 5 else "",
                "blood_member": row[6].strip() if len(row) > 6 else "",
                "attendance_stats": {
                    "total_distribution_gold": summary_data.get("d_dist_gold", 0),
                    "c_dist_gold": summary_data.get("c_dist_gold", 0),
                    "d_dist_gold": summary_data.get("d_dist_gold", 0),
                    
                    "contribution_rate": matched_stats.get("d_contribution_rate", 0.0),
                    "distribution_gold": matched_stats.get("d_distribution_gold", 0),
                    
                    "d_contribution_rate": matched_stats.get("d_contribution_rate", 0.0),
                    "d_distribution_gold": matched_stats.get("d_distribution_gold", 0),
                    "c_contribution_rate": matched_stats.get("c_contribution_rate", 0.0),
                    "c_distribution_gold": matched_stats.get("c_distribution_gold", 0),

                    "today_points": matched_stats.get("today_points", 0.0),
                    "today_hours": matched_stats.get("today_hours", []),
                    "yesterday_points": matched_stats.get("yesterday_points", 0.0),
                    "yesterday_hours": matched_stats.get("yesterday_hours", []),
                    
                    "b_period_points": matched_stats.get("b_period_points", 0.0),
                    "d_period_points": matched_stats.get("d_period_points", 0.0),
                    "c_period_points": matched_stats.get("c_period_points", 0.0),
                    
                    "c_daily_points": matched_stats.get("c_daily_points", [0.0] * 7),
                    "d_daily_points": matched_stats.get("d_daily_points", [0.0] * 7),

                    "b_period_label": summary_data.get("b_period_label", ""),
                    "d_period_label": summary_data.get("d_period_label", ""),
                    "c_period_label": summary_data.get("c_period_label", "")
                }
            }

    raise HTTPException(status_code=404, detail="유저를 찾을 수 없습니다.")

@app.get("/bloodlines")
def get_bloodlines():
    if _global_cache["rows"] is None:
        refresh_all_data()

    rows = _global_cache["rows"] or []
    bloodlines, seen = [], set()
    for row in rows[2:]:
        if len(row) <= 12 or not row[12].strip():
            continue
        name = row[12].strip()
        normalized = name.lower()
        if normalized in {"", "혈없음", "혈 없음", "없음", "none", "null", "undefined"}:
            continue
        if normalized not in seen:
            seen.add(normalized)
            bloodlines.append(name)
    return {"bloodlines": bloodlines}

@app.get("/members/{bloodline}")
def get_bloodline_members(bloodline: str):
    if not bloodline or bloodline.lower() in ["undefined", "없음", ""]:
        return {"bloodline": "없음", "remaining": 40, "members": []}

    if _global_cache["rows"] is None:
        refresh_all_data()

    rows = _global_cache["rows"] or []
    target = bloodline.strip().lower()
    members = []
    for row in rows[2:]:
        if len(row) <= 5 or not row[1].strip():
            continue
        member_id = row[1].strip()
        member_job = row[3].strip() if len(row) > 3 else ""
        bloodline_val = row[5].strip().lower() if len(row) > 5 else ""
        castle_val = row[6].strip().lower() if len(row) > 6 else ""

        if bloodline_val == target or castle_val == target:
            members.append({"id": member_id, "job": member_job})

    job_order = {"군주": 0, "기사": 1, "요정": 2, "법사": 3}
    members.sort(key=lambda item: (job_order.get(item.get("job", ""), 99), item.get("id", "").lower()))

    return {
        "bloodline": bloodline,
        "remaining": 40 - len(members),
        "members": members
    }

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
