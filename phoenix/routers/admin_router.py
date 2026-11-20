from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from database import supabase

router = APIRouter(prefix="/api/admin", tags=["Admin"])

DEFAULT_SKILLS = {
    "기사": ["스턴", "리덕", "솔캐", "바운스", "카베", "투망"],
    "요정": ["소울", "트리플", "왕바람", "왕어스", "소프", "씽", "게일", "어바", "똥물", "캔슬", "투망"],
    "법사": ["뮨", "캔슬", "미티어", "라톰", "파톰", "블리자드", "인비지", "투망"],
    "군주": [],
    "다크엘프": []
}

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

class SkillCreatePayload(BaseModel):
    char_class: str
    skill_name: str
    requester_role: str

def normalize_sub_chars(raw_sub: Optional[str]) -> str:
    if not raw_sub:
        return ""
    parts = [p.strip() for p in raw_sub.split(",") if p.strip()]
    return ", ".join(parts[:3])

def validate_role_assignment(requester_role: str, target_new_role: str, existing_role: Optional[str] = None) -> str:
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")

    if existing_role == "슈퍼관리자" and requester_role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="일반 관리자는 슈퍼관리자 계정을 수정할 수 없습니다.")

    if requester_role == "슈퍼관리자":
        return target_new_role if target_new_role in ["슈퍼관리자", "관리자", "일반회원"] else "일반회원"

    if target_new_role == "슈퍼관리자":
        raise HTTPException(status_code=403, detail="슈퍼관리자 권한은 슈퍼관리자만 부여할 수 있습니다.")
    return target_new_role if target_new_role in ["관리자", "일반회원"] else "일반회원"

def _build_default_skills_map():
    return {k: list(v) for k, v in DEFAULT_SKILLS.items()}

@router.get("/skills")
def list_class_skills():
    skills_map = _build_default_skills_map()
    try:
        res = supabase.table("class_skills").select("*").order("sort_order").order("id").execute()
        rows = res.data or []
        if rows:
            db_map = {"기사": [], "요정": [], "법사": [], "군주": [], "다크엘프": []}
            for r in rows:
                c = (r.get("char_class") or "").strip()
                s = (r.get("skill_name") or "").strip()
                if c and s:
                    db_map.setdefault(c, [])
                    if s not in db_map[c]:
                        db_map[c].append(s)
            return {"skills_by_class": db_map, "rows": rows}
    except Exception:
        pass
    return {"skills_by_class": skills_map, "rows": []}

@router.post("/skills")
def create_class_skill(req: SkillCreatePayload):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")

    char_class = (req.char_class or "").strip()
    skill_name = (req.skill_name or "").strip()
    if char_class not in ["기사", "요정", "법사", "군주", "다크엘프"]:
        raise HTTPException(status_code=400, detail="올바른 클래스를 선택해 주세요.")
    if not skill_name:
        raise HTTPException(status_code=400, detail="추가할 스킬명을 입력해 주세요.")

    dup = supabase.table("class_skills").select("id").eq("char_class", char_class).eq("skill_name", skill_name).execute()
    if dup.data:
        raise HTTPException(status_code=400, detail=f"[{char_class}] 클래스에 이미 [{skill_name}] 스킬이 등록되어 있습니다.")

    res = supabase.table("class_skills").insert({
        "char_class": char_class,
        "skill_name": skill_name,
        "sort_order": 99
    }).execute()
    return {"status": "created", "data": (res.data or [None])[0]}

@router.delete("/skills/{skill_id}")
def delete_class_skill(skill_id: int, requester_role: str):
    if requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")
    supabase.table("class_skills").delete().eq("id", skill_id).execute()
    return {"status": "deleted"}

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