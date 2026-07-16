import os
import json
import time
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
    CREDS = Credentials.from_service_account_info(creds_info, scopes=SCOPE)
else:
    json_path = os.path.join(os.path.dirname(__file__), "credentials.json")
    CREDS = Credentials.from_service_account_file(json_path, scopes=SCOPE)

client = gspread.authorize(CREDS)
# 피닉스 스프레드시트 ID
SPREADSHEET_ID = "1g_w9DtIdqfECHhadTtjsXA0EaIpe7r12x87Red5HXCE"
SHEET_NAME = "인원"

# --- [초경량 캐싱 시스템] 구글 API 호출 최소화 및 속도 극대화 ---
CACHE_TTL = 60  # 캐시 유지 시간(초) - 60초마다 구글 시트 새로고침
_cache = {"rows": None, "timestamp": 0}

def get_all_rows():
    now = time.time()
    if _cache["rows"] is None or (now - _cache["timestamp"]) > CACHE_TTL:
        try:
            doc = client.open_by_key(SPREADSHEET_ID)
            sheet = doc.worksheet(SHEET_NAME)
            _cache["rows"] = sheet.get_all_values()
            _cache["timestamp"] = now
            print(f"--- [시스템] 구글 시트 데이터 새로고침 완료 ({len(_cache['rows'])}행) ---")
        except Exception as e:
            if _cache["rows"] is not None:
                print("--- [경고] 구글 시트 연결 실패로 기존 캐시 데이터 반환 ---")
                return _cache["rows"]
            raise HTTPException(status_code=500, detail=f"구글 시트 로드 실패: {str(e)}")
    return _cache["rows"]

# --- 라우터 시작 ---
@app.api_route("/", methods=["GET", "HEAD"])
def read_index():
    return FileResponse(os.path.join(os.path.dirname(__file__), "main.html"))

@app.get("/.well-known/appspecific/com.chrome.devtools.json")
def chrome_devtools():
    return Response(status_code=204)

@app.get("/kurtz.html")
def kurtz(): return FileResponse("kurtz.html")

@app.get("/fire.html")
def fire(): return FileResponse("fire.html")

@app.get("/dragon.html")
def dragon(): return FileResponse("dragon.html")

@app.get("/search/{name}")
def search_user(name: str):
    rows = get_all_rows()
    # 입력받은 검색어에서 공백 제거 후 소문자화
    search = name.strip().replace(" ", "").lower()
    
    for row in rows[2:]:
        # 최소 C열(아이디, 인덱스 2)까지는 데이터가 있어야 함
        if len(row) < 3: 
            continue
            
        char_name = row[2].strip()  # C열: 아이디 (인덱스 2)
        if not char_name:
            continue
            
        # 괄호 제거 및 비교용 이름 생성 (공백 제거)
        clean_name = char_name.split("(")[0].strip().replace(" ", "").lower()
        
        # 완전 일치하거나 검색어가 포함되어 있으면 반환
        if clean_name == search or search in clean_name:
            return {
                "status": "success",
                "name": char_name,
                "character_class": row[3].strip() if len(row) > 3 else "",  # D열: 직업
                "skill": row[4].strip() if len(row) > 4 else "",            # E열: 기술
                "bloodline": row[5].strip() if len(row) > 5 else ""         # F열: 혈맹
            }
            
    raise HTTPException(status_code=404, detail="유저를 찾을 수 없습니다.")

@app.get("/bloodlines")
def get_bloodlines():
    try:
        rows = get_all_rows()
        bloodlines = []
        seen = set()
        for row in rows[2:]:
            # M열(인덱스 12)까지 데이터가 존재하는지 안전하게 확인
            if len(row) <= 12:
                continue
            name = row[12].strip()  # [변경] M열(인덱스 12): 혈맹 목록
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

# 특정 혈맹 구성원 조회
@app.get("/members/{bloodline}")
def get_bloodline_members(bloodline: str):
    if not bloodline or bloodline.lower() == "undefined":
        return {"bloodline": "없음", "remaining": 0, "members": []}

    try:
        rows = get_all_rows()
        target = bloodline.strip().lower()
        members = []
        for row in rows[2:]:
            if len(row) <= 5:
                continue
            member_id = row[2].strip()   # C열: 아이디 (인덱스 2)
            member_job = row[3].strip()  # D열: 직업 (인덱스 3)
            bloodline_val = row[5].strip().lower() # F열: 혈맹 (인덱스 5)
            
            if not member_id:
                continue
            if bloodline_val == target:
                members.append({"id": member_id, "job": member_job})

        job_order = {"군주": 0, "기사": 1, "요정": 2, "법사": 3 }
        members.sort(key=lambda item: (job_order.get(item.get("job", ""), 99), item.get("id", "").lower()))
        return {"bloodline": bloodline, "remaining": 40 - len(members), "members": members}
    except Exception:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="데이터 로드 실패")



if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
