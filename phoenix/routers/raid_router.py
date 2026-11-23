import csv
import io
import re
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
from database import supabase
from utils import first_or_404, is_admin, require_admin, require_super

router = APIRouter(prefix="/api/raids", tags=["Raids"])

RAID_TIMES = [
    "01시", "03시", "05시", "06시", "07시", "09시", "11시", "12시",
    "13시", "15시", "17시", "18시", "19시", "21시", "23시(오만)", "24시", "용레이드", "공성"
]  # 공성은 일요일에만 사용

ALLIANCE_CLANS = ["반항", "세븐"]
OWN_CLAN = "피닉스"
DEFAULT_TAX_RATE = 20.0
TOKEN_SPLIT = re.compile(r'[\s,，\n]+')


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
    sale_type: str = "보유중"       # "보유중"(=연합분배대기) | "연합" | "내판" | "외판" | "이벤트" | "성세금포함" | "분배금혈귀"
    alliance: str = ""              # 획득 혈: "" (연합분배대기) | "피닉스" | "반항" | "세븐"
    price: int = 0
    winner: str = ""                # 수령자
    taken_date: str = ""            # 수령완료일
    dist_date: str = ""             # 분배완료일 (혈분배일)
    dist_checked: bool = False      # 디폴트값: 체크 안 된 상태(False)
    castle_tax_date: str = ""       # 성세금포함 대상 성세금 날짜 (YYYY-MM-DD)


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


# ---------------------------------------------------------------------------
# 공통 조회 헬퍼
# ---------------------------------------------------------------------------
def get_global_tax_rate() -> float:
    try:
        res = supabase.table("clan_settings").select("setting_value").eq("setting_key", "clan_tax_rate").execute()
        if res.data:
            return float(res.data[0]["setting_value"])
    except Exception:
        pass
    return DEFAULT_TAX_RATE


def get_item_master_rows() -> list:
    try:
        return supabase.table("item_master").select("*").execute().data or []
    except Exception:
        return []


def build_price_map(rows: list) -> Dict[str, int]:
    return {r["item_name"]: int(r.get("default_price") or 0) for r in rows if r.get("item_name")}


def build_excluded_set(rows: list) -> set:
    """분배금 제외 아이템(혈비귀속 + 이벤트템) 이름 집합"""
    return {r["item_name"] for r in rows if r.get("item_name") and (r.get("clan_owned") or r.get("event_item"))}


def tokenize_items(text: Optional[str]) -> List[str]:
    return [t for t in TOKEN_SPLIT.split((text or "").strip()) if t]


def extract_unique_participants(parties: list) -> List[str]:
    seen, ordered = set(), []
    for p in (parties or []):
        for name in [p.get("leader")] + list(p.get("members") or []):
            if name and name not in seen:
                seen.add(name)
                ordered.append(name)
    return ordered


def get_raid_by_slot(date: str, time: str) -> dict:
    res = supabase.table("raid_logs").select("*").eq("raid_date", date).eq("raid_time", time).execute()
    return first_or_404(res, "기록을 찾을 수 없습니다.")


def apply_period_filter(query, date: Optional[str], month: Optional[str], start: Optional[str], end: Optional[str]):
    if date:
        return query.eq("raid_date", date)
    if start and end:
        return query.gte("raid_date", start).lte("raid_date", end)
    if month:
        return query.like("raid_date", f"{month}%")
    return query


def resolve_effective_item_price(item_dict: dict, price_map: Dict[str, int]) -> int:
    winner_str = (item_dict.get("winner") or "").strip()
    s_type = item_dict.get("sale_type") or "보유중"
    saved_price = int(item_dict.get("price") or 0)
    if winner_str and (s_type == "이벤트" or saved_price == 0):
        return 0
    if saved_price > 0:
        return saved_price
    return price_map.get(item_dict.get("name", ""), 0)


def is_castle_tax_name(name: Optional[str]) -> bool:
    return "성세금" in (name or "").strip()


# ---------------------------------------------------------------------------
# 아이템 상세 정규화
# ---------------------------------------------------------------------------
def new_detail(name: str, price: int) -> dict:
    return {
        "name": name, "sale_type": "보유중", "alliance": "", "price": price, "winner": "",
        "taken_date": "", "dist_date": "", "dist_checked": False, "castle_tax_date": ""
    }


def normalize_detail(d: dict) -> dict:
    """아이템 진행 단계 규칙을 한 곳에서 적용.
    성세금 / 성세금포함은 수령자 없이도 분배 체크(dist_checked) 및 혈분배일(dist_date) 유지
    """
    out = dict(d)
    is_castle_tax = is_castle_tax_name(out.get("name"))
    alliance = (out.get("alliance") or "").strip()
    sale_type = out.get("sale_type") or "보유중"
    winner = (out.get("winner") or "").strip()
    price = max(0, int(out.get("price") or 0))
    castle_tax_date = (out.get("castle_tax_date") or "").strip()

    def clear_dist():
        out["dist_checked"] = False
        out["dist_date"] = ""

    def keep_castle_included():
        out["sale_type"] = "성세금포함"
        out["castle_tax_date"] = castle_tax_date
        if not out.get("dist_checked"):
            out["dist_date"] = ""

    if alliance in ALLIANCE_CLANS:
        out.update(alliance=alliance, sale_type="연합", castle_tax_date="")
        clear_dist()
    elif alliance == OWN_CLAN:
        out["alliance"] = alliance
        if sale_type == "이벤트":
            out.update(sale_type="이벤트", castle_tax_date="")
            price = 0
            clear_dist()
        elif sale_type == "성세금포함":
            keep_castle_included()
        elif sale_type == "분배금혈귀":
            out.update(sale_type="분배금혈귀", castle_tax_date="")
            clear_dist()
        elif sale_type in ("내판", "외판"):
            out.update(sale_type=sale_type, castle_tax_date="")
            if not winner and not is_castle_tax:
                clear_dist()
        else:
            out.update(sale_type="보유중", castle_tax_date="")
            if not is_castle_tax:
                clear_dist()
    else:
        out["alliance"] = ""
        if sale_type == "성세금포함":
            keep_castle_included()
        elif sale_type == "연합":
            out["castle_tax_date"] = ""
            clear_dist()
        elif not winner:
            out.update(sale_type="보유중", taken_date="", castle_tax_date="")
            if not is_castle_tax:
                clear_dist()
        elif price == 0 or sale_type == "이벤트":
            out.update(sale_type="이벤트", castle_tax_date="")
            price = 0
            clear_dist()

    if out["sale_type"] == "보유중" and not winner:
        out["taken_date"] = ""
    out["price"] = price
    return out


def sync_item_details_from_text(dropped_text: str, existing_details: list) -> list:
    price_map = build_price_map(get_item_master_rows())
    used_indices = set()
    synced = []

    for token in tokenize_items(dropped_text):
        default_p = price_map.get(token, 0)
        matched = None
        for idx, ex in enumerate(existing_details or []):
            if idx not in used_indices and ex.get("name") == token:
                matched = ex
                used_indices.add(idx)
                break

        if not matched:
            synced.append(new_detail(token, default_p))
            continue

        saved_p = int(matched.get("price") if matched.get("price") is not None else default_p)
        if (matched.get("sale_type") or "보유중") == "보유중" and saved_p == 0:
            saved_p = default_p
        synced.append(normalize_detail({
            "name": token,
            "sale_type": matched.get("sale_type") or "보유중",
            "alliance": matched.get("alliance") or "",
            "price": saved_p,
            "winner": (matched.get("winner") or "").strip(),
            "taken_date": matched.get("taken_date") or "",
            "dist_date": matched.get("dist_date") or "",
            "dist_checked": bool(matched.get("dist_checked")),
            "castle_tax_date": matched.get("castle_tax_date") or ""
        }))
    return synced


def dropped_text_of(details: list) -> str:
    return " ".join(d["name"] for d in details if d.get("name"))


# ---------------------------------------------------------------------------
# 엔드포인트
# ---------------------------------------------------------------------------
@router.get("/times")
def get_raid_times():
    return {"times": RAID_TIMES}


@router.get("/tax-rate")
def fetch_tax_rate():
    return {"tax_rate": get_global_tax_rate()}


@router.post("/tax-rate")
def update_tax_rate(req: TaxRateUpdateRequest):
    require_admin(req.requester_role, "혈비 비율은 관리자 이상만 수정할 수 있습니다.")
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
    admin = is_admin(req.requester_role)
    new_parties_data = [p.model_dump() for p in req.parties]
    add_tokens = tokenize_items(req.add_items)

    if not admin and not new_parties_data and not add_tokens:
        raise HTTPException(status_code=403, detail="참여 인원 또는 드랍 아이템을 입력해야 합니다.")

    seen_new = set()
    for p in new_parties_data:
        names = [p.get("leader")] + (p.get("members") or [])
        for name in names:
            if name in seen_new:
                raise HTTPException(status_code=400, detail=f"[{name}] 아이디가 중복 입력되었습니다.")
            seen_new.add(name)
        if len(names) > 8:
            raise HTTPException(status_code=400, detail=f"[{p.get('leader')}] 파티 인원이 8명을 초과했습니다. (현재 {len(names)}명)")

    if existing.data:
        row = existing.data[0]
        existing_parties = row.get("parties") or []

        if new_parties_data:
            existing_leaders = {p.get("leader") for p in existing_parties}
            if not admin and any(p["leader"] in existing_leaders for p in new_parties_data):
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
        new_items = req.dropped_items if (admin and req.dropped_items is not None) else existing_items
        if add_tokens:
            new_items = " ".join(tokenize_items(new_items) + add_tokens)

        synced_details = (sync_item_details_from_text(new_items, existing_details)
                          if new_items != existing_items else existing_details)

        res = supabase.table("raid_logs").update({
            "parties": merged_parties,
            "dropped_items": new_items,
            "item_details": synced_details,
            "created_by": req.requester_id
        }).eq("id", row["id"]).execute()
        return {"status": "updated", "data": res.data[0]}

    new_items = req.dropped_items if (admin and req.dropped_items is not None) else ""
    if add_tokens:
        new_items = " ".join(tokenize_items(new_items) + add_tokens)

    res = supabase.table("raid_logs").insert({
        "raid_date": req.raid_date,
        "raid_time": req.raid_time,
        "parties": new_parties_data,
        "dropped_items": new_items,
        "item_details": sync_item_details_from_text(new_items, []) if new_items else [],
        "distributions": {},
        "clan_tax_rate": get_global_tax_rate(),
        "created_by": req.requester_id
    }).execute()
    return {"status": "created", "data": res.data[0]}


@router.post("/item-details")
def update_item_details(req: ItemDetailsUpdateRequest):
    require_admin(req.requester_role, "관리자 이상만 아이템 정산 정보를 수정할 수 있습니다.")
    details_list = [normalize_detail(d.model_dump()) for d in req.item_details]
    update_payload = {"item_details": details_list, "dropped_items": dropped_text_of(details_list)}

    # 성세금포함 아이템은 드랍 당시 참여자가 아니라 '해당 일자 공성 참여자'가 가져간다.
    # 따라서 이 보스탐 기록의 아이템이 전부 성세금포함이면 기존 참여자(파티)·분배 기록을 비운다.
    # (다른 아이템이 섞여 있으면 그 아이템의 분배 대상이 사라지므로 참여자는 유지)
    if details_list and all(d.get("sale_type") == "성세금포함" for d in details_list):
        raid_row = supabase.table("raid_logs").select("raid_time").eq("id", req.raid_id).execute()
        raid_time = (raid_row.data[0].get("raid_time") if raid_row.data else "") or ""
        if raid_time != "공성":
            update_payload["parties"] = []
            update_payload["distributions"] = {}

    res = supabase.table("raid_logs").update(update_payload).eq("id", req.raid_id).execute()
    return {"status": "updated", "data": res.data[0]}


@router.delete("/item-details/{raid_id}/{item_idx}")
def delete_single_item_detail(raid_id: int, item_idx: int, role: str):
    require_super(role, "슈퍼관리자만 아이템을 삭제할 수 있습니다.")
    row = first_or_404(supabase.table("raid_logs").select("item_details").eq("id", raid_id).execute(),
                       "해당 보스탐 기록을 찾을 수 없습니다.")
    details = row.get("item_details") or []
    if item_idx < 0 or item_idx >= len(details):
        raise HTTPException(status_code=400, detail="존재하지 않는 아이템 인덱스입니다.")

    details.pop(item_idx)
    res = supabase.table("raid_logs").update({
        "item_details": details,
        "dropped_items": dropped_text_of(details)
    }).eq("id", raid_id).execute()
    return {"status": "deleted", "data": res.data[0]}


@router.post("/distributions")
def update_distributions(req: DistributionUpdateRequest):
    require_admin(req.requester_role, "분배금 설정은 관리자 이상만 가능합니다.")
    dist_dict = {k: v.model_dump() for k, v in req.distributions.items()}
    res = supabase.table("raid_logs").update({"distributions": dist_dict}).eq("id", req.raid_id).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="해당 보스탐 기록을 찾을 수 없습니다.")
    return {"status": "updated", "data": res.data[0]}


@router.delete("/party")
def delete_single_party(date: str, time: str, leader: str, role: str):
    require_admin(role, "관리자 이상만 삭제할 수 있습니다.")
    row = get_raid_by_slot(date, time)
    updated_parties = [p for p in (row.get("parties") or []) if p.get("leader") != leader]
    supabase.table("raid_logs").update({"parties": updated_parties}).eq("id", row["id"]).execute()
    return {"status": "party_deleted"}


@router.delete("/member")
def delete_single_member(date: str, time: str, name: str, role: str):
    require_admin(role, "관리자 이상만 삭제할 수 있습니다.")
    row = get_raid_by_slot(date, time)
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
    rows = apply_period_filter(query, date, month, start, end).execute().data or []
    if member_id:
        return [r for r in rows if member_id in extract_unique_participants(r.get("parties") or [])]
    return rows


@router.get("/export-excel")
def export_raids_excel(date: Optional[str] = None, month: Optional[str] = None,
                       start: Optional[str] = None, end: Optional[str] = None):
    query = supabase.table("raid_logs").select("*").order("raid_date", desc=False).order("id", desc=False)
    rows = apply_period_filter(query, date, month, start, end).execute().data or []
    filename_label = date or (f"{start}_{end}" if start and end else None) or month or "all"

    default_tax = get_global_tax_rate()
    master_rows = get_item_master_rows()          # 아이템 마스터 1회 조회로 가격/제외 목록 동시 생성
    price_map = build_price_map(master_rows)
    excluded_set = build_excluded_set(master_rows)

    output = io.StringIO()
    output.write('﻿')
    writer = csv.writer(output)
    writer.writerow([
        "획득일", "보스탐 시간", "참여 인원수", "참여 명단",
        "아이템명", "구분", "판매 가격(아데나)", "수령자", "수령완료일", "체크여부", "분배완료일",
        "혈비 공제율(%)", "혈비 제외 분배풀", "1인당 분배금", "분배완료 인원", "미분배 인원"
    ])

    for r in rows:
        participants = extract_unique_participants(r.get("parties") or [])
        p_count = len(participants)
        base_cols = [r.get("raid_date", ""), r.get("raid_time", ""), p_count, ", ".join(participants)]

        details = r.get("item_details") or []
        tax_rate = float(r.get("clan_tax_rate") if r.get("clan_tax_rate") is not None else default_tax)
        gross_total = sum(
            resolve_effective_item_price(d, price_map)
            for d in details
            if (d.get("sale_type") in ["내판", "외판"] or is_castle_tax_name(d.get("name"))) and d.get("name") not in excluded_set
        )
        net_pool = int(gross_total * (1 - tax_rate / 100.0))
        per_share = (net_pool // p_count) if (p_count > 0 and net_pool > 0) else 0

        distributions = r.get("distributions") or {}
        done_list, wait_list = [], []
        for member in participants:
            d_info = distributions.get(member) or {}
            if d_info.get("status") == "분배완료":
                method_str = d_info.get("method", "본인수령")
                proxy = d_info.get("proxy_name", "")
                done_list.append(f"{member}({method_str}:{proxy})" if (method_str == "대리수령" and proxy) else f"{member}({method_str})")
            else:
                wait_list.append(member)
        tail_cols = [tax_rate, net_pool, per_share, ", ".join(done_list), ", ".join(wait_list)]

        if not details:
            writer.writerow(base_cols + ["득템 없음", "-", 0, "-", "-", "-", "-"] + tail_cols)
            continue
        for item in details:
            it_name = item.get("name", "")
            s_type = item.get("sale_type", "보유중")
            checked = item.get("dist_checked") and (s_type in ["내판", "외판", "성세금포함"] or is_castle_tax_name(it_name))
            writer.writerow(base_cols + [
                it_name, s_type, resolve_effective_item_price(item, price_map),
                item.get("winner", ""), item.get("taken_date", ""), "O" if checked else "X", item.get("dist_date", "")
            ] + tail_cols)

    headers = {"Content-Disposition": f'attachment; filename="phoenix_raid_{filename_label}.csv"'}
    return StreamingResponse(iter([output.getvalue()]), media_type="text/csv; charset=utf-8", headers=headers)


@router.delete("/{raid_id}")
def delete_raid(raid_id: int, role: str):
    require_admin(role, "관리자 이상만 삭제할 수 있습니다.")
    supabase.table("raid_logs").delete().eq("id", raid_id).execute()
    return {"status": "deleted"}
