from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import supabase

router = APIRouter(prefix="/api/items", tags=["items"])

ADMIN_ROLES = {"슈퍼관리자", "관리자"}


class ItemPayload(BaseModel):
    item_name: str
    aliases: Optional[str] = ""
    default_price: int = 0
    clan_owned: bool = False   # 혈비귀속(분배금 제외) 아이템 여부
    event_item: bool = False   # 이벤트템 여부 (분배금 0원)
    requester_role: Optional[str] = ""


def _require_admin(role: Optional[str]):
    if (role or "").strip() not in ADMIN_ROLES:
        raise HTTPException(status_code=403, detail="관리자 이상만 아이템을 추가·수정·삭제할 수 있습니다.")


def _clean_aliases(item_name: str, aliases: Optional[str]) -> str:
    """별칭을 콤마로 정리 (공백/중복/본명과 같은 별칭 제거)"""
    seen = set()
    result = []
    for a in (aliases or "").replace("，", ",").split(","):
        a = a.strip()
        if not a or a == item_name or a.lower() in seen:
            continue
        seen.add(a.lower())
        result.append(a)
    return ", ".join(result)


@router.get("")
def list_items():
    res = supabase.table("item_master").select("*").order("item_name").execute()
    return res.data or []


@router.post("")
def create_item(payload: ItemPayload):
    _require_admin(payload.requester_role)
    name = payload.item_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="아이템 이름을 입력해 주세요.")

    exists = supabase.table("item_master").select("id").eq("item_name", name).execute()
    if exists.data:
        raise HTTPException(status_code=400, detail="이미 등록된 아이템입니다.")

    res = supabase.table("item_master").insert({
        "item_name": name,
        "aliases": _clean_aliases(name, payload.aliases),
        "default_price": max(0, int(payload.default_price or 0)),
        "clan_owned": bool(payload.clan_owned) and not payload.event_item,
        "event_item": bool(payload.event_item)
    }).execute()
    return {"ok": True, "data": (res.data or [None])[0]}


@router.put("/{item_id}")
def update_item(item_id: int, payload: ItemPayload):
    _require_admin(payload.requester_role)
    name = payload.item_name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="아이템 이름을 입력해 주세요.")

    dup = supabase.table("item_master").select("id").eq("item_name", name).neq("id", item_id).execute()
    if dup.data:
        raise HTTPException(status_code=400, detail="이미 등록된 아이템 이름입니다.")

    res = supabase.table("item_master").update({
        "item_name": name,
        "aliases": _clean_aliases(name, payload.aliases),
        "default_price": max(0, int(payload.default_price or 0)),
        "clan_owned": bool(payload.clan_owned) and not payload.event_item,
        "event_item": bool(payload.event_item)
    }).eq("id", item_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="아이템을 찾을 수 없습니다.")
    return {"ok": True, "data": res.data[0]}


@router.delete("/{item_id}")
def delete_item(item_id: int, role: str = ""):
    _require_admin(role)
    supabase.table("item_master").delete().eq("id", item_id).execute()
    return {"ok": True}