from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import supabase
from utils import require_admin

router = APIRouter(prefix="/api/auth", tags=["Auth"])

MEMBER_PUBLIC_COLUMNS = "id, unique_id, active_id, char_class, skills, clan, sub_chars, role, google_email"


class EmailLoginRequest(BaseModel):
    active_id: str
    email: str


@router.post("/login")
def email_only_login(req: EmailLoginRequest):
    active_id = req.active_id.strip()
    email = req.email.strip().lower()

    if not active_id or not email:
        raise HTTPException(status_code=400, detail="회원 아이디와 이메일 주소를 모두 입력해 주세요.")
    if email.count("@") != 1 or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(status_code=400, detail="올바른 이메일 주소를 입력해 주세요.")

    member_res = supabase.table("members").select("*").eq("active_id", active_id).execute()
    if not member_res.data:
        raise HTTPException(status_code=404, detail="회원 명단에서 아이디를 찾을 수 없습니다.")

    user = member_res.data[0]
    saved_email = (user.get("google_email") or "").strip().lower()

    # 1. 이미 이메일이 등록된 회원 -> 입력한 이메일이 비밀번호 역할 수행
    if saved_email:
        if saved_email != email:
            raise HTTPException(status_code=401, detail="등록된 이메일 주소와 일치하지 않습니다. 관리자에게 문의하세요.")
        return {"status": "login_success", "user": user}

    # 2. 이메일 미등록 회원 -> 타 회원 중복 체크 후 즉시 등록(가입 완료)
    dup_check = supabase.table("members").select("id").eq("google_email", email).execute()
    if any(m.get("id") != user["id"] for m in (dup_check.data or [])):
        raise HTTPException(status_code=409, detail="이미 다른 캐릭터에 등록된 이메일 주소입니다.")

    updated = supabase.table("members").update({"google_email": email}).eq("id", user["id"]).execute()
    if not updated.data:
        raise HTTPException(status_code=500, detail="이메일 등록 중 오류가 발생했습니다.")
    return {"status": "email_registered", "user": updated.data[0]}


@router.post("/reset-email/{member_id}")
def reset_member_email(member_id: int, requester_role: str):
    require_admin(requester_role, "관리자 이상만 이메일을 초기화할 수 있습니다.")
    supabase.table("members").update({"google_email": None}).eq("id", member_id).execute()
    return {"status": "email_cleared"}


@router.get("/search-members")
def search_members(q: Optional[str] = ""):
    query = supabase.table("members").select(MEMBER_PUBLIC_COLUMNS).order("active_id")
    if q:
        query = query.or_(f"active_id.ilike.%{q}%,unique_id.ilike.%{q}%,sub_chars.ilike.%{q}%")
    rows = query.execute().data or []
    for r in rows:
        r["has_email"] = bool((r.get("google_email") or "").strip())
    return rows
