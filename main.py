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

from dungeons import router as dungeons_router, init_dungeon_router

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

CACHE_TTL = 10
_cache = {"rows": None, "timestamp": 0}
_dist_cache = {
    "c1_gold": 0.0, "d1_gold": 0.0,
    "b_start": "", "b_end": "",
    "c_start": "", "c_end": "",
    "d_start": "", "d_end": "",
    "timestamp": 0
}
_summary_cache = {"data": None, "timestamp": 0}

def clean_id_string(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'[\(\（].*?[\)\）]', '', str(text))
    text = re.sub(r'\s+', '', text)
    return text.strip().lower()

def clean_amount(val) -> float:
    if not val:
        return 0.0
    clean_str = "".join(c for c in str(val) if c.isdigit() or c == '.')
    return float(clean_str) if clean_str else 0.0

def get_all_rows():
    now = time.time()
    if _cache["rows"] is None or (now - _cache["timestamp"]) > CACHE_TTL:
        try:
            doc = client.open_by_key(SPREADSHEET_ID)
            sheet = doc.worksheet(SHEET_NAME)
            _cache["rows"] = sheet.get_all_values()
            _cache["timestamp"] = now
        except Exception as e:
            if _cache["rows"] is not None:
                return _cache["rows"]
            raise HTTPException(status_code=500, detail=f"인원 시트 로드 실패: {str(e)}")
    return _cache["rows"]

init_dungeon_router(get_all_rows)
app.include_router(dungeons_router)

def get_distribution_config():
    now = time.time()
    if (now - _dist_cache["timestamp"]) > CACHE_TTL or not _dist_cache["d_start"]:
        try:
            doc = client.open_by_key(DIST_SPREADSHEET_ID)
            sheet = doc.worksheet(DIST_SHEET_NAME)
            
            val = sheet.get("B1:D3") 
            
            b_start = val[1][0].strip() if len(val) > 1 and len(val[1]) > 0 else ""
            b_end   = val[2][0].strip() if len(val) > 2 and len(val[2]) > 0 else ""

            c1_gold = clean_amount(val[0][1]) if len(val) > 0 and len(val[0]) > 1 else 0.0
            c_start = val[1][1].strip() if len(val) > 1 and len(val[1]) > 1 else ""
            c_end   = val[2][1].strip() if len(val) > 2 and len(val[2]) > 1 else ""

            d1_gold = clean_amount(val[0][2]) if len(val) > 0 and len(val[0]) > 2 else 0.0
            d_start = val[1][2].strip() if len(val) > 1 and len(val[1]) > 2 else ""
            d_end   = val[2][2].strip() if len(val) > 2 and len(val[2]) > 2 else ""

            _dist_cache["c1_gold"] = c1_gold
            _dist_cache["d1_gold"] = d1_gold
            _dist_cache["b_start"] = b_start
            _dist_cache["b_end"] = b_end
            _dist_cache["c_start"] = c_start
            _dist_cache["c_end"] = c_end
            _dist_cache["d_start"] = d_start
            _dist_cache["d_end"] = d_end
            _dist_cache["timestamp"] = now
        except Exception as e:
            print(f"--- [경고] 분배금정산 시트 로드 실패: {str(e)} ---")
            
    return _dist_cache

@app.api_route("/", methods=["GET", "HEAD"])
def read_index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "main.html"))

@app.get("//.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools():
    return Response(status_code=204)

@app.get("/adena.html")
def adena(): 
    return FileResponse("adena.html")

@app.get("/api/adena-summary")
def get_adena_summary():
    now = time.time()
    if _summary_cache["data"] is not None and (now - _summary_cache["timestamp"]) <= CACHE_TTL:
        return _summary_cache["data"]

    try:
        rows = get_all_rows()
        config = get_distribution_config()
        
        c1_gold = config["c1_gold"]
        d1_gold = config["d1_gold"]
        
        tz_kst = datetime.timezone(datetime.timedelta(hours=9))
        now_kst = datetime.datetime.now(tz_kst)
        today_str = now_kst.strftime("%Y-%m-%d")
        yesterday_str = (now_kst - datetime.timedelta(days=1)).strftime("%Y-%m-%d")
        
        raw_b_start = config["b_start"] or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
        raw_b_end   = config["b_end"] or today_str
        raw_c_start = config["c_start"] or (now_kst - datetime.timedelta(days=13)).strftime("%Y-%m-%d")
        raw_c_end   = config["c_end"] or (now_kst - datetime.timedelta(days=7)).strftime("%Y-%m-%d")
        raw_d_start = config["d_start"] or (now_kst - datetime.timedelta(days=6)).strftime("%Y-%m-%d")
        raw_d_end   = config["d_end"] or today_str

        b_start = min(raw_b_start.replace(".", "-").replace("/", "-"), raw_b_end.replace(".", "-").replace("/", "-"))
        b_end   = max(raw_b_start.replace(".", "-").replace("/", "-"), raw_b_end.replace(".", "-").replace("/", "-"))
        c_start = min(raw_c_start.replace(".", "-").replace("/", "-"), raw_c_end.replace(".", "-").replace("/", "-"))
        c_end   = max(raw_c_start.replace(".", "-").replace("/", "-"), raw_c_end.replace(".", "-").replace("/", "-"))
        d_start = min(raw_d_start.replace(".", "-").replace("/", "-"), raw_d_end.replace(".", "-").replace("/", "-"))
        d_end   = max(raw_d_start.replace(".", "-").replace("/", "-"), raw_d_end.replace(".", "-").replace("/", "-"))

        headers = {
            "apikey": SUPABASE_KEY,
            "Authorization": f"Bearer {SUPABASE_KEY}"
        }

        query_start = min(b_start, c_start, d_start, yesterday_str)
        query_end   = max(b_end, c_end, d_end, today_str)
        
        user_url = f"{SUPABASE_URL}/rest/v1/boss_attendance?select=user_id,attendance_date,attendance_hour&attendance_date=gte.{query_start}&attendance_date=lte.{query_end}&order=attendance_date.desc&limit=5000"
        res_user = requests.get(user_url, headers=headers, timeout=8)
        
        user_db_map = {}
        total_guild_b_points = 0.0
        total_guild_c_points = 0.0
        total_guild_d_points = 0.0

        if res_user.status_code == 200:
            records = res_user.json()
            for r in records:
                raw_u_id = str(r.get("user_id", "")).strip()
                u_id = clean_id_string(raw_u_id)
                raw_date = str(r.get("attendance_date", "")).strip()
                
                try:
                    if "T" in raw_date:
                        dt_utc = datetime.datetime.fromisoformat(raw_date.replace("Z", "+00:00"))
                        dt_obj = dt_utc.astimezone(tz_kst)
                    else:
                        clean_d_str = raw_date.split(" ")[0].replace(".", "-").replace("/", "-")
                        dt_obj = datetime.datetime.strptime(clean_d_str, "%Y-%m-%d")
                except Exception:
                    dt_obj = None

                if dt_obj:
                    r_date = dt_obj.strftime("%Y-%m-%d")
                    is_sunday = (dt_obj.weekday() == 6)
                else:
                    r_date = raw_date.split("T")[0].split(" ")[0].replace(".", "-").replace("/", "-")
                    is_sunday = False

                try:
                    raw_att_hour = int(r.get("attendance_hour", 0))
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
                        "b_pts": 0.0, "c_pts": 0.0, "d_pts": 0.0,
                        "c_daily_pts": [0.0] * 7,  # 저번주 요일별
                        "d_daily_pts": [0.0] * 7,  # 🎯 이번주 요일별 누적 배열 추가
                        "today_pts": 0.0, "today_hours": [],
                        "yesterday_pts": 0.0, "yesterday_hours": []
                    }

                if b_start <= r_date <= b_end:
                    user_db_map[u_id]["b_pts"] += pts
                    total_guild_b_points += pts

                # 📌 저번주 (C열 날짜 범위)
                if c_start <= r_date <= c_end:
                    user_db_map[u_id]["c_pts"] += pts
                    total_guild_c_points += pts
                    if dt_obj:
                        user_db_map[u_id]["c_daily_pts"][dt_obj.weekday()] += pts
                    else:
                        try:
                            w_idx = datetime.datetime.strptime(r_date, "%Y-%m-%d").weekday()
                            user_db_map[u_id]["c_daily_pts"][w_idx] += pts
                        except Exception:
                            pass

                # 📌 이번주 (D열 날짜 범위) + 월~일 요일별 점수 누적
                if d_start <= r_date <= d_end:
                    user_db_map[u_id]["d_pts"] += pts
                    total_guild_d_points += pts
                    if dt_obj:
                        user_db_map[u_id]["d_daily_pts"][dt_obj.weekday()] += pts
                    else:
                        try:
                            w_idx = datetime.datetime.strptime(r_date, "%Y-%m-%d").weekday()
                            user_db_map[u_id]["d_daily_pts"][w_idx] += pts
                        except Exception:
                            pass

                if r_date == today_str:
                    user_db_map[u_id]["today_pts"] += pts
                    if display_hour is not None and display_hour > 0 and display_hour not in user_db_map[u_id]["today_hours"]:
                        user_db_map[u_id]["today_hours"].append(display_hour)

                if r_date == yesterday_str:
                    user_db_map[u_id]["yesterday_pts"] += pts
                    if display_hour is not None and display_hour > 0 and display_hour not in user_db_map[u_id]["yesterday_hours"]:
                        user_db_map[u_id]["yesterday_hours"].append(display_hour)

        summary_list = []
        for row in rows[2:]:
            if len(row) < 2: continue
            char_name = row[1].strip()
            if not char_name: continue
            char_class = row[3].strip() if len(row) > 3 else ""
            clean_id = clean_id_string(char_name)

            user_pts = user_db_map.get(clean_id, {
                "b_pts": 0.0, "c_pts": 0.0, "d_pts": 0.0,
                "c_daily_pts": [0.0] * 7,
                "d_daily_pts": [0.0] * 7,
                "today_pts": 0.0, "today_hours": [], 
                "yesterday_pts": 0.0, "yesterday_hours": []
            })
            
            b_pts = user_pts["b_pts"]
            c_pts = user_pts["c_pts"]
            d_pts = user_pts["d_pts"]

            if total_guild_c_points > 0 and c_pts > 0:
                c_contrib_rate = (c_pts / total_guild_c_points) * 100
                c_dist_gold = int(c1_gold * (c_contrib_rate / 100))
            else:
                c_contrib_rate = 0.0
                c_dist_gold = 0

            if total_guild_d_points > 0 and d_pts > 0:
                d_contrib_rate = (d_pts / total_guild_d_points) * 100
                d_dist_gold = int(d1_gold * (d_contrib_rate / 100))
            else:
                d_contrib_rate = 0.0
                d_dist_gold = 0

            summary_list.append({
                "name": char_name,
                "character_class": char_class,
                "b_period_points": b_pts,
                "c_period_points": c_pts,
                "c_daily_points": user_pts["c_daily_pts"],
                "c_contribution_rate": round(c_contrib_rate, 2),
                "c_distribution_gold": c_dist_gold,
                "d_period_points": d_pts,
                "d_daily_points": user_pts["d_daily_pts"],        # 🎯 이번주 요일별 점수 전달
                "d_contribution_rate": round(d_contrib_rate, 2),
                "d_distribution_gold": d_dist_gold,
                "today_points": user_pts["today_pts"],
                "today_hours": user_pts["today_hours"],
                "yesterday_points": user_pts["yesterday_pts"],
                "yesterday_hours": user_pts["yesterday_hours"]
            })

        result_data = {
            "status": "success",
            "c_dist_gold": int(c1_gold),
            "d_dist_gold": int(d1_gold),
            "b_period_label": f"{b_start} ~ {b_end}",
            "c_period_label": f"{c_start} ~ {c_end}",
            "d_period_label": f"{d_start} ~ {d_end}",
            "today_date": today_str,
            "yesterday_date": yesterday_str,
            "data": summary_list
        }
        
        _summary_cache["data"] = result_data
        _summary_cache["timestamp"] = now
        
        return result_data
        
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"분배금 요약 로드 실패: {str(e)}")

@app.get("/search/{name}")
def search_user(name: str):
    rows = get_all_rows()
    search = clean_id_string(name)
    
    summary_data = get_adena_summary()
    data_list = summary_data.get("data", [])
    
    for row in rows[2:]:
        if len(row) < 2: continue
        char_name_b = row[1].strip()
        if not char_name_b: continue
            
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
                    "c_dist_gold": summary_data.get("c_dist_gold", 0),
                    "d_dist_gold": summary_data.get("d_dist_gold", 0),
                    "c_contribution_rate": matched_stats.get("c_contribution_rate", 0.0),
                    "d_contribution_rate": matched_stats.get("d_contribution_rate", 0.0),
                    "c_distribution_gold": matched_stats.get("c_distribution_gold", 0),
                    "d_distribution_gold": matched_stats.get("d_distribution_gold", 0),
                    "today_points": matched_stats.get("today_points", 0.0),
                    "today_hours": matched_stats.get("today_hours", []),
                    "yesterday_points": matched_stats.get("yesterday_points", 0.0),
                    "yesterday_hours": matched_stats.get("yesterday_hours", []),
                    "b_period_points": matched_stats.get("b_period_points", 0.0),
                    "c_period_points": matched_stats.get("c_period_points", 0.0),
                    "c_daily_points": matched_stats.get("c_daily_points", [0.0] * 7),
                    "d_period_points": matched_stats.get("d_period_points", 0.0),
                    "d_daily_points": matched_stats.get("d_daily_points", [0.0] * 7), # 🎯 개별 유저 이번주 요일별 합산 배열 반환
                    "b_period_label": summary_data.get("b_period_label", ""),
                    "c_period_label": summary_data.get("c_period_label", ""),
                    "d_period_label": summary_data.get("d_period_label", ""),
                    "today_date": summary_data.get("today_date", ""),
                    "yesterday_date": summary_data.get("yesterday_date", "")
                }
            }
            
    raise HTTPException(status_code=404, detail="유저를 찾을 수 없습니다.")

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)