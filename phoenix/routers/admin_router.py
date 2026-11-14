from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from database import supabase

router = APIRouter(prefix="/api/admin", tags=["Admin"])

class MemberPayload(BaseModel):
    unique_id: str
    active_id: str
    char_class: str
    skills: List[str]
    clan: str
    sub_chars: Optional[str] = ""
    google_email: Optional[str] = None
    role: str = "일반회원"
    requester_role: str

def normalize_sub_chars(raw_sub: Optional[str]) -> str:
    if not raw_sub:
        return ""
    parts = [p.strip() for p in raw_sub.split(",") if p.strip()]
    return ", ".join(parts[:3])  # 최대 3개까지만 허용

def validate_role_assignment(requester_role: str, target_new_role: str, existing_role: Optional[str] = None) -> str:
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")

    if existing_role == "슈퍼관리자" and requester_role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="일반 관리자는 슈퍼관리자 계정을 수정할 수 없습니다.")

    if requester_role == "슈퍼관리자":
        return target_new_role if target_new_role in ["슈퍼관리자", "관리자", "일반회원"] else "일반회원"

    # 일반 관리자는 '관리자'와 '일반회원'만 선택 가능
    if target_new_role == "슈퍼관리자":
        raise HTTPException(status_code=403, detail="슈퍼관리자 권한은 슈퍼관리자만 부여할 수 있습니다.")
    return target_new_role if target_new_role in ["관리자", "일반회원"] else "일반회원"

@router.get("/members")
def list_all_members():
    res = supabase.table("members").select("*").order("id").execute()
    return res.data or []

@router.post("/members")
def create_member(req: MemberPayload):
    assigned_role = validate_role_assignment(req.requester_role, req.role)
    email_val = req.google_email.strip().lower() if req.google_email and req.google_email.strip() else None

    data = {
        "unique_id": req.unique_id.strip(),
        "active_id": req.active_id.strip(),
        "char_class": req.char_class,
        "skills": req.skills,
        "clan": req.clan,
        "sub_chars": normalize_sub_chars(req.sub_chars),
        "google_email": email_val,
        "role": assigned_role
    }
    res = supabase.table("members").insert(data).execute()
    return res.data[0]

@router.put("/members/{member_id}")
def update_member(member_id: int, req: MemberPayload):
    existing = supabase.table("members").select("*").eq("id", member_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
    target = existing.data[0]

    assigned_role = validate_role_assignment(req.requester_role, req.role, target.get("role"))
    email_val = req.google_email.strip().lower() if req.google_email and req.google_email.strip() else None

    update_data = {
        "unique_id": req.unique_id.strip(),
        "active_id": req.active_id.strip(),
        "char_class": req.char_class,
        "skills": req.skills,
        "clan": req.clan,
        "sub_chars": normalize_sub_chars(req.sub_chars),
        "google_email": email_val,
        "role": assigned_role
    }

    res = supabase.table("members").update(update_data).eq("id", member_id).execute()
    return res.data[0]

@router.delete("/members/{member_id}")
def delete_member(member_id: int, requester_role: str):
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    target = supabase.table("members").select("*").eq("id", member_id).execute().data
    if target and target[0].get("role") == "슈퍼관리자" and requester_role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="슈퍼관리자는 삭제할 수 없습니다.")

    supabase.table("members").delete().eq("id", member_id).execute()
    return {"status": "deleted"}