from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from database import supabase

router = APIRouter(prefix="/api/auth", tags=["Auth"])

# 이메일을 최초 연결할 수 있는 슈퍼관리자 계정의 이메일 주소
SUPER_ADMIN_EMAILS = [
    "본인이메일@gmail.com"
]

class EmailPasswordLoginRequest(BaseModel):
    active_id: str
    email: str
    password: str
    password_confirmation: str

@router.post("/login")
def email_password_login(req: EmailPasswordLoginRequest):
    active_id = req.active_id.strip()
    email = req.email.strip().lower()
    password = req.password.strip()
    password_confirmation = req.password_confirmation.strip()

    if not active_id or not email or not password or not password_confirmation:
        raise HTTPException(status_code=400, detail="회원 아이디, 이메일, 비밀번호를 모두 입력해 주세요.")
    if password != password_confirmation:
        raise HTTPException(status_code=400, detail="비밀번호 확인이 일치하지 않습니다.")
    if email.count("@") != 1 or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(status_code=400, detail="올바른 이메일 주소를 입력해 주세요.")

    member_res = supabase.table("members").select("*").eq("active_id", active_id).execute()
    if not member_res.data:
        raise HTTPException(status_code=404, detail="회원 명단에서 아이디를 찾을 수 없습니다.")

    user = member_res.data[0]
    saved_email = (user.get("google_email") or "").strip().lower()
    saved_pw = (user.get("password") or "").strip()
    super_admin_emails = {address.lower() for address in SUPER_ADMIN_EMAILS}

    if saved_email and saved_email != email:
        raise HTTPException(status_code=401, detail="선택한 아이디에 등록된 이메일과 일치하지 않습니다.")

    if not saved_email:
        if email in super_admin_emails and user.get("role") != "슈퍼관리자":
            raise HTTPException(status_code=403, detail="최종관리자 이메일은 최종관리자 계정에만 연결할 수 있습니다.")
        if user.get("role") in ["관리자", "슈퍼관리자"] and not (
            user.get("role") == "슈퍼관리자" and email in super_admin_emails
        ):
            raise HTTPException(status_code=403, detail="관리자 계정은 사전 등록된 이메일로만 로그인할 수 있습니다.")

        email_owner = supabase.table("members").select("id").eq("google_email", email).execute()
        if any(member.get("id") != user["id"] for member in email_owner.data or []):
            raise HTTPException(status_code=409, detail="이미 다른 회원에게 연결된 이메일 주소입니다.")

        if saved_pw and saved_pw != password:
            raise HTTPException(status_code=401, detail="비밀번호가 일치하지 않습니다.")

        updates = {"google_email": email}
        status = "email_linked"
        if not saved_pw:
            updates["password"] = password
            status = "password_set"

        updated = supabase.table("members").update(updates).eq("id", user["id"]).execute()
        if not updated.data:
            raise HTTPException(status_code=500, detail="회원 로그인 정보를 저장하지 못했습니다.")
        user = updated.data[0]
    else:
        if email in super_admin_emails and user.get("role") != "슈퍼관리자":
            raise HTTPException(status_code=403, detail="최종관리자 이메일은 최종관리자 계정에만 연결할 수 있습니다.")
        if not saved_pw:
            updated = supabase.table("members").update({"password": password}).eq("id", user["id"]).execute()
            if not updated.data:
                raise HTTPException(status_code=500, detail="비밀번호를 저장하지 못했습니다.")
            user = updated.data[0]
            status = "password_set"
        elif saved_pw != password:
            raise HTTPException(status_code=401, detail="비밀번호가 일치하지 않습니다. 분실 시 관리자에게 비밀번호 재설정을 요청하세요.")
        else:
            status = "success"

    user.pop("password", None)
    return {"status": status, "user": user}

# 관리자가 특정 회원의 비밀번호를 지워서(초기화해서) 회원이 재입력하도록 만드는 엔드포인트
@router.post("/reset-password/{member_id}")
def reset_member_password(member_id: int, requester_role: str):
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 비밀번호를 초기화할 수 있습니다.")
    
    supabase.table("members").update({"password": ""}).eq("id", member_id).execute()
    return {"status": "password_cleared"}

@router.get("/search-members")
def search_members(q: Optional[str] = ""):
    query = supabase.table("members").select("id, unique_id, active_id, char_class, skills, clan, sub_chars, role, google_email, password")
    if q:
        query = query.or_(f"active_id.ilike.%{q}%,unique_id.ilike.%{q}%")
    rows = query.execute().data
    # 프론트엔드에는 실제 비밀번호 대신 설정 여부(has_password)만 내려주어 보안 유지
    for r in rows:
        r["has_password"] = bool((r.get("password") or "").strip())
        r.pop("password", None)
    return rows