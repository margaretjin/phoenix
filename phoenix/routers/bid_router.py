"""아이템 입찰(구매 신청) API

규칙
 1. 우선권자 = 아이템이 드랍된 보스탐(날짜·시간) 참여자. 입찰 등록 시점의 명단을 저장해 둔다.
 2. 시작 시간 ~ (시작 + 우선권 시간) 동안은 우선권자만 입찰 가능.
 3. 우선권 시간 안에 우선권자 입찰이 0명이면, 우선권 시간이 끝나는 순간 자동으로 전체 혈원 입찰로 넘어간다.
    우선권 시간 안에 우선권자가 입찰했으면 자동으로 열리지 않는다 (우선권자끼리).
    관리자는 언제든 '전체 혈원 입찰 열기'로 직접 열 수 있고, 등록할 때 처음부터 전체 혈원 입찰로 만들 수도 있다.
 4. 종료 시간이 지나면 입찰 마감 → 관리자가 입찰자 중 구매자를 확정하면
    해당 보스탐 기록의 아이템이 [피닉스 · 내판 · 수령자 · 가격]으로 반영된다.
    (수령완료일은 아이템을 건넨 사람이 템보유현황에서 직접 지정)
"""
from datetime import timedelta
from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from database import supabase
from routers.raid_router import (
    dropped_text_of, extract_unique_participants, normalize_detail, sync_item_details_from_text
)
from utils import first_or_404, now_utc, parse_ts, require_admin

router = APIRouter(prefix="/api/bids", tags=["Bids"])

STATUS_OPEN = "진행"
STATUS_DONE = "확정"
STATUS_CANCEL = "취소"


class BidCreateRequest(BaseModel):
    raid_id: int
    item_idx: int
    item_name: str
    price: int = 0
    start_at: str                 # ISO 8601 (시간대 포함)
    end_at: str
    priority_hours: float = 12
    open_to_all: bool = False     # True 면 처음부터 전체 혈원 입찰 (우선권 없음)
    memo: Optional[str] = ""
    requester_role: str
    requester_id: str


class BidApplyRequest(BaseModel):
    member_id: str


class BidOpenAllRequest(BaseModel):
    open: bool
    requester_role: str


class BidConfirmRequest(BaseModel):
    winner: str
    requester_role: str


# ---------------------------------------------------------------------------
# 헬퍼
# ---------------------------------------------------------------------------
def _get_bid(bid_id: int) -> dict:
    return first_or_404(supabase.table("item_bids").select("*").eq("id", bid_id).execute(), "입찰을 찾을 수 없습니다.")


def _entries_of(bid_id: int) -> list:
    return supabase.table("item_bid_entries").select("*").eq("bid_id", bid_id).order("created_at").execute().data or []


def _priority_end(bid: dict):
    return parse_ts(bid["start_at"]) + timedelta(hours=float(bid.get("priority_hours") or 0))


def _priority_bid_in_window(bid: dict, entries: list) -> bool:
    """우선권 시간 안에 우선권자가 입찰했는지"""
    p_end = _priority_end(bid)
    return any(e.get("is_priority") and (parse_ts(e.get("created_at")) or p_end) < p_end for e in entries)


def _auto_open(bid: dict, entries: list) -> bool:
    """우선권 시간이 끝났고 그 안에 우선권자 입찰이 없으면 자동으로 전체 혈원 입찰"""
    return now_utc() >= _priority_end(bid) and not _priority_bid_in_window(bid, entries)


def _is_open_to_all(bid: dict, entries: list) -> bool:
    return bool(bid.get("open_to_all")) or _auto_open(bid, entries)


def _raid_item_details(raid: dict) -> list:
    """프론트(extractItemDetails)와 같은 순서의 아이템 목록"""
    if raid.get("dropped_items"):
        return sync_item_details_from_text(raid["dropped_items"], raid.get("item_details") or [])
    return list(raid.get("item_details") or [])


# ---------------------------------------------------------------------------
# 조회
# ---------------------------------------------------------------------------
@router.get("")
def list_bids(status: Optional[str] = None):
    query = supabase.table("item_bids").select("*").order("start_at", desc=True).order("id", desc=True)
    if status:
        query = query.eq("status", status)
    bids = query.execute().data or []
    ids = [b["id"] for b in bids]
    entries = supabase.table("item_bid_entries").select("*").in_("bid_id", ids).order("created_at").execute().data if ids else []
    by_bid = {}
    for e in entries or []:
        by_bid.setdefault(e["bid_id"], []).append(e)
    for b in bids:
        b["entries"] = by_bid.get(b["id"], [])
    return {"server_now": now_utc().isoformat(), "bids": bids}


# ---------------------------------------------------------------------------
# 등록 / 신청
# ---------------------------------------------------------------------------
@router.post("")
def create_bid(req: BidCreateRequest):
    require_admin(req.requester_role, "관리자만 입찰을 등록할 수 있습니다.")
    start_at, end_at = parse_ts(req.start_at), parse_ts(req.end_at)
    if not start_at or not end_at or end_at <= start_at:
        raise HTTPException(status_code=400, detail="종료 시간은 시작 시간보다 뒤여야 합니다.")
    priority_hours = 0 if req.open_to_all else req.priority_hours
    if priority_hours < 0:
        raise HTTPException(status_code=400, detail="우선권 시간은 0 이상이어야 합니다.")
    if start_at + timedelta(hours=priority_hours) > end_at:
        raise HTTPException(status_code=400, detail="우선권 시간이 입찰 종료 시간을 넘어갑니다.")

    raid = first_or_404(supabase.table("raid_logs").select("*").eq("id", req.raid_id).execute(), "보스탐 기록을 찾을 수 없습니다.")
    details = _raid_item_details(raid)
    if req.item_idx < 0 or req.item_idx >= len(details) or details[req.item_idx].get("name") != req.item_name:
        raise HTTPException(status_code=400, detail="아이템 정보가 바뀌었습니다. 새로고침 후 다시 선택해 주세요.")

    dup = (supabase.table("item_bids").select("id").eq("raid_id", req.raid_id)
           .eq("item_idx", req.item_idx).eq("status", STATUS_OPEN).execute())
    if dup.data:
        raise HTTPException(status_code=400, detail="이미 진행 중인 입찰이 있는 아이템입니다.")

    res = supabase.table("item_bids").insert({
        "raid_id": req.raid_id,
        "item_idx": req.item_idx,
        "item_name": req.item_name,
        "raid_date": raid.get("raid_date", ""),
        "raid_time": raid.get("raid_time", ""),
        "price": max(0, int(req.price or 0)),
        "start_at": start_at.isoformat(),
        "end_at": end_at.isoformat(),
        "priority_hours": priority_hours,
        "priority_members": extract_unique_participants(raid.get("parties") or []),
        "open_to_all": bool(req.open_to_all),
        "status": STATUS_OPEN,
        "memo": (req.memo or "").strip(),
        "created_by": req.requester_id
    }).execute()
    return {"status": "created", "data": (res.data or [None])[0]}


@router.post("/{bid_id}/apply")
def apply_bid(bid_id: int, req: BidApplyRequest):
    bid = _get_bid(bid_id)
    member = (req.member_id or "").strip()
    if not member:
        raise HTTPException(status_code=400, detail="아이디가 없습니다.")
    if bid.get("status") != STATUS_OPEN:
        raise HTTPException(status_code=400, detail="진행 중인 입찰이 아닙니다.")

    now = now_utc()
    if now < parse_ts(bid["start_at"]):
        raise HTTPException(status_code=400, detail="아직 입찰 시작 전입니다.")
    if now >= parse_ts(bid["end_at"]):
        raise HTTPException(status_code=400, detail="입찰이 마감되었습니다.")

    is_priority = member in (bid.get("priority_members") or [])
    if not is_priority and not _is_open_to_all(bid, _entries_of(bid_id)):
        raise HTTPException(status_code=403, detail="지금은 해당 보스탐 참여자(우선권자)만 입찰할 수 있습니다.")

    if supabase.table("item_bid_entries").select("id").eq("bid_id", bid_id).eq("member_id", member).execute().data:
        raise HTTPException(status_code=400, detail="이미 입찰했습니다.")

    supabase.table("item_bid_entries").insert({
        "bid_id": bid_id, "member_id": member, "is_priority": is_priority
    }).execute()
    return {"status": "applied"}


@router.delete("/{bid_id}/apply")
def cancel_apply(bid_id: int, member_id: str):
    bid = _get_bid(bid_id)
    if bid.get("status") != STATUS_OPEN or now_utc() >= parse_ts(bid["end_at"]):
        raise HTTPException(status_code=400, detail="마감된 입찰은 입찰을 취소할 수 없습니다.")
    supabase.table("item_bid_entries").delete().eq("bid_id", bid_id).eq("member_id", member_id.strip()).execute()
    return {"status": "cancelled"}


# ---------------------------------------------------------------------------
# 관리자
# ---------------------------------------------------------------------------
@router.post("/{bid_id}/open-all")
def set_open_all(bid_id: int, req: BidOpenAllRequest):
    require_admin(req.requester_role)
    bid = _get_bid(bid_id)
    entries = _entries_of(bid_id)
    if bid.get("status") != STATUS_OPEN or now_utc() >= parse_ts(bid["end_at"]):
        raise HTTPException(status_code=400, detail="마감된 입찰입니다.")
    if not req.open:
        if _auto_open(bid, entries):
            raise HTTPException(status_code=400, detail="우선권 시간이 지나 자동으로 열린 입찰은 닫을 수 없습니다.")
        if any(not e.get("is_priority") for e in entries):
            raise HTTPException(status_code=400, detail="이미 일반 혈원 입찰자가 있어 닫을 수 없습니다.")
    supabase.table("item_bids").update({"open_to_all": bool(req.open)}).eq("id", bid_id).execute()
    return {"status": "updated", "open_to_all": bool(req.open)}


@router.post("/{bid_id}/confirm")
def confirm_bid(bid_id: int, req: BidConfirmRequest):
    require_admin(req.requester_role, "관리자만 구매자를 확정할 수 있습니다.")
    bid = _get_bid(bid_id)
    if bid.get("status") != STATUS_OPEN:
        raise HTTPException(status_code=400, detail="진행 중인 입찰만 확정할 수 있습니다.")
    winner = (req.winner or "").strip()
    if winner not in [e["member_id"] for e in _entries_of(bid_id)]:
        raise HTTPException(status_code=400, detail="입찰자 중에서 구매자를 골라 주세요.")

    # 보스탐 기록의 아이템을 [피닉스 · 내판 · 수령자 · 가격]으로 반영
    raid = first_or_404(supabase.table("raid_logs").select("*").eq("id", bid["raid_id"]).execute(), "보스탐 기록을 찾을 수 없습니다.")
    details = _raid_item_details(raid)
    idx = int(bid["item_idx"])
    if idx >= len(details) or details[idx].get("name") != bid["item_name"]:
        raise HTTPException(status_code=400, detail="보스탐 기록의 아이템 순서가 바뀌어 자동 반영할 수 없습니다. 템보유현황에서 직접 입력해 주세요.")

    details[idx] = normalize_detail({
        **details[idx],
        "alliance": "피닉스",
        "sale_type": "내판",
        "winner": winner,
        "price": int(bid.get("price") or 0)
        # 수령완료일(taken_date)은 아이템을 건넨 사람이 템보유현황에서 직접 지정
    })
    supabase.table("raid_logs").update({
        "item_details": details, "dropped_items": dropped_text_of(details)
    }).eq("id", bid["raid_id"]).execute()

    supabase.table("item_bids").update({"status": STATUS_DONE, "winner": winner}).eq("id", bid_id).execute()
    return {"status": "confirmed", "winner": winner}


@router.post("/{bid_id}/cancel")
def cancel_bid(bid_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("item_bids").update({"status": STATUS_CANCEL}).eq("id", bid_id).execute()
    return {"status": "cancelled"}


@router.delete("/{bid_id}")
def delete_bid(bid_id: int, requester_role: str):
    require_admin(requester_role)
    supabase.table("item_bids").delete().eq("id", bid_id).execute()
    return {"status": "deleted"}
