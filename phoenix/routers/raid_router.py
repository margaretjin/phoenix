import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
from database import supabase

router = APIRouter(prefix="/api/raids", tags=["Raids"])

RAID_TIMES = [
    "09시", "11시", "12시", "13시", "15시", "17시", "18시", "19시",
    "21시", "22시(오만)", "23시", "24시", "01시", "03시", "05시", "07시"
]

class PartyInfo(BaseModel):
    leader: str
    members: List[str]

class RaidSaveRequest(BaseModel):
    raid_date: str
    raid_time: str
    parties: List[PartyInfo]
    dropped_items: Optional[str] = ""
    requester_role: str
    requester_id: str

class ItemDetailEntry(BaseModel):
    name: str
    price: int = 0
    winner: str = ""
    taken_date: str = ""

class ItemDetailsUpdateRequest(BaseModel):
    raid_id: int
    item_details: List[ItemDetailEntry]
    requester_role: str

class TaxRateUpdateRequest(BaseModel):
    tax_rate: float
    requester_role: str

def get_global_tax_rate() -> float:
    try:
        res = supabase.table("clan_settings").select("*").eq("setting_key", "clan_tax_rate").execute()
        if res.data:
            return float(res.data[0]["setting_value"])
    except Exception:
        pass
    return 20.0

# 띄어쓰기(또는 콤마)로 구분된 아이템 문자열을 기존 가격/당첨자 정보와 매칭하여 리스트로 구성
def sync_item_details_from_text(dropped_text: str, existing_details: list) -> list:
    tokens = [t.strip() for t in re.split(r'[\s,，\n]+', (dropped_text or '').strip()) if t.strip()]
    used_indices = set()
    synced = []

    for token in tokens:
        matched_item = None
        for idx, ex in enumerate(existing_details or []):
            if idx not in used_indices and ex.get("name") == token:
                matched_item = ex
                used_indices.add(idx)
                break
        if matched_item:
            synced.append({
                "name": token,
                "price": int(matched_item.get("price") or 0),
                "winner": matched_item.get("winner") or "",
                "taken_date": matched_item.get("taken_date") or ""
            })
        else:
            synced.append({
                "name": token,
                "price": 0,
                "winner": "",
                "taken_date": ""
            })
    return synced

@router.get("/times")
def get_raid_times():
    return {"times": RAID_TIMES}

@router.get("/tax-rate")
def fetch_tax_rate():
    return {"tax_rate": get_global_tax_rate()}

@router.post("/tax-rate")
def update_tax_rate(req: TaxRateUpdateRequest):
    if req.requester_role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="혈비 비율은 최종관리자(슈퍼관리자)만 수정할 수 있습니다.")
    if req.tax_rate < 0 or req.tax_rate > 100:
        raise HTTPException(status_code=400, detail="혈비 비율은 0~100% 사이여야 합니다.")

    supabase.table("clan_settings").upsert({
        "setting_key": "clan_tax_rate",
        "setting_value": str(req.tax_rate)
    }).execute()
    return {"status": "updated", "tax_rate": req.tax_rate}

@router.get("/check-exist")
def check_raid_exist(date: str, time: str):
    res = supabase.table("raid_logs").select("*").eq("raid_date", date).eq("raid_time", time).execute()
    if res.data:
        return {"exists": True, "data": res.data[0]}
    return {"exists": False}

@router.post("")
def save_raid(req: RaidSaveRequest):
    existing = supabase.table("raid_logs").select("*").eq("raid_date", req.raid_date).eq("raid_time", req.raid_time).execute()
    
    is_admin = req.requester_role in ["슈퍼관리자", "관리자"]
    new_parties_data = [p.model_dump() for p in req.parties]

    if not is_admin and not new_parties_data:
        raise HTTPException(status_code=403, detail="일반회원은 참여 인원을 입력해야 합니다.")

    if existing.data:
        row = existing.data[0]
        existing_parties = row.get("parties") or []
        
        if new_parties_data:
            existing_leaders = {p.get("leader") for p in existing_parties}
            if not is_admin and any(p["leader"] in existing_leaders for p in new_parties_data):
                raise HTTPException(status_code=403, detail="이미 등록된 파티입니다. 수정이나 정정은 관리자에게 문의하세요.")
            
            leader_set = {p["leader"] for p in new_parties_data}
            merged_parties = [p for p in existing_parties if p.get("leader") not in leader_set] + new_parties_data
        else:
            merged_parties = existing_parties

        existing_items = row.get("dropped_items", "")
        new_items = req.dropped_items if is_admin else existing_items
        
        existing_details = row.get("item_details") or []
        synced_details = sync_item_details_from_text(new_items, existing_details) if is_admin else existing_details

        update_payload = {
            "parties": merged_parties,
            "dropped_items": new_items,
            "item_details": synced_details,
            "created_by": req.requester_id
        }
        try:
            res = supabase.table("raid_logs").update(update_payload).eq("id", row["id"]).execute()
        except Exception:
            update_payload.pop("item_details", None)
            res = supabase.table("raid_logs").update(update_payload).eq("id", row["id"]).execute()
        
        return {"status": "updated", "data": res.data[0]}
    else:
        new_items = req.dropped_items if is_admin else ""
        synced_details = sync_item_details_from_text(new_items, []) if is_admin else []
        current_tax = get_global_tax_rate()

        insert_payload = {
            "raid_date": req.raid_date,
            "raid_time": req.raid_time,
            "parties": new_parties_data,
            "dropped_items": new_items,
            "item_details": synced_details,
            "clan_tax_rate": current_tax,
            "created_by": req.requester_id
        }
        try:
            res = supabase.table("raid_logs").insert(insert_payload).execute()
        except Exception:
            insert_payload.pop("item_details", None)
            insert_payload.pop("clan_tax_rate", None)
            res = supabase.table("raid_logs").insert(insert_payload).execute()
        
        return {"status": "created", "data": res.data[0]}

@router.post("/item-details")
def update_item_details(req: ItemDetailsUpdateRequest):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 아이템 가격 및 당첨자를 입력/수정할 수 있습니다.")
    
    details_list = [d.model_dump() for d in req.item_details]
    dropped_str = " ".join([d["name"] for d in details_list if d.get("name")])

    res = supabase.table("raid_logs").update({
        "item_details": details_list,
        "dropped_items": dropped_str
    }).eq("id", req.raid_id).execute()
    return {"status": "updated", "data": res.data[0]}

@router.delete("/party")
def delete_single_party(date: str, time: str, leader: str, role: str):
    if role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 삭제할 수 있습니다.")
    
    existing = supabase.table("raid_logs").select("*").eq("raid_date", date).eq("raid_time", time).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.")
    
    row = existing.data[0]
    updated_parties = [p for p in (row.get("parties") or []) if p.get("leader") != leader]
    
    supabase.table("raid_logs").update({"parties": updated_parties}).eq("id", row["id"]).execute()
    return {"status": "party_deleted"}

@router.get("")
def get_raids(month: Optional[str] = None, date: Optional[str] = None, member_id: Optional[str] = None):
    query = supabase.table("raid_logs").select("*").order("raid_date", desc=True).order("id", desc=True)
    if date:
        query = query.eq("raid_date", date)
    elif month:
        query = query.like("raid_date", f"{month}%")
    
    rows = query.execute().data
    if member_id:
        filtered = []
        for r in rows:
            parties = r.get("parties") or []
            matched = any(p.get("leader") == member_id or member_id in p.get("members", []) for p in parties)
            if matched:
                filtered.append(r)
        return filtered
    return rows

@router.delete("/{raid_id}")
def delete_raid(raid_id: int, role: str):
    if role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 삭제할 수 있습니다.")
    supabase.table("raid_logs").delete().eq("id", raid_id).execute()
    return {"status": "deleted"}