import os
from supabase import create_client, Client

SUPABASE_URL = (os.environ.get("SUPABASE_URL") or "").strip()
SUPABASE_KEY = (os.environ.get("SUPABASE_KEY") or "").strip()

if SUPABASE_URL.endswith("/rest/v1"):
    SUPABASE_URL = SUPABASE_URL[:-8]
SUPABASE_URL = SUPABASE_URL.rstrip("/")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Supabase URL 또는 Key가 설정되지 않았습니다.")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)