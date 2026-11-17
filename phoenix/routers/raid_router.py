import csv
import io
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
from database import supabase

router = APIRouter(prefix="/api/raids", tags=["Raids"])

RAID_TIMES = [
    "01시", "03시", "05시", "06시", "07시", "09시", "11시", "12시",
    "13시", "15시", "17시", "18시", "19시", "21시", "23시(오만)", "24시"
]

class PartyInfo(BaseModel):
    leader: str
    members: List[str]

class RaidSaveRequest(BaseModel):
    raid_date: str
    raid_time: str
    parties: List[PartyInfo]
    dropped_items: Optional[str] = None
    add_items: Optional[str] = None
    requester_role: str
    requester_id: str

class ItemDetailEntry(BaseModel):
    name: str
    sale_type: str = "보유중"       # "보유중" | "내판" | "외판" | "이벤트"
    price: int = 0
    winner: str = ""                # 수령자
    taken_date: str = ""            # 판매완료일
    dist_date: str = ""             # 분배완료일 (혈분배일)
    dist_checked: bool = False      # 디폴트값: 체크 안 된 상태(False)

class ItemDetailsUpdateRequest(BaseModel):
    raid_id: int
    item_details: List[ItemDetailEntry]
    requester_role: str

class MemberDistributionEntry(BaseModel):
    status: str = "분배대기"
    method: str = "본인수령"
    proxy_name: str = ""
    paid_date: str = ""

class DistributionUpdateRequest(BaseModel):
    raid_id: int
    distributions: Dict[str, MemberDistributionEntry]
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

def get_item_master_price_map() -> Dict[str, int]:
    try:
        res = supabase.table("item_master").select("item_name, default_price").execute()
        return {row["item_name"]: int(row.get("default_price") or 0) for row in (res.data or []) if row.get("item_name")}
    except Exception:
        return {}

def resolve_effective_item_price(item_dict: dict, price_map: Dict[str, int]) -> int:
    it_name = item_dict.get("name", "")
    winner_str = (item_dict.get("winner") or "").strip()
    s_type = item_dict.get("sale_type") or "보유중"
    saved_price = int(item_dict.get("price") or 0)
    default_price = price_map.get(it_name, 0)

    if winner_str and (s_type == "이벤트" or saved_price == 0):
        return 0
    if saved_price > 0:
        return saved_price
    return default_price

def sync_item_details_from_text(dropped_text: str, existing_details: list) -> list:
    tokens = [t.strip() for t in re.split(r'[\s,，\n]+', (dropped_text or '').strip()) if t.strip()]
    price_map = get_item_master_price_map()
    used_indices = set()
    synced = []

    for token in tokens:
        matched_item = None
        for idx, ex in enumerate(existing_details or []):
            if idx not in used_indices and ex.get("name") == token:
                matched_item = ex
                used_indices.add(idx)
                break
        default_p = price_map.get(token, 0)
        if matched_item:
            winner_str = (matched_item.get("winner") or "").strip()
            s_type = matched_item.get("sale_type") or "보유중"
            saved_p = int(matched_item.get("price") if matched_item.get("price") is not None else default_p)
            if not winner_str:
                s_type = "보유중"
                if saved_p == 0:
                    saved_p = default_p
            elif s_type == "이벤트" or saved_p == 0:
                s_type = "이벤트"
                saved_p = 0

            is_checked = bool(matched_item.get("dist_checked")) if (winner_str and s_type != "이벤트") else False
            synced.append({
                "name": token,
                "sale_type": s_type,
                "price": saved_p,
                "winner": winner_str,
                "taken_date": (matched_item.get("taken_date") or "") if winner_str else "",
                "dist_date": (matched_item.get("dist_date") or "") if is_checked else "",
                "dist_checked": is_checked
            })
        else:
            synced.append({
                "name": token,
                "sale_type": "보유중",
                "price": default_p,
                "winner": "",
                "taken_date": "",
                "dist_date": "",
                "dist_checked": False
            })
    return synced

def tokenize_items(text: Optional[str]) -> List[str]:
    return [t.strip() for t in re.split(r'[\s,，\n]+', (text or '').strip()) if t.strip()]

def extract_unique_participants(parties: list) -> List[str]:
    seen = set()
    ordered = []
    for p in (parties or []):
        leader = p.get("leader")
        if leader and leader not in seen:
            seen.add(leader)
            ordered.append(leader)
        for m in (p.get("members") or []):
            if m and m not in seen:
                seen.add(m)
                ordered.append(m)
    return ordered

@router.get("/times")
def get_raid_times():
    return {"times": RAID_TIMES}

@router.get("/tax-rate")
def fetch_tax_rate():
    return {"tax_rate": get_global_tax_rate()}

@router.post("/tax-rate")
def update_tax_rate(req: TaxRateUpdateRequest):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="혈비 비율은 관리자 이상만 수정할 수 있습니다.")
    if req.tax_rate < 0 or req.tax_rate > 100:
        raise HTTPException(status_code=400, detail="혈비 비율은 0~100% 사이여야 합니다.")

    supabase.table("clan_settings").upsert({
        "setting_key": "clan_tax_rate",
        "setting_value": str(req.tax_rate)
    }).execute()
    return {"status": "updated", "tax_rate": req.tax_rate}

@router.post("")
def save_raid(req: RaidSaveRequest):
    existing = supabase.table("raid_logs").select("*").eq("raid_date", req.raid_date).eq("raid_time", req.raid_time).execute()
    is_admin = req.requester_role in ["슈퍼관리자", "관리자"]
    new_parties_data = [p.model_dump() for p in req.parties]

    add_tokens = tokenize_items(req.add_items)

    if not is_admin and not new_parties_data and not add_tokens:
        raise HTTPException(status_code=403, detail="참여 인원 또는 드랍 아이템을 입력해야 합니다.")

    seen_new = set()
    for p in new_parties_data:
        for name in [p.get("leader")] + (p.get("members") or []):
            if name in seen_new:
                raise HTTPException(status_code=400, detail=f"[{name}] 아이디가 중복 입력되었습니다.")
            seen_new.add(name)

    for p in new_parties_data:
        party_size = 1 + len(p.get("members") or [])
        if party_size > 8:
            raise HTTPException(status_code=400, detail=f"[{p.get('leader')}] 파티 인원이 8명을 초과했습니다. (현재 {party_size}명)")

    if existing.data:
        row = existing.data[0]
        existing_parties = row.get("parties") or []

        if new_parties_data:
            existing_leaders = {p.get("leader") for p in existing_parties}
            if not is_admin and any(p["leader"] in existing_leaders for p in new_parties_data):
                raise HTTPException(status_code=403, detail="이미 등록된 파티입니다. 수정은 관리자에게 문의하세요.")

            leader_set = {p["leader"] for p in new_parties_data}
            kept_parties = [p for p in existing_parties if p.get("leader") not in leader_set]

            already = set(extract_unique_participants(kept_parties))
            dup_names = [n for n in seen_new if n in already]
            if dup_names:
                raise HTTPException(status_code=400, detail=f"이미 등록된 참여자입니다: {', '.join(dup_names)}")

            merged_parties = kept_parties + new_parties_data
        else:
            merged_parties = existing_parties

        existing_items = row.get("dropped_items") or ""
        existing_details = row.get("item_details") or []

        new_items = existing_items
        if is_admin and req.dropped_items is not None:
            new_items = req.dropped_items
        if add_tokens:
            new_items = " ".join(tokenize_items(new_items) + add_tokens)

        if new_items != existing_items:
            synced_details = sync_item_details_from_text(new_items, existing_details)
        else:
            synced_details = existing_details

        update_payload = {
            "parties": merged_parties,
            "dropped_items": new_items,
            "item_details": synced_details,
            "created_by": req.requester_id
        }
        res = supabase.table("raid_logs").update(update_payload).eq("id", row["id"]).execute()
        return {"status": "updated", "data": res.data[0]}
    else:
        new_items = req.dropped_items if (is_admin and req.dropped_items is not None) else ""
        if add_tokens:
            new_items = " ".join(tokenize_items(new_items) + add_tokens)
        synced_details = sync_item_details_from_text(new_items, []) if new_items else []
        current_tax = get_global_tax_rate()

        insert_payload = {
            "raid_date": req.raid_date,
            "raid_time": req.raid_time,
            "parties": new_parties_data,
            "dropped_items": new_items,
            "item_details": synced_details,
            "distributions": {},
            "clan_tax_rate": current_tax,
            "created_by": req.requester_id
        }
        res = supabase.table("raid_logs").insert(insert_payload).execute()
        return {"status": "created", "data": res.data[0]}

@router.post("/item-details")
def update_item_details(req: ItemDetailsUpdateRequest):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 아이템 정산 정보를 수정할 수 있습니다.")

    details_list = []
    for d in req.item_details:
        dump = d.model_dump()
        winner_str = (dump.get("winner") or "").strip()
        price_val = max(0, int(dump.get("price") or 0))
        dump["price"] = price_val

        if not winner_str:
            dump["sale_type"] = "보유중"
            dump["taken_date"] = ""
            dump["dist_checked"] = False
            dump["dist_date"] = ""
        elif price_val == 0 or dump.get("sale_type") == "이벤트":
            dump["sale_type"] = "이벤트"
            dump["price"] = 0
            dump["dist_checked"] = False
            dump["dist_date"] = ""

        details_list.append(dump)

    dropped_str = " ".join([d["name"] for d in details_list if d.get("name")])

    res = supabase.table("raid_logs").update({
        "item_details": details_list,
        "dropped_items": dropped_str
    }).eq("id", req.raid_id).execute()
    return {"status": "updated", "data": res.data[0]}

@router.delete("/item-details/{raid_id}/{item_idx}")
def delete_single_item_detail(raid_id: int, item_idx: int, role: str):
    if role != "슈퍼관리자":
        raise HTTPException(status_code=403, detail="슈퍼관리자만 아이템을 삭제할 수 있습니다.")

    row_res = supabase.table("raid_logs").select("*").eq("id", raid_id).execute()
    if not row_res.data:
        raise HTTPException(status_code=404, detail="해당 보스탐 기록을 찾을 수 없습니다.")

    row = row_res.data[0]
    details = row.get("item_details") or []

    if item_idx < 0 or item_idx >= len(details):
        raise HTTPException(status_code=400, detail="존재하지 않는 아이템 인덱스입니다.")

    details.pop(item_idx)
    dropped_str = " ".join([d["name"] for d in details if d.get("name")])

    res = supabase.table("raid_logs").update({
        "item_details": details,
        "dropped_items": dropped_str
    }).eq("id", raid_id).execute()

    return {"status": "deleted", "data": res.data[0]}

@router.post("/distributions")
def update_distributions(req: DistributionUpdateRequest):
    if req.requester_role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="분배금 설정은 관리자 이상만 가능합니다.")

    dist_dict = {k: v.model_dump() for k, v in req.distributions.items()}
    res = supabase.table("raid_logs").update({
        "distributions": dist_dict
    }).eq("id", req.raid_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 보스탐 기록을 찾을 수 없습니다.")
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

@router.delete("/member")
def delete_single_member(date: str, time: str, name: str, role: str):
    if role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 삭제할 수 있습니다.")

    existing = supabase.table("raid_logs").select("*").eq("raid_date", date).eq("raid_time", time).execute()
    if not existing.data:
        raise HTTPException(status_code=404, detail="기록을 찾을 수 없습니다.")

    row = existing.data[0]
    new_parties = []
    for p in (row.get("parties") or []):
        leader = p.get("leader")
        members = [m for m in (p.get("members") or []) if m != leader]
        if leader == name:
            if members:
                new_parties.append({"leader": members[0], "members": members[1:]})
        elif name in members:
            new_parties.append({"leader": leader, "members": [m for m in members if m != name]})
        else:
            new_parties.append(p)

    supabase.table("raid_logs").update({"parties": new_parties}).eq("id", row["id"]).execute()
    return {"status": "member_deleted"}

@router.get("")
def get_raids(month: Optional[str] = None, date: Optional[str] = None,
              start: Optional[str] = None, end: Optional[str] = None,
              member_id: Optional[str] = None):
    query = supabase.table("raid_logs").select("*").order("raid_date", desc=True).order("id", desc=True)
    if date:
        query = query.eq("raid_date", date)
    elif start and end:
        query = query.gte("raid_date", start).lte("raid_date", end)
    elif month:
        query = query.like("raid_date", f"{month}%")

    rows = query.execute().data or []
    if member_id:
        filtered = []
        for r in rows:
            participants = extract_unique_participants(r.get("parties") or [])
            if member_id in participants:
                filtered.append(r)
        return filtered
    return rows

@router.get("/export-excel")
def export_raids_excel(date: Optional[str] = None, month: Optional[str] = None,
                       start: Optional[str] = None, end: Optional[str] = None):
    query = supabase.table("raid_logs").select("*").order("raid_date", desc=False).order("id", desc=False)
    if date:
        query = query.eq("raid_date", date)
        filename_label = date
    elif start and end:
        query = query.gte("raid_date", start).lte("raid_date", end)
        filename_label = f"{start}_{end}"
    elif month:
        query = query.like("raid_date", f"{month}%")
        filename_label = month
    else:
        filename_label = "all"

    rows = query.execute().data or []
    default_tax = get_global_tax_rate()
    price_map = get_item_master_price_map()

    output = io.StringIO()
    output.write('\ufeff')
    writer = csv.writer(output)

    writer.writerow([
        "획득일", "보스탐 시간", "참여 인원수", "참여 명단",
        "아이템명", "구분", "판매 가격(아데나)", "수령자", "판매완료일", "체크여부", "분배완료일",
        "혈비 공제율(%)", "혈비 제외 분배풀", "1인당 분배금", "분배완료 인원", "미분배 인원"
    ])

    for r in rows:
        r_date = r.get("raid_date", "")
        r_time = r.get("raid_time", "")
        participants = extract_unique_participants(r.get("parties") or [])
        p_count = len(participants)
        p_names = ", ".join(participants)

        details = r.get("item_details") or []
        tax_rate = float(r.get("clan_tax_rate") if r.get("clan_tax_rate") is not None else default_tax)
        gross_total = sum(resolve_effective_item_price(d, price_map) for d in details)
        net_pool = int(gross_total * (1 - tax_rate / 100.0))
        per_share = (net_pool // p_count) if (p_count > 0 and net_pool > 0) else 0

        distributions = r.get("distributions") or {}
        done_list = []
        wait_list = []
        for member in participants:
            d_info = distributions.get(member) or {}
            if d_info.get("status") == "분배완료":
                method_str = d_info.get("method", "본인수령")
                proxy = d_info.get("proxy_name", "")
                label = f"{member}({method_str}:{proxy})" if (method_str == "대리수령" and proxy) else f"{member}({method_str})"
                done_list.append(label)
            else:
                wait_list.append(member)

        if not details:
            writer.writerow([
                r_date, r_time, p_count, p_names,
                "득템 없음", "-", 0, "-", "-", "-", "-",
                tax_rate, net_pool, per_share,
                ", ".join(done_list), ", ".join(wait_list)
            ])
        else:
            for item in details:
                it_name = item.get("name", "")
                s_type = item.get("sale_type", "보유중")
                it_price = resolve_effective_item_price(item, price_map)
                chk_str = "O" if item.get("dist_checked") else "X"
                writer.writerow([
                    r_date, r_time, p_count, p_names,
                    it_name, s_type, it_price,
                    item.get("winner", ""), item.get("taken_date", ""), chk_str, item.get("dist_date", ""),
                    tax_rate, net_pool, per_share,
                    ", ".join(done_list), ", ".join(wait_list)
                ])

    output.seek(0)
    headers = {
        "Content-Disposition": f'attachment; filename="phoenix_raid_{filename_label}.csv"'
    }
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv; charset=utf-8", headers=headers)

@router.delete("/{raid_id}")
def delete_raid(raid_id: int, role: str):
    if role not in ["슈퍼관리자", "관리자"]:
        raise HTTPException(status_code=403, detail="관리자 이상만 삭제할 수 있습니다.")
    supabase.table("raid_logs").delete().eq("id", raid_id).execute()
    return {"status": "deleted"}