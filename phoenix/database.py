import os
import json
from pathlib import Path
from supabase import create_client, Client

# phoenix 폴더 기준 상위 또는 현재 폴더의 credentials.json 경로 설정
BASE_DIR = Path(__file__).resolve().parent
cred_path = BASE_DIR / "credentials.json" # 만약 상위 폴더에 있다면 BASE_DIR.parent / "credentials.json"으로 수정

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# 환경변수가 없고 credentials.json 파일이 존재한다면 파일에서 읽어옴
if (not SUPABASE_URL or not SUPABASE_KEY) and cred_path.exists():
    try:
        with open(cred_path, "r", encoding="utf-8") as f:
            cred_data = json.load(f)
            SUPABASE_URL = SUPABASE_URL or cred_data.get("SUPABASE_URL") or cred_data.get("url")
            SUPABASE_KEY = SUPABASE_KEY or cred_data.get("SUPABASE_KEY") or cred_data.get("key")
    except Exception as e:
        print(f"credentials.json 읽기 실패: {e}")

if SUPABASE_URL and SUPABASE_URL.endswith("/rest/v1"):
    SUPABASE_URL = SUPABASE_URL[:-8]
if SUPABASE_URL:
    SUPABASE_URL = SUPABASE_URL.rstrip("/")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase URL 또는 Key가 설정되지 않았습니다. credentials.json 내용을 확인해주세요.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)