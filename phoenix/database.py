import os
from supabase import create_client, Client

# Render 환경 변수가 있으면 가져오고, 없으면 기본값(직접 입력한 값) 사용
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://dgmoxixblsuavgcnxecd.supabase.co").strip()
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "여기에_본인의_SUPABASE_KEY_붙여넣기").strip()

# PGRST125 에러 방지: URL 끝의 불필요한 슬래시(/)나 /rest/v1 자동 제거
if SUPABASE_URL.endswith("/rest/v1"):
    SUPABASE_URL = SUPABASE_URL[:-8]
SUPABASE_URL = SUPABASE_URL.rstrip("/")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase URL 또는 Key가 설정되지 않았습니다.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)