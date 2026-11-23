from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from database import supabase
from utils import CLASSES, SUPER_ADMIN, first_or_404, is_admin, join_csv, require_admin, split_csv

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


def validate_role_assignment(requester_role: str, target_new_role: str, existing_role: Optional[str] = None) -> str:
    require_admin(requester_role)
    if existing_role == SUPER_ADMIN and requester_role != SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="일반 관리자는 슈퍼관리자 계정을 수정할 수 없습니다.")
    if requester_role == SUPER_ADMIN:
        return target_new_role if target_new_role in [SUPER_ADMIN, "관리자", "일반회원"] else "일반회원"
    if target_new_role == SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="슈퍼관리자 권한은 슈퍼관리자만 부여할 수 있습니다.")
    return target_new_role if target_new_role in ["관리자", "일반회원"] else "일반회원"


def _member_row(req: MemberPayload, role: str) -> dict:
    email = (req.google_email or "").strip().lower() or None
    return {
        "unique_id": req.unique_id.strip(),
        "active_id": req.active_id.strip(),
        "char_class": req.char_class,
        "skills": req.skills,
        "clan": req.clan,
        "sub_chars": join_csv(split_csv(req.sub_chars, 3)),
        "google_email": email,
        "role": role
    }


@router.get("/skills")
def list_class_skills():
    try:
        rows = supabase.table("class_skills").select("*").order("sort_order").order("id").execute().data or []
        if rows:
            db_map = {c: [] for c in CLASSES}
            for r in rows:
                c = (r.get("char_class") or "").strip()
                s = (r.get("skill_name") or "").strip()
                if c and s and s not in db_map.setdefault(c, []):
                    db_map[c].append(s)
            return {"skills_by_class": db_map, "rows": rows}
    except Exception:
        pass
    return {"skills_by_class": {k: list(v) for k, v in DEFAULT_SKILLS.items()}, "rows": []}


@router.post("/skills")
def create_class_skill(req: SkillCreatePayload):
    require_admin(req.requester_role)
    char_class = (req.char_class or "").strip()
    skill_name = (req.skill_name or "").strip()
    if char_class not in CLASSES:
        raise HTTPException(status_code=400, detail="올바른 클래스를 선택해 주세요.")
    if not skill_name:
        raise HTTPException(status_code=400, detail="추가할 스킬명을 입력해 주세요.")

    dup = supabase.table("class_skills").select("id").eq("char_class", char_class).eq("skill_name", skill_name).execute()
    if dup.data:
        raise HTTPException(status_code=400, detail=f"[{char_class}] 클래스에 이미 [{skill_name}] 스킬이 등록되어 있습니다.")

    res = supabase.table("class_skills").insert({
        "char_class": char_class, "skill_name": skill_name, "sort_order": 99
    }).execute()
    return {"status": "created", "data": (res.data or [None])[0]}


@router.delete("/skills/{skill_id}")
def delete_class_skill(skill_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("class_skills").delete().eq("id", skill_id).execute()
    return {"status": "deleted"}


@router.get("/members")
def list_all_members():
    return supabase.table("members").select("*").order("id").execute().data or []


@router.post("/members")
def create_member(req: MemberPayload):
    role = validate_role_assignment(req.requester_role, req.role)
    res = supabase.table("members").insert(_member_row(req, role)).execute()
    return res.data[0]


@router.put("/members/{member_id}")
def update_member(member_id: int, req: MemberPayload):
    target = first_or_404(supabase.table("members").select("role").eq("id", member_id).execute(), "회원을 찾을 수 없습니다.")
    role = validate_role_assignment(req.requester_role, req.role, target.get("role"))
    res = supabase.table("members").update(_member_row(req, role)).eq("id", member_id).execute()
    return res.data[0]


@router.delete("/members/{member_id}")
def delete_member(member_id: int, requester_role: str):
    require_admin(requester_role, "권한이 없습니다.")
    target = supabase.table("members").select("role").eq("id", member_id).execute().data
    if target and target[0].get("role") == SUPER_ADMIN and requester_role != SUPER_ADMIN:
        raise HTTPException(status_code=403, detail="슈퍼관리자는 삭제할 수 없습니다.")
    supabase.table("members").delete().eq("id", member_id).execute()
    return {"status": "deleted"}
