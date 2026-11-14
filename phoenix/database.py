import os
import json
from supabase import create_client, Client

# credentials.json 파일 경로 설정 (main.py와 같은 폴더에 있다고 가정)
CRED_PATH = os.path.join(os.path.dirname(__file__), "credentials.json")

SUPABASE_URL = None
SUPABASE_KEY = None

# credentials.json 파일이 존재하면 읽어오기
if os.path.exists(CRED_PATH):
    try:
        with open(CRED_PATH, "r", encoding="utf-8") as f:
            cred_data = json.load(f)
            SUPABASE_URL = cred_data.get("SUPABASE_URL")
            SUPABASE_KEY = cred_data.get("SUPABASE_KEY")
    except Exception as e:
        print(f"credentials.json 읽기 오류: {e}")

# JSON에 없거나 파일이 없다면 환경변수(os.getenv)에서 가져오기 시도
SUPABASE_URL = SUPABASE_URL or os.getenv("SUPABASE_URL")
SUPABASE_KEY = SUPABASE_KEY or os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase URL 또는 Key가 설정되지 않았습니다. credentials.json 또는 환경변수를 확인하세요.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)