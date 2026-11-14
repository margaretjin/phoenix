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
    role: str = "일반회원"
    requester_role: str

@router.get("/members")
def list_all_members():
    res = supabase.table("members").select("*").order("id").execute()
    return res.data

@router.post("/members")
def create_member(req: MemberPayload):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")
    
    # 일반 관리자는 권한을 일반회원으로만 생성 가능 (슈퍼관리자만 관리자/슈퍼관리자 임명 가능)
    assigned_role = req.role if req.requester_role == "슈퍼관리자" else "일반회원"

    data = {
        "unique_id": req.unique_id.strip(),
        "active_id": req.active_id.strip(),
        "char_class": req.char_class,
        "skills": req.skills,
        "clan": req.clan,
        "sub_chars": req.sub_chars.strip() if req.sub_chars else "",
        "role": assigned_role
    }
    res = supabase.table("members").insert(data).execute()
    return res.data[0]

@router.put("/members/{member_id}")
def update_member(member_id: int, req: MemberPayload):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")

    existing = supabase.table("members").select("*").eq("id", member_id).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="회원을 찾을 수 없습니다.")
    target = existing.data[0]

    update_data = {
        "unique_id": req.unique_id.strip(),
        "active_id": req.active_id.strip(),
        "char_class": req.char_class,
        "skills": req.skills,
        "clan": req.clan,
        "sub_chars": req.sub_chars.strip() if req.sub_chars else "",
    }

    # 슈퍼관리자만 관리자 임명(role 변경) 가능
    if req.requester_role == "슈퍼관리자":
        update_data["role"] = req.role
    else:
        if target["role"] == "슈퍼관리자":
            raise HTTPException(status_code=403, detail="일반 관리자는 슈퍼관리자 정보를 수정할 수 없습니다.")

    res = supabase.table("members").update(update_data).eq("id", member_id).execute()
    return res.data[0]

@router.delete("/members/{member_id}")
def delete_member(member_id: int, requester_role: str):
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="권한이 없습니다.")
    
    target = supabase.table("members").select("*").eq("id", member_id).execute().data
    if target and target[0]["role"] == "슈퍼관리자" and requester_role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="슈퍼관리자는 삭제할 수 없습니다.")

    supabase.table("members").delete().eq("id", member_id).execute()
    return {"status": "deleted"}